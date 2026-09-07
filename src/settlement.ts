import type { Asset, HashlockClient, Swap } from './client.js';
import type { SecretStore } from './secrets.js';

/**
 * Autonomous HTLC settlement: works out which leg the agent must FUND (the one it gives) and which it
 * CLAIMS (the one it receives), then signs + submits the on-chain tx with the agent's own key. Leg A =
 * "maker gives" → maker funds A / taker claims A; leg B = "maker wants" → taker funds B / maker claims B.
 */
type Leg = 'a' | 'b';
export type Family = 'evm' | 'tron' | 'btc' | 'svm';

export function familyOf(chain: string): Family {
  const c = chain.toLowerCase();
  if (c.includes('bitcoin') || c === 'btc') return 'btc';
  if (c.includes('tron')) return 'tron';
  if (c.includes('solana') || c === 'sol') return 'svm';
  return 'evm';
}

/**
 * A Solana leg, settled by SIGNING WHAT THE SERVER BUILT. The other three families assemble their own
 * transaction here, because each is a call this package can express in a few lines. Solana is not: its
 * escrow ADDRESS is a hash of the agreed terms, so composing an instruction means carrying the
 * program's IDL, a Borsh coder and the exact byte layout of that hash — a second implementation of
 * something already verified on devnet, and one that fails by funding an address nobody watches rather
 * than by throwing. The server already answers with the transaction; the agent only signs it.
 */
async function settleSolanaLeg(
  api: HashlockClient,
  swapId: string,
  leg: Leg,
  action: 'fund' | 'claim' | 'refund',
  body: Record<string, unknown> = {},
): Promise<string> {
  const built = await api.buildLeg(swapId, leg, action, body);
  const signed = api.solanaSigner().signTransaction(built.transactionBase64);
  try {
    return (await api.broadcastSigned('solana', signed)).txid;
  } catch (e) {
    // A blockhash is good for about ninety seconds. An agent that paused between building and signing
    // gets an RPC error naming the blockhash, which reads as a broken transaction rather than a stale
    // one — and the fix is simply to call again, since buildLeg fetches a fresh one.
    if (/blockhash|block height exceeded/i.test((e as Error).message)) {
      throw new Error('this transaction expired before it was broadcast — call again to build and sign a fresh one');
    }
    throw e;
  }
}

interface LegView {
  leg: Leg;
  chain: string;
  assetId: string;
  amount: string;
  timelockUnix: number;
  payout: string | null;
  refund: string | null;
  htlcAddress: string | null;
  redeemScript: string | null;
  fundTx: string | null;
  claimTx: string | null;
}

function legView(swap: Swap, leg: Leg): LegView {
  const p = leg === 'a';
  return {
    leg,
    chain: p ? swap.aChain : swap.bChain,
    assetId: p ? swap.aAssetId : swap.bAssetId,
    amount: p ? swap.aAmount : swap.bAmount,
    timelockUnix: Math.floor(Date.parse(p ? swap.aTimelock : swap.bTimelock) / 1000),
    payout: p ? swap.aPayoutAddress : swap.bPayoutAddress,
    refund: p ? swap.aRefundAddress : swap.bRefundAddress,
    htlcAddress: p ? swap.aHtlcAddress : swap.bHtlcAddress,
    redeemScript: p ? swap.aRedeemScript : swap.bRedeemScript,
    fundTx: p ? swap.aFundTx : swap.bFundTx,
    claimTx: p ? swap.aClaimTx : swap.bClaimTx,
  };
}

async function role(api: HashlockClient, swap: Swap): Promise<'maker' | 'taker'> {
  const me = (await api.me()).user;
  if (!me) throw new Error('not authenticated');
  if (me.id === swap.makerId) return 'maker';
  if (me.id === swap.takerId) return 'taker';
  throw new Error('you are not a party to this swap');
}

function feeForLeg(swap: Swap, assetId: string, meIsFeePayer: boolean): bigint {
  return meIsFeePayer && swap.feeAssetId === assetId ? BigInt(swap.feeAmount || '0') : 0n;
}

/** Fund the leg the agent gives. Returns the on-chain tx id. */
export async function fundMyLeg(api: HashlockClient, swap: Swap, assets: Asset[]): Promise<{ tx: string; leg: Leg; chain: string }> {
  const r = await role(api, swap);
  const view = legView(swap, r === 'maker' ? 'a' : 'b');
  if (view.fundTx) throw new Error(`your ${view.chain} leg is already funded (${view.fundTx})`);
  if (!view.payout) throw new Error('the counterparty has not set their receive address yet — cannot fund');
  const me = (await api.me()).user!;
  const fee = feeForLeg(swap, view.assetId, swap.feePayerId === me.id);
  const asset = assets.find((a) => a.id === view.assetId);
  const hashlockHex = swap.hashlock.replace(/^0x/, '');
  const fam = familyOf(view.chain);

  if (fam === 'evm') {
    if (!view.refund) throw new Error('set your refund address first');
    const tx = await api.evmSigner().fund(await api.evmChain(), {
      swapId: swap.id,
      hashlockHex,
      recipient: view.payout as `0x${string}`,
      refund: view.refund as `0x${string}`,
      token: (asset?.address ?? null) as `0x${string}` | null,
      amount: BigInt(view.amount),
      timelockUnix: view.timelockUnix,
      fee,
    });
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'tron') {
    if (!asset?.address) throw new Error('TRON leg asset has no token address');
    const tx = await api.tronSigner().fund(await api.tronChain(), {
      swapId: swap.id,
      recipient: view.payout,
      amount: view.amount,
      hashlockHex,
      timelockUnix: view.timelockUnix,
      token: asset.address,
      fee: fee.toString(),
    });
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'svm') {
    // The escrow address IS the agreed terms on this rail, so the server derives it from BOTH parties'
    // settlement addresses and refuses without them. `view.payout` is checked above; this is the other.
    if (!view.refund) throw new Error('set your refund address first');
    const tx = await settleSolanaLeg(api, swap.id, view.leg, 'fund');
    return { tx, leg: view.leg, chain: view.chain };
  }
  // btc
  if (!view.htlcAddress) throw new Error('BTC HTLC address not derived yet (set both addresses first)');
  const signer = await api.btcSigner();
  const tx = await signer.fund(await api.btcChain(), {
    p2wsh: view.htlcAddress,
    amountSats: BigInt(view.amount),
    feeSats: fee,
  });
  return { tx, leg: view.leg, chain: view.chain };
}

/** Claim the leg the agent receives, revealing the preimage. Returns the tx id. */
export async function claimMyLeg(
  api: HashlockClient,
  swap: Swap,
  secrets: SecretStore,
): Promise<{ tx: string; leg: Leg; chain: string }> {
  const r = await role(api, swap);
  const view = legView(swap, r === 'maker' ? 'b' : 'a');
  if (view.claimTx) throw new Error(`your ${view.chain} leg is already claimed (${view.claimTx})`);

  const local = secrets.get(swap.threadId)?.secret;
  const secretHex = (local ?? swap.secretCiphertext ?? '').replace(/^0x/, '');
  if (!secretHex) throw new Error('the preimage is not available yet (the initiator has not revealed it)');

  const fam = familyOf(view.chain);
  let tx: string;
  if (fam === 'evm') {
    if (!view.htlcAddress) throw new Error('EVM clone address unknown (leg not funded yet)');
    tx = await api.evmSigner().claim(await api.evmChain(), view.htlcAddress as `0x${string}`, secretHex);
  } else if (fam === 'tron') {
    if (!swap.onchainSwapId) throw new Error('TRON on-chain swapId unknown (leg not funded yet)');
    tx = await api.tronSigner().claim(await api.tronChain(), swap.onchainSwapId, secretHex);
  } else if (fam === 'svm') {
    tx = await settleSolanaLeg(api, swap.id, view.leg, 'claim', { secret: secretHex });
  } else {
    if (!view.htlcAddress || !view.redeemScript) throw new Error('BTC HTLC/redeem script unknown (leg not funded yet)');
    const signer = await api.btcSigner();
    tx = await signer.claim(await api.btcChain(), {
      p2wsh: view.htlcAddress,
      redeemHex: view.redeemScript,
      preimageHex: secretHex,
    });
  }

  // Tell the API so the counterparty/keeper can settle the other leg (best-effort; watchers also see it).
  await api.reveal(swap.id, { secret: secretHex, claimTx: tx, leg: view.leg }).catch(() => undefined);
  return { tx, leg: view.leg, chain: view.chain };
}
