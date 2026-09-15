import type { Asset, BtcLegTx, HashlockClient, Swap } from './client.js';
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
  knownEscrow?: string | null,
): Promise<string> {
  const built = await api.buildLeg(swapId, leg, action, body);
  if (!built.escrow) throw new Error('the API did not name an escrow for this leg');
  // Compare against the escrow the WATCHER recorded when it saw the funding, not the one this same
  // response just asserted — otherwise the check is the server marking its own homework. Only a claim
  // or refund has that: at funding time the escrow does not exist yet.
  if (knownEscrow && knownEscrow !== built.escrow) {
    throw new Error(`the API built a transaction for escrow ${built.escrow}, but this leg was funded at ${knownEscrow}`);
  }
  const signed = api.solanaSigner().signTransaction(built.transactionBase64, knownEscrow ?? built.escrow);
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

/**
 * The fee a funding of this leg carries: the API's feeOwedOnLeg rule exactly — the leg whose asset is the
 * fee asset owes it, whoever funds it (contract audit issue 6). The redeployed contracts bind the fee into
 * the EVM escrow address and the TRON slot key, so a different rule here would not just underpay: it would
 * fund a different escrow than the one the server looks for.
 */
export function feeForLeg(swap: Pick<Swap, 'feeAssetId' | 'feeAmount'>, assetId: string): bigint {
  const owed = BigInt(swap.feeAmount || '0');
  return owed > 0n && swap.feeAssetId === assetId ? owed : 0n;
}

/**
 * Whether funding `leg` must wait. The short leg is funded only once the swap is `initiator_funded`. This
 * path signs with the agent's own key, so no server-side gate ever sees it: funding the counterparty leg
 * while the swap is still `agreed` gives the initiator an escrow they can claim with nothing of theirs
 * locked — and it sits in the window where its payout can still be rewritten, so the secret is never
 * relayed back when they do.
 */
export function fundMustWait(swap: Pick<Swap, 'initiatorUserId' | 'makerId' | 'status'>, leg: Leg): boolean {
  const initiators: Leg = swap.initiatorUserId === swap.makerId ? 'a' : 'b';
  return leg !== initiators && swap.status !== 'initiator_funded';
}

/** Fund the leg the agent gives. Returns the on-chain tx id. */
export async function fundMyLeg(api: HashlockClient, swap: Swap, assets: Asset[]): Promise<{ tx: string; leg: Leg; chain: string }> {
  const r = await role(api, swap);
  const mine: Leg = r === 'maker' ? 'a' : 'b';
  const view = legView(swap, mine);
  if (view.fundTx) throw new Error(`your ${view.chain} leg is already funded (${view.fundTx})`);
  if (fundMustWait(swap, mine)) {
    throw new Error(`the initiator has not funded their leg yet (swap is ${swap.status}) — wait for it before funding yours`);
  }
  if (!view.payout) throw new Error('the counterparty has not set their receive address yet — cannot fund');
  const fee = feeForLeg(swap, view.assetId);
  const asset = assets.find((a) => a.id === view.assetId);
  const hashlockHex = swap.hashlock.replace(/^0x/, '');
  const fam = await api.familyOf(view.chain);

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

  const fam = await api.familyOf(view.chain);
  let tx: string;
  if (fam === 'evm') {
    if (!view.htlcAddress) throw new Error('EVM clone address unknown (leg not funded yet)');
    tx = await api.evmSigner().claim(await api.evmChain(), view.htlcAddress as `0x${string}`, secretHex);
  } else if (fam === 'tron') {
    if (!swap.onchainSwapId) throw new Error('TRON on-chain swapId unknown (leg not funded yet)');
    tx = await api.tronSigner().claim(await api.tronChain(), swap.onchainSwapId, secretHex);
  } else if (fam === 'svm') {
    tx = await settleSolanaLeg(api, swap.id, view.leg, 'claim', { secret: secretHex }, view.htlcAddress);
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

/**
 * TAKE BACK THE LEG THE AGENT FUNDED, once its timelock has passed and the counterparty never claimed.
 *
 * The one settlement an autonomous agent could not perform: without it a swap that stalls leaves the
 * agent's money in an escrow until a human goes and presses a button somewhere else. The chain is the
 * real gate — every rail refuses a refund before its timelock — so the check below is a readable
 * message rather than the protection.
 *
 * BITCOIN IS SIGNED, NOT COMPOSED, like Solana: the server builds the spend and hands back one sighash
 * per swept input, and its finalizer assembles the refund branch. Composing that witness here would be
 * a second copy of the redeem script, and the copy that is wrong pays a miner to reject it.
 */
export async function refundMyLeg(api: HashlockClient, swap: Swap): Promise<{ tx: string; leg: Leg; chain: string }> {
  const r = await role(api, swap);
  const view = legView(swap, r === 'maker' ? 'a' : 'b');
  if (!view.fundTx) throw new Error(`your ${view.chain} leg was never funded — there is nothing to refund`);
  if (view.claimTx) {
    throw new Error(`your ${view.chain} leg was already claimed by the counterparty (${view.claimTx}) — it cannot be refunded`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (now < view.timelockUnix) {
    const mins = Math.ceil((view.timelockUnix - now) / 60);
    throw new Error(`the timelock on your ${view.chain} leg has not passed yet — about ${mins} minute(s) left`);
  }
  const fam = await api.familyOf(view.chain);

  if (fam === 'evm') {
    if (!view.htlcAddress) throw new Error('EVM clone address unknown (leg not funded yet)');
    const tx = await api.evmSigner().refund(await api.evmChain(), view.htlcAddress as `0x${string}`);
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'tron') {
    if (!swap.onchainSwapId) throw new Error('TRON on-chain swapId unknown (leg not funded yet)');
    const tx = await api.tronSigner().refund(await api.tronChain(), swap.onchainSwapId);
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'svm') {
    const tx = await settleSolanaLeg(api, swap.id, view.leg, 'refund', {}, view.htlcAddress);
    return { tx, leg: view.leg, chain: view.chain };
  }
  const built = await api.buildLeg<BtcLegTx>(swap.id, view.leg, 'refund');
  if (!built.psbtBase64 || !built.sighashHexes?.length) throw new Error('the API did not return a Bitcoin spend to sign');
  if (!view.htlcAddress) throw new Error('BTC HTLC address unknown (leg not funded yet)');
  if (!view.refund) throw new Error('no refund address on this leg — there is nowhere to send the coins back to');
  const signer = await api.btcSigner();
  // WHERE THE COINS MAY GO — the agent's own address and nowhere else. The API pays the refund branch
  // to the key it reads out of the REDEEM SCRIPT, and a refund this key can sign at all is one whose
  // script names this key: any other destination is either a build we could not sign or a server
  // proposing somewhere new. The row's own refund value adds nothing here and would only widen that.
  const signaturesHex = signer.signServerSpend({
    psbtBase64: built.psbtBase64,
    sighashHexes: built.sighashHexes,
    spends: view.htlcAddress,
    paysTo: [signer.address],
    network: (await api.chainConfig()).btc.network,
  });
  // NO preimageHex: its absence is what selects the refund branch in the server's finalizer.
  const { txid } = await api.broadcastSigned('bitcoin', { psbtBase64: built.psbtBase64, signaturesHex });
  return { tx: txid, leg: view.leg, chain: view.chain };
}
