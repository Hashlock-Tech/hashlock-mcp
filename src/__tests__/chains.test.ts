import { describe, expect, it } from 'vitest';
import { BtcSigner } from '../chains/btc.js';
import { EvmSigner } from '../chains/evm.js';
import { TronSigner } from '../chains/tron.js';
import { familyOf, fundMustWait, feeForLeg } from '../settlement.js';

describe('familyOf', () => {
  it('maps chain names to settlement families', () => {
    expect(familyOf('bitcoin')).toBe('btc');
    expect(familyOf('bitcoin-signet')).toBe('btc');
    expect(familyOf('tron')).toBe('tron');
    expect(familyOf('tron-nile')).toBe('tron');
    expect(familyOf('ethereum')).toBe('evm');
    expect(familyOf('ethereum-sepolia')).toBe('evm');
    expect(familyOf('solana')).toBe('svm');
    expect(familyOf('solana-devnet')).toBe('svm');
  });
});

const HEX_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';

describe('signers derive a stable identity from the key', () => {
  it('EVM: address + login signature', async () => {
    const s = new EvmSigner(HEX_KEY);
    expect(s.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const sig = await s.signLoginMessage('Hashlock Markets\nNonce: abc');
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it('TRON: base58 address from the same key material', () => {
    const s = new TronSigner(HEX_KEY.slice(2));
    expect(s.address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('BTC: WIF → P2WPKH signet address + a BIP-322 signature that round-trips', async () => {
    // deterministic testnet WIF (key = 0x01…01)
    const { default: ECPairFactory } = await import('ecpair');
    const ecc = await import('tiny-secp256k1');
    const bitcoin = await import('bitcoinjs-lib');
    const ECPair = ECPairFactory(ecc);
    const kp = ECPair.fromPrivateKey(Buffer.from(HEX_KEY.slice(2), 'hex'), { network: bitcoin.networks.testnet });
    const wif = kp.toWIF();

    const s = new BtcSigner(wif, 'signet');
    expect(s.address).toMatch(/^tb1q[0-9a-z]+$/);
    const msg = 'Hashlock Markets — sign in.\nNonce: abc';
    const sig = s.signLoginMessage(msg);
    const { Verifier } = await import('bip322-js');
    expect(Verifier.verifySignature(s.address, msg, sig)).toBe(true);
  });
});

/**
 * Signing what the SERVER built, for Bitcoin — on hashes computed here. The key that signs also holds
 * the agent's own coins, so a transaction this side has not reproduced is authority to move them.
 */
describe('BTC: signing a server-built spend', () => {
  const setup = async () => {
    const { default: ECPairFactory } = await import('ecpair');
    const ecc = await import('tiny-secp256k1');
    const bitcoin = await import('bitcoinjs-lib');
    const n = bitcoin.networks.testnet;
    const kp = ECPairFactory(ecc).fromPrivateKey(Buffer.from(HEX_KEY.slice(2), 'hex'), { network: n });
    const signer = new BtcSigner(kp.toWIF(), 'signet');
    // A stand-in for the HTLC: any witness script gives a P2WSH address, which is all the check reads.
    const witnessScript = Buffer.from('51', 'hex'); // OP_TRUE
    const htlc = bitcoin.payments.p2wsh({ redeem: { output: witnessScript, network: n }, network: n });
    const build = (o: { from?: Buffer; to?: string; inputs?: number; outputs?: number } = {}) => {
      const p = new bitcoin.Psbt({ network: n });
      for (let i = 0; i < (o.inputs ?? 1); i++) {
        p.addInput({
          hash: Buffer.alloc(32, i + 1),
          index: 0,
          witnessUtxo: { script: o.from ?? htlc.output!, value: 100_000 },
          witnessScript,
        });
      }
      // What is not paid out goes to a miner, and the signer refuses a transaction that hands over most
      // of the escrow — so the fixture leaves an ordinary fee behind: 1000 sats across the outputs.
      const outs = o.outputs ?? 1;
      const each = Math.floor(((o.inputs ?? 1) * 100_000 - 1_000) / (outs || 1));
      for (let i = 0; i < outs; i++) p.addOutput({ address: o.to ?? signer.address, value: each });
      const tx = bitcoin.Transaction.fromBuffer(p.data.getTransaction());
      const sighashHexes = p.data.inputs.map((_, i) =>
        tx.hashForWitnessV0(i, witnessScript, 100_000, bitcoin.Transaction.SIGHASH_ALL).toString('hex'),
      );
      return { psbtBase64: p.toBase64(), sighashHexes };
    };
    const ask = (over: Record<string, unknown> = {}, b = build()) =>
      signer.signServerSpend({ ...b, spends: htlc.address!, paysTo: [signer.address], network: 'signet', ...over });
    return { signer, htlcAddress: htlc.address!, build, ask, bitcoin, n, kp };
  };

  it('signs one raw 64-byte signature per input when the spend is the agreed one', async () => {
    const { build, ask } = await setup();
    const sigs = ask({}, build({ inputs: 2 }));
    expect(sigs).toHaveLength(2);
    for (const sig of sigs) expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(sigs[0]).not.toBe(sigs[1]);
  });

  it("refuses a sighash that is not the one this transaction produces — the server's word is not the input", async () => {
    const { ask, build } = await setup();
    const b = build();
    // The PSBT can be perfect while the hashes commit to another transaction entirely: that is the
    // attack this catches, and it is why the hashes are recomputed rather than taken.
    const elsewhere = build({ to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' });
    expect(() => ask({ sighashHexes: elsewhere.sighashHexes }, b)).toThrow(/not the one this transaction produces/);
  });

  it('refuses a transaction that spends anything but the HTLC', async () => {
    const { ask, build, bitcoin, n, kp } = await setup();
    const mine = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: n }).output!;
    expect(() => ask({}, build({ from: mine }))).toThrow(/spends something other than/);
  });

  it("refuses a witnessScript that is not the HTLC's, even when the metadata beside it says otherwise", async () => {
    // THE ATTACK: witnessUtxo.script names the real HTLC — metadata no signature covers — while the
    // script that actually enters the digest is the agent's own wallet, over its own UTXO.
    const { signer, htlcAddress, bitcoin, n, kp } = await setup();
    const evil = bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: n }).output!;
    const htlcScript = bitcoin.address.toOutputScript(htlcAddress, n);
    const p = new bitcoin.Psbt({ network: n });
    p.addInput({ hash: Buffer.alloc(32, 9), index: 0, witnessUtxo: { script: htlcScript, value: 100_000 }, witnessScript: evil });
    p.addOutput({ address: signer.address, value: 90_000 });
    const tx = bitcoin.Transaction.fromBuffer(p.data.getTransaction());
    const sighashHexes = [tx.hashForWitnessV0(0, evil, 100_000, bitcoin.Transaction.SIGHASH_ALL).toString('hex')];
    expect(() =>
      signer.signServerSpend({
        psbtBase64: p.toBase64(),
        sighashHexes, // computed honestly from the PSBT, so only the script check stands between us
        spends: htlcAddress,
        paysTo: [signer.address],
        network: 'signet',
      }),
    ).toThrow(/spends something other than/);
  });

  it('refuses a transaction that pays anyone but the agreed addresses', async () => {
    const { ask, build } = await setup();
    expect(() => ask({}, build({ to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }))).toThrow(/nowhere this key can be refunded to/);
  });

  it('refuses a spend that hands most of the escrow to a miner', async () => {
    const { signer, htlcAddress, bitcoin, n } = await setup();
    const witnessScript = Buffer.from('51', 'hex');
    const p = new bitcoin.Psbt({ network: n });
    p.addInput({
      hash: Buffer.alloc(32, 3),
      index: 0,
      witnessUtxo: { script: bitcoin.address.toOutputScript(htlcAddress, n), value: 1_000_000 },
      witnessScript,
    });
    p.addOutput({ address: signer.address, value: 600 }); // the rest — 999 400 sats — to whoever mines it
    const tx = bitcoin.Transaction.fromBuffer(p.data.getTransaction());
    expect(() =>
      signer.signServerSpend({
        psbtBase64: p.toBase64(),
        sighashHexes: [tx.hashForWitnessV0(0, witnessScript, 1_000_000, bitcoin.Transaction.SIGHASH_ALL).toString('hex')],
        spends: htlcAddress,
        paysTo: [signer.address],
        network: 'signet',
      }),
    ).toThrow(/would go to the miner/);
  });

  it('signs a costly but proportionate fee — both halves of the rule have to be exceeded', async () => {
    const { signer, htlcAddress, bitcoin, n } = await setup();
    const witnessScript = Buffer.from('51', 'hex');
    const p = new bitcoin.Psbt({ network: n });
    p.addInput({
      hash: Buffer.alloc(32, 4),
      index: 0,
      witnessUtxo: { script: bitcoin.address.toOutputScript(htlcAddress, n), value: 2_000_000 },
      witnessScript,
    });
    // 110 000 sats of fee: over the 100 000 ceiling, but a twentieth of the sweep — a busy mempool with
    // many inputs, not theft. Both halves have to be exceeded, so this one signs.
    p.addOutput({ address: signer.address, value: 1_890_000 });
    const tx = bitcoin.Transaction.fromBuffer(p.data.getTransaction());
    expect(
      signer.signServerSpend({
        psbtBase64: p.toBase64(),
        sighashHexes: [tx.hashForWitnessV0(0, witnessScript, 2_000_000, bitcoin.Transaction.SIGHASH_ALL).toString('hex')],
        spends: htlcAddress,
        paysTo: [signer.address],
        network: 'signet',
      }),
    ).toHaveLength(1);
  });

  it('signs a small escrow whose ordinary fee is most of it — the other half of the rule', async () => {
    const { signer, htlcAddress, bitcoin, n } = await setup();
    const witnessScript = Buffer.from('51', 'hex');
    const p = new bitcoin.Psbt({ network: n });
    p.addInput({
      hash: Buffer.alloc(32, 5),
      index: 0,
      witnessUtxo: { script: bitcoin.address.toOutputScript(htlcAddress, n), value: 5_000 },
      witnessScript,
    });
    // 600 sats of fee on a 5 000-sat escrow: an eighth of it, and the API's own floor. Under the
    // ceiling, so it signs — refusing here would strand a small refund over an ordinary fee.
    p.addOutput({ address: signer.address, value: 4_400 });
    const tx = bitcoin.Transaction.fromBuffer(p.data.getTransaction());
    expect(
      signer.signServerSpend({
        psbtBase64: p.toBase64(),
        sighashHexes: [tx.hashForWitnessV0(0, witnessScript, 5_000, bitcoin.Transaction.SIGHASH_ALL).toString('hex')],
        spends: htlcAddress,
        paysTo: [signer.address],
        network: 'signet',
      }),
    ).toHaveLength(1);
  });

  it('signs a hash the agent’s own key verifies against — the signature is over what was checked', async () => {
    const { signer, build, ask, bitcoin, kp } = await setup();
    const b = build();
    const sig = ask({}, b)[0]!;
    const digest = Buffer.from(b.sighashHexes[0]!, 'hex');
    expect(bitcoin.script.signature.encode(Buffer.from(sig, 'hex'), bitcoin.Transaction.SIGHASH_ALL).length).toBeGreaterThan(64);
    expect(kp.verify(digest, Buffer.from(sig, 'hex'))).toBe(true);
  });

  it('refuses a count that does not match, and a transaction with no outputs', async () => {
    const { ask, build } = await setup();
    const two = build({ inputs: 2 });
    expect(() => ask({ sighashHexes: [two.sighashHexes[0]!] }, two)).toThrow(/1 sighash\(es\) for a transaction with 2/);
    expect(() => ask({}, build({ outputs: 0 }))).toThrow(/no outputs/);
  });

});

// The agent signs its own funding, so this is the only gate that ever sees it: the short leg must wait
// for the initiator's, or the initiator can claim it with nothing of theirs locked.
describe('fundMustWait', () => {
  const swap = (initiatorUserId: string, status: string) => ({ initiatorUserId, makerId: 'maker', status });

  it('lets the initiator fund at once and holds the other side until then', () => {
    expect(fundMustWait(swap('maker', 'agreed'), 'a')).toBe(false);
    expect(fundMustWait(swap('maker', 'agreed'), 'b')).toBe(true);
    expect(fundMustWait(swap('maker', 'initiator_funded'), 'b')).toBe(false);
  });

  it('follows the initiator, not the leg letter', () => {
    expect(fundMustWait(swap('taker', 'agreed'), 'b')).toBe(false);
    expect(fundMustWait(swap('taker', 'agreed'), 'a')).toBe(true);
  });
});

describe('feeForLeg — the same rule as the API', () => {
  it('charges the leg whose asset is the fee asset, whoever funds it, and no other leg', () => {
    const swap = { feeAssetId: 'usdt', feeAmount: '300' };
    expect(feeForLeg(swap, 'usdt')).toBe(300n);
    expect(feeForLeg(swap, 'btc')).toBe(0n);
    expect(feeForLeg({ feeAssetId: 'usdt', feeAmount: '' }, 'usdt')).toBe(0n);
  });
});
