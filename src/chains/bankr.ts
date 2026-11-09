import { parseTransaction, recoverTransactionAddress, serializeTransaction, type Address, type Hex, type TransactionSerializable } from 'viem';
import { toAccount, type LocalAccount } from 'viem/accounts';

/**
 * AN EVM ACCOUNT WHOSE KEY LIVES IN BANKR. A Bankr wallet has no key to export, so an agent on one could
 * not run this server and had to re-implement its settlement checks by hand from a recipe — and every
 * copy of them was weaker than the original. Here Bankr is only what a private key is to the other
 * account: the thing that produces a signature. The server still builds every transaction itself from
 * the deal it recorded, prices and numbers it against its own RPC, and broadcasts it there; Bankr's
 * Wallet API (POST /wallet/sign) is asked to sign it and nothing else.
 *
 * A signature that comes from somewhere else is checked before it is used: what Bankr signed must be,
 * byte for byte, the transaction that was built here — as it would be had a local key signed it — and
 * the signature must be this wallet's. So nothing this server did not build is ever broadcast, whatever
 * the API on the other end answers. There is no tolerance in that on purpose: a "same call, about the
 * same fee" rule has to say which differences are harmless, and a lower gas limit or a re-priced fee is
 * a transaction that reverts or never mines.
 */
const BANKR_API = 'https://api.bankr.bot';

async function bankr<T>(apiKey: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BANKR_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-API-Key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
    redirect: 'error', // the key goes to api.bankr.bot and nowhere a redirect points
  }).catch((e: unknown) => {
    throw new Error(`Bankr ${path}: could not be reached (${(e as Error).message})`);
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; error?: unknown; message?: unknown } | null;
  if (!res.ok || !json || json.success === false) {
    // Bankr's refusals name their own fix ("Arbitrary contract calls disabled", "Wallet paused", …). A
    // validation error is an object ({ type, message, errors }), e.g. for a chain Bankr does not sign for.
    const say = (v: unknown) => (typeof v === 'string' ? v : v ? JSON.stringify(v) : '');
    throw new Error(`Bankr ${path}: ${[say(json?.error), say(json?.message)].filter(Boolean).join(' — ') || `HTTP ${res.status}`}`);
  }
  return json as T;
}

/** POST /wallet/sign; the signature, or an error when the answer carries none. */
async function sign(apiKey: string, body: object): Promise<Hex> {
  const { signature } = await bankr<{ signature?: unknown }>(apiKey, '/wallet/sign', body);
  if (typeof signature !== 'string' || !signature.startsWith('0x')) throw new Error('Bankr /wallet/sign answered without a signature');
  return signature as Hex;
}

const FIELDS = ['type', 'chainId', 'nonce', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice', 'to', 'value', 'data'] as const;

/**
 * How `signed` is not the transaction `asked` for, or null when it is exactly that. The test is on the
 * bytes a key signs (the unsigned serialization); the field names are only for the message.
 */
export function differsFrom(asked: TransactionSerializable, signed: TransactionSerializable): string | null {
  const { r: _r, s: _s, v: _v, yParity: _y, ...body } = signed as TransactionSerializable & Record<string, unknown>;
  let bytes: string;
  try {
    bytes = serializeTransaction(body as TransactionSerializable);
  } catch (e) {
    return `not a valid transaction: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`; // e.g. a tip above the fee cap
  }
  if (bytes === serializeTransaction(asked)) return null;
  const val = (t: Record<string, unknown>, f: string) => String(t[f] ?? (f === 'data' ? '0x' : f === 'value' ? 0n : '')).toLowerCase();
  const off = FIELDS.filter((f) => val(asked as never, f) !== val(body, f)).map((f) => `${f} ${val(body, f) || 'unset'}`);
  return off.join(', ') || 'its encoding';
}

export async function bankrAccount(apiKey: string): Promise<LocalAccount> {
  const me = await bankr<{ wallets?: { chain: string; address: string }[] }>(apiKey, '/wallet/me');
  const address = me.wallets?.find((w) => w.chain === 'evm')?.address as Address | undefined;
  if (!address) throw new Error('Bankr /wallet/me: this key has no EVM wallet');

  return toAccount({
    address,
    async signMessage({ message }) {
      if (typeof message !== 'string') throw new Error('a Bankr wallet signs text messages only');
      return sign(apiKey, { signatureType: 'personal_sign', message });
    },
    async signTransaction(tx) {
      const fee = tx.maxFeePerGas ?? tx.gasPrice;
      if (!tx.to || tx.chainId === undefined || tx.nonce === undefined || tx.gas === undefined || fee === undefined) {
        throw new Error('a Bankr wallet signs only a prepared call: to, chain id, nonce, gas and fee');
      }
      const signature = await sign(apiKey, {
        signatureType: 'eth_signTransaction',
        transaction: {
          to: tx.to,
          chainId: tx.chainId,
          value: (tx.value ?? 0n).toString(),
          data: tx.data ?? '0x',
          gas: tx.gas.toString(),
          nonce: tx.nonce,
          ...(tx.maxFeePerGas !== undefined
            ? { maxFeePerGas: tx.maxFeePerGas.toString(), maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 0n).toString() }
            : { gasPrice: fee.toString() }),
        },
      });
      let signed: TransactionSerializable;
      let from: Address;
      try {
        signed = parseTransaction(signature as never) as TransactionSerializable;
        from = await recoverTransactionAddress({ serializedTransaction: signature as never });
      } catch {
        throw new Error('Bankr /wallet/sign did not answer with a signed transaction — nothing was sent');
      }
      if (from.toLowerCase() !== address.toLowerCase()) throw new Error(`Bankr signed as ${from}, not as this wallet (${address}) — nothing was sent`);
      const diff = differsFrom(tx, signed);
      if (diff) throw new Error(`Bankr signed a different transaction than the one built here (${diff}) — nothing was sent`);
      return signature as never;
    },
    async signTypedData() {
      throw new Error('typed data is not signed by this server');
    },
  });
}
