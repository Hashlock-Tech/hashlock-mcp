import type { Address, Hex } from 'viem';
import type { SendingWallet } from './evm.js';

/**
 * AN EVM WALLET WHOSE KEY LIVES IN BANKR. A Bankr wallet has no key to export, so an agent on one could
 * not run this server and had to re-implement its settlement checks by hand from a recipe — and every
 * copy of them was weaker than the original. Here the Bankr wallet is what a browser wallet is to a web
 * app: a wallet that sends its own transactions. This server still decides everything about a
 * transaction — which contract, which calldata, how much value, from the deal it recorded — checks on
 * its own RPC that the call would go through, and follows it there once it is sent (EvmSigner.send).
 * Bankr's Wallet API is handed that exact call to sign and broadcast (POST /wallet/submit), and signs the
 * login message (POST /wallet/sign).
 *
 * It is /wallet/submit and not a signature because Bankr does not sign a raw transaction: /wallet/sign
 * with eth_signTransaction answers "signTransaction: not supported — raw EVM transaction signing bypasses
 * the signer's policy gate" (observed 2026-11-10, against its own OpenAPI). So the wallet's security
 * settings and spending limits apply to everything sent here, and what goes on chain is Bankr's to send:
 * this server trusts it to send the call it was given, as anyone keeping funds in a Bankr wallet does.
 */
const BANKR_API = 'https://api.bankr.bot';

interface Answer {
  /** 0 when Bankr could not be reached at all. */
  status: number;
  /** null when the answer was not JSON (a gateway page, a body cut short). */
  json: { success?: boolean; error?: unknown; message?: unknown; [k: string]: unknown } | null;
  /** Why not, in Bankr's own words where it gave any. */
  why: string;
}

async function ask(apiKey: string, path: string, body?: unknown): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(`${BANKR_API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-API-Key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      redirect: 'error', // the key goes to api.bankr.bot and nowhere a redirect points
    });
  } catch (e) {
    return { status: 0, json: null, why: `could not be reached (${(e as Error).message})` };
  }
  const json = (await res.json().catch(() => null)) as Answer['json'];
  // Bankr's refusals name their own fix ("Arbitrary contract calls disabled", "Wallet paused", …). A
  // validation error is an object ({ type, message, errors }), e.g. for a chain Bankr does not send on.
  const say = (v: unknown) => (typeof v === 'string' ? v : v ? JSON.stringify(v) : '');
  return { status: res.status, json, why: [say(json?.error), say(json?.message)].filter(Boolean).join(' — ') || `HTTP ${res.status}` };
}

const refused = (a: Answer) => !a.json || a.status < 200 || a.status >= 300 || a.json.success === false;

export async function bankrWallet(apiKey: string): Promise<SendingWallet> {
  const me = await ask(apiKey, '/wallet/me');
  if (refused(me)) throw new Error(`Bankr /wallet/me: ${me.why}`);
  const address = (me.json!.wallets as { chain: string; address: string }[] | undefined)?.find((w) => w.chain === 'evm')?.address as Address | undefined;
  if (!address) throw new Error('Bankr /wallet/me: this key has no EVM wallet');

  return {
    address,
    async signMessage(message) {
      const a = await ask(apiKey, '/wallet/sign', { signatureType: 'personal_sign', message });
      if (refused(a)) throw new Error(`Bankr /wallet/sign: ${a.why}`);
      const signature = a.json!.signature;
      if (typeof signature !== 'string' || !signature.startsWith('0x')) throw new Error('Bankr /wallet/sign answered without a signature');
      return signature as Hex;
    },
    async send(chainId, call) {
      const a = await ask(apiKey, '/wallet/submit', {
        // The gas limit is this server's own estimate, so Bankr's node does not have to have seen the
        // transaction this one depends on (the approve before a createSwap).
        transaction: { to: call.to, chainId, data: call.data, value: call.value.toString(), gas: call.gas.toString() },
        description: 'Hashlock HTLC settlement',
        // Do not wait at Bankr: the receipt is read from this server's RPC, the view everything else here is checked against.
        waitForConfirmation: false,
      });
      // Bankr's rule: an answer that carries a transaction hash WAS broadcast, failure or not. The chain says what became of it.
      const hash = a.json?.transactionHash;
      if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash as Hex;
      // What to tell the agent. Bankr rejects before it signs for the key (401), its security settings and
      // limits (403, "rejected before anything is broadcast"), its rate limit (429), a request it could not
      // parse (400 with a validation object, e.g. a chain it does not send on) and a wallet short of gas
      // (400 insufficient_funds_for_gas). For anything else — a "submission failed" without a hash, no
      // answer, a gateway error — it only promises that a hash means it WAS sent, and this endpoint takes
      // no idempotency key.
      const e = a.json?.error;
      const before = a.json && (a.status === 401 || a.status === 403 || a.status === 429 || (a.status === 400 && ((typeof e === 'object' && e !== null) || e === 'insufficient_funds_for_gas')));
      throw new Error(`Bankr /wallet/submit: ${a.why}${before ? '' : ' — the transaction may or may not have been sent; check the swap before retrying'}`);
    },
  };
}
