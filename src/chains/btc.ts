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
