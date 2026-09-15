import { Signer as Bip322Signer } from 'bip322-js';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory, type ECPairInterface } from 'ecpair';
import * as ecc from 'tiny-secp256k1';

/**
 * Bitcoin signing + P2WSH HTLC settlement for the autonomous agent (bitcoinjs-lib, headless). The
 * agent's WIF key authenticates (BIP-322) and signs BTC HTLC claims; its P2WPKH address is the
 * agent's BTC identity. Esplora base + network come from the API's GET /config.
 */
bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

/**
 * The most a server-built spend may leave for a miner before this side refuses it, unless it is under a
 * tenth of what is being swept — a floor, so a dust-sized escrow whose fee really is most of it still
 * settles. Both halves have to be exceeded to refuse.
 *
 * The number is the API's OWN ceiling (its prepareBtcSpend clamps the fee to 100 000 sats), not a
 * tighter guess: a lower one here would refuse a legitimate refund of a small escrow swept from many
 * UTXOs in a busy mempool — which is exactly when an agent needs its money back.
 */
const MAX_MINER_FEE_SATS = 100_000n;

function net(network: string): bitcoin.networks.Network {
  // Signet + testnet share the same address params in bitcoinjs-lib (tb1… bech32).
  return network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

async function esploraUtxos(base: string, address: string): Promise<Utxo[]> {
  const res = await fetch(`${base.replace(/\/$/, '')}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`esplora utxo ${res.status}`);
  return (await res.json()) as Utxo[];
}
async function esploraBroadcast(base: string, rawHex: string): Promise<string> {
  const res = await fetch(`${base.replace(/\/$/, '')}/tx`, { method: 'POST', body: rawHex });
  const text = await res.text();
  if (!res.ok) throw new Error(`broadcast failed: ${text.slice(0, 200)}`);
  return text.trim(); // txid
}

export interface BtcChain {
  network: string;
  esplora: string;
  treasury?: string | null;
}

export class BtcSigner {
  readonly keyPair: ECPairInterface;
  readonly address: string;
  readonly pubkeyHex: string;
  private readonly wif: string;

  constructor(wif: string, network: string) {
    const n = net(network);
    this.wif = wif;
    this.keyPair = ECPair.fromWIF(wif, n);
    const { address } = bitcoin.payments.p2wpkh({ pubkey: this.keyPair.publicKey, network: n });
    if (!address) throw new Error('could not derive BTC address from key');
    this.address = address;
    this.pubkeyHex = Buffer.from(this.keyPair.publicKey).toString('hex');
  }

  /**
   * Sign a spend the SERVER built — but on hashes computed HERE, from the PSBT it sent.
   *
   * The key that signs is the same one holding the agent's own coins, so signing 32 bytes on a server's
   * word is authority to move them: a wrong HASHLOCK_API_URL could answer with a perfectly good HTLC
   * PSBT and sighashes over a different transaction entirely — one spending the agent's wallet. So the
   * PSBT is the only input that counts. Every sighash is recomputed from it (the same BIP-143 digest
   * the API produces), and the server's own list is compared rather than trusted: a disagreement means
   * we are not looking at the same transaction, and nothing is signed.
   *
   * What the transaction may be is bounded before that: it spends the HTLC this leg was funded at, and
   * pays an address this side already knows. The witness itself is still the API's to assemble — that
   * is script knowledge, and a second copy of it here is the copy that gets it wrong.
   */
  signServerSpend(p: {
    psbtBase64: string;
    sighashHexes: string[];
    spends: string;
    paysTo: string[];
    network: string;
  }): string[] {
    const n = net(p.network);
    const psbt = bitcoin.Psbt.fromBase64(p.psbtBase64, { network: n });
    const inputs = psbt.data.inputs;
    if (inputs.length !== p.sighashHexes.length) {
      throw new Error(`the API sent ${p.sighashHexes.length} sighash(es) for a transaction with ${inputs.length} input(s)`);
    }
    if (inputs.length === 0) throw new Error('the API sent a transaction with no inputs');
    // A transaction with no outputs pays the whole escrow to miners, and every "each output pays…"
    // rule below would pass over an empty list.
    if (psbt.txOutputs.length === 0) throw new Error('refusing to sign: this transaction has no outputs');

    const wantIn = bitcoin.address.toOutputScript(p.spends, n);
    const wantOut = p.paysTo.map((a) => bitcoin.address.toOutputScript(a, n));
    psbt.txOutputs.forEach((o, i) => {
      if (!wantOut.some((w) => o.script.equals(w))) {
        throw new Error(
          `refusing to sign: output ${i} pays ${p.paysTo.join(' or ')} — nowhere this key can be refunded to, so either this leg is not this agent's to refund, or the build is not the one it asked for`,
        );
      }
    });
    // AND HOW MUCH OF IT SURVIVES. Bounding the scripts alone leaves the amounts free, and what is not
    // paid out is paid to a miner: a server that sets the single output to dust hands the escrow to
    // whoever mines it. The inputs' own values are the server's too, but lying about them only makes
    // the signature invalid, so they are a fair basis for the ratio.
    const sweeping = inputs.reduce((n2, i2) => n2 + BigInt(i2.witnessUtxo?.value ?? 0), 0n);
    const paying = psbt.txOutputs.reduce((n2, o) => n2 + BigInt(o.value), 0n);
    const fee = sweeping - paying;
    if (fee < 0n) throw new Error('refusing to sign: this transaction pays out more than it spends');
    if (fee > MAX_MINER_FEE_SATS && fee * 10n > sweeping) {
      throw new Error(`refusing to sign: ${fee} sat(s) of ${sweeping} would go to the miner, not to you`);
    }

    const tx = bitcoin.Transaction.fromBuffer(psbt.data.getTransaction());
    return inputs.map((input, i) => {
      const utxo = input.witnessUtxo;
      const witnessScript = input.witnessScript;
      if (!utxo || !witnessScript) throw new Error(`input ${i} carries no witnessUtxo/witnessScript — this transaction cannot be checked`);
      // THE SCRIPT THAT ENTERS THE DIGEST, not the one beside it. `witnessUtxo.script` is metadata the
      // sender chose and the signature never covers; `witnessScript` is what hashForWitnessV0 hashes.
      // Checking only the former let a PSBT name the real HTLC there while the digest committed to the
      // agent's OWN wallet script over its own UTXO — a valid signature, spending its coins.
      const spendsHtlc = bitcoin.payments.p2wsh({ redeem: { output: witnessScript, network: n }, network: n }).output;
      if (!spendsHtlc?.equals(wantIn) || !utxo.script.equals(wantIn)) {
        throw new Error(`refusing to sign: input ${i} spends something other than ${p.spends}`);
      }
      const mine = tx.hashForWitnessV0(i, witnessScript, utxo.value, bitcoin.Transaction.SIGHASH_ALL);
      const said = Buffer.from(p.sighashHexes[i]!.replace(/^0x/, ''), 'hex');
      if (!mine.equals(said)) {
        throw new Error(`refusing to sign: the API's sighash for input ${i} is not the one this transaction produces`);
      }
      return Buffer.from(this.keyPair.sign(mine)).toString('hex');
    });
  }

  /** BIP-322 message signature (for /auth/btc/verify). */
  signLoginMessage(message: string): string {
    return Bip322Signer.sign(this.wif, this.address, message).toString();
  }

  /** Fund the HTLC by paying its P2WSH address (+ optional fee to treasury), change back to us. */
  async fund(
    chain: BtcChain,
    p: { p2wsh: string; amountSats: bigint; feeSats: bigint; feeRate?: number },
  ): Promise<string> {
    const n = net(chain.network);
    const utxos = (await esploraUtxos(chain.esplora, this.address)).filter((u) => u.status.confirmed);
    const feeRate = p.feeRate ?? 2;
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: this.keyPair.publicKey, network: n });
    const inScript = p2wpkh.output!;

    const psbt = new bitcoin.Psbt({ network: n });
    let inValue = 0n;
    const need = p.amountSats + p.feeSats;
    const picked: Utxo[] = [];
    for (const u of utxos) {
      psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: inScript, value: u.value } });
      picked.push(u);
      inValue += BigInt(u.value);
      // rough size: 68 vB/input + 43/output * 3 + 11 overhead
      const estFee = BigInt(Math.ceil((picked.length * 68 + 3 * 43 + 11) * feeRate));
      if (inValue >= need + estFee) break;
    }
    const estFee = BigInt(Math.ceil((picked.length * 68 + 3 * 43 + 11) * feeRate));
    if (inValue < need + estFee) throw new Error(`insufficient confirmed BTC: have ${inValue}, need ${need + estFee} sats`);

    psbt.addOutput({ address: p.p2wsh, value: Number(p.amountSats) });
    if (p.feeSats > 0n) {
      if (!chain.treasury) throw new Error('protocol fee due but no BTC treasury configured');
      psbt.addOutput({ address: chain.treasury, value: Number(p.feeSats) });
    }
    const change = inValue - need - estFee;
    if (change > 330n) psbt.addOutput({ address: this.address, value: Number(change) });

    picked.forEach((_u, i) => psbt.signInput(i, this.keyPair));
    psbt.finalizeAllInputs();
    return esploraBroadcast(chain.esplora, psbt.extractTransaction().toHex());
  }

  /**
   * Claim the HTLC P2WSH with the preimage. Witness = [sig, preimage, 0x01 (take the IF branch),
   * redeemScript]. We sign input 0 with our key (must be the receiver pubkey embedded in the script).
   */
  async claim(
    chain: BtcChain,
    p: { p2wsh: string; redeemHex: string; preimageHex: string; toAddress?: string; feeSats?: number },
  ): Promise<string> {
    const n = net(chain.network);
    const redeem = Buffer.from(p.redeemHex, 'hex');
    const preimage = Buffer.from(p.preimageHex.replace(/^0x/, ''), 'hex');
    const fee = p.feeSats ?? 600;
    const to = p.toAddress ?? this.address;

    const utxos = await esploraUtxos(chain.esplora, p.p2wsh);
    const u = utxos.find((x) => x.status.confirmed) ?? utxos[0];
    if (!u) throw new Error('no UTXO at the HTLC address yet (funding unconfirmed?)');

    const witnessScript = redeem;
    const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: redeem, network: n }, network: n });
    const psbt = new bitcoin.Psbt({ network: n });
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: { script: p2wsh.output!, value: u.value },
      witnessScript,
    });
    psbt.addOutput({ address: to, value: u.value - fee });
    psbt.signInput(0, this.keyPair);

    psbt.finalizeInput(0, (_idx: number, input: { partialSig?: { signature: Buffer }[] }) => {
      const sig = input.partialSig![0]!.signature;
      const witness = witnessStack([sig, preimage, Buffer.from([0x01]), redeem]);
      return { finalScriptWitness: witness };
    });
    return esploraBroadcast(chain.esplora, psbt.extractTransaction().toHex());
  }
}

/** Serialize a witness stack (count + [len|item]…) for finalScriptWitness. */
function witnessStack(items: Buffer[]): Buffer {
  const parts: Buffer[] = [varint(items.length)];
  for (const it of items) {
    parts.push(varint(it.length), it);
  }
  return Buffer.concat(parts);
}
function varint(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
}
