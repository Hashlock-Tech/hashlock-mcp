import { Signer as Bip322Signer } from 'bip322-js';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory, type ECPairInterface } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import type { OnchainEscrow } from '../settlement.js';

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
  status: { confirmed: boolean; block_height?: number };
}

async function esploraUtxos(base: string, address: string): Promise<Utxo[]> {
  const res = await fetch(`${base.replace(/\/$/, '')}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`esplora utxo ${res.status}`);
  return (await res.json()) as Utxo[];
}
type Stats = { funded_txo_sum: number; spent_txo_sum: number };
/** Esplora's GET /address: what was paid in and spent out, confirmed and in the mempool. */
export async function esploraAddressStats(base: string, address: string): Promise<{ chain_stats: Stats; mempool_stats: Stats }> {
  const res = await fetch(`${base.replace(/\/$/, '')}/address/${address}`);
  if (!res.ok) throw new Error(`esplora address ${res.status}`);
  return (await res.json()) as { chain_stats: Stats; mempool_stats: Stats };
}
async function esploraBroadcast(base: string, rawHex: string): Promise<string> {
  const res = await fetch(`${base.replace(/\/$/, '')}/tx`, { method: 'POST', body: rawHex });
  const text = await res.text();
  if (!res.ok) throw new Error(`broadcast failed: ${text.slice(0, 200)}`);
  return text.trim(); // txid
}

/**
 * THE INITIATOR'S BITCOIN ESCROW, CHECKED HERE (tester 3.4). The API's redeem script must be byte for
 * byte the HTLC the agreed terms produce — the API's own buildHTLCScript layout, with this agent's key on
 * the claim branch — and its P2WSH must be the address the API names; then what counts is the coin the
 * chain shows confirmed there, read through `esplora` (local, not the API's). The sender key on the
 * refund branch is taken from the script: it decides only who may refund.
 */
export async function readBtcEscrow(
  esplora: string,
  network: string,
  p: { htlcAddress: string; redeemScript: string; hashlockHex: string; receivers: string[]; timelockUnix: number; confirmations: number },
): Promise<OnchainEscrow> {
  const redeem = Buffer.from(p.redeemScript.replace(/^0x/i, ''), 'hex');
  const sender = redeem.subarray(redeem.length - 35, redeem.length - 2);
  // The script must be the agreed HTLC with one of the agent's keys on its claim branch.
  const receiver = p.receivers.find((r) => {
    try {
      return htlcScript(p.hashlockHex, r, sender, p.timelockUnix).equals(redeem);
    } catch {
      return false; // not a key at all
    }
  });
  if (!receiver) {
    throw new Error(
      "the API's redeem script is not the HTLC these terms produce, paying your key or an address you set with set_settlement_address — a deal agreed before this release, or an address set elsewhere, is settled in the web app",
    );
  }
  const n = net(network);
  const address = bitcoin.payments.p2wsh({ redeem: { output: redeem, network: n }, network: n }).address;
  if (address !== p.htlcAddress) throw new Error(`the redeem script hashes to ${address}, not the escrow address ${p.htlcAddress} the API named`);
  const base = esplora.replace(/\/$/, '');
  const { chain_stats: c, mempool_stats: m } = await esploraAddressStats(base, address);
  const spent = c.spent_txo_sum + m.spent_txo_sum > 0; // claimed or refunded (or being)
  // Only coin buried `confirmations` deep counts — the API's own depth for the network: a shallower one
  // can be reorged or double-spent away after the agent has funded against it.
  const tipRes = await fetch(`${base}/blocks/tip/height`);
  if (!tipRes.ok) throw new Error(`esplora tip ${tipRes.status}`);
  const tip = Number(await tipRes.text());
  const utxos = await esploraUtxos(base, address);
  const deep = utxos
    .filter((u) => u.status.confirmed && u.status.block_height !== undefined && tip - u.status.block_height + 1 >= p.confirmations)
    .reduce((a, u) => a + BigInt(u.value), 0n);
  const all = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
  if (!spent && deep < all) {
    throw new Error(`the Bitcoin escrow ${address} has coin with fewer than ${p.confirmations} confirmation(s) — wait and call again`);
  }
  return {
    hashlock: p.hashlockHex.toLowerCase(),
    recipient: receiver,
    token: null,
    amount: deep,
    timelock: p.timelockUnix,
    open: !spent,
  };
}

/** The API's buildHTLCScript (task #62 layout, with the 32-byte preimage size check). */
export function htlcScript(hashlockHex: string, receiverPubkeyHex: string, sender: Buffer, timelockUnix: number): Buffer {
  const o = bitcoin.opcodes;
  return bitcoin.script.compile([
    o.OP_IF, o.OP_SIZE, Buffer.from([32]), o.OP_EQUALVERIFY,
    o.OP_SHA256, Buffer.from(hashlockHex.replace(/^0x/i, ''), 'hex'), o.OP_EQUALVERIFY,
    Buffer.from(receiverPubkeyHex, 'hex'), o.OP_CHECKSIG,
    o.OP_ELSE,
    bitcoin.script.number.encode(timelockUnix), o.OP_CHECKLOCKTIMEVERIFY, o.OP_DROP,
    sender, o.OP_CHECKSIG,
    o.OP_ENDIF,
  ]);
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
          `refusing to sign: output ${i} does not pay ${p.paysTo.join(' or ')} — either the escrow's script names a key this agent does not sign with (a payout set from another wallet with set_settlement_address, or a leg that is not this agent's), or the build is not the one it asked for`,
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
      const said = Buffer.from(p.sighashHexes[i]!.replace(/^0x/i, ''), 'hex');
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
}
