import * as bitcoin from 'bitcoinjs-lib';
import type { BtcLegTx, HashlockClient, Swap } from './client.js';
import { esploraAddressStats, htlcScript, readBtcEscrow } from './chains/btc.js';
import { cloneExists, readEvmEscrow } from './chains/evm.js';
import { readSolanaEscrow, solanaAccountExists, type SolanaPin } from './chains/solana.js';
import { normHex as norm, sha256Hex, type AgreementStore, type AssetSnapshot, type SecretStore } from './secrets.js';
import { assertPinned, btcNet, checkDeal, evmNet, pinnedToken, solanaNet, tronNet, type Deal } from './trust.js';

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
 * program's IDL, a Borsh coder and the exact byte layout of that hash. The server answers with the
 * transaction; the agent decodes it and signs only if every account and argument that decides whose money
 * moves is the one it expects (`pin`, checked in SolanaSigner.signTransaction).
 */
async function settleSolanaLeg(
  api: HashlockClient,
  swapId: string,
  leg: Leg,
  body: Record<string, unknown>,
  pin: SolanaPin,
  /** Runs once the transaction has passed every check, right before it is sent. */
  beforeSend?: () => void,
): Promise<string> {
  const built = await api.buildLeg(swapId, leg, pin.action, body);
  if (!built.escrow) throw new Error('the API did not name an escrow for this leg');
  if (pin.escrow && pin.escrow !== built.escrow) {
    throw new Error(`the API built a transaction for escrow ${built.escrow}, but this leg's escrow is ${pin.escrow}`);
  }
  // A fund binds the escrow the server named, and refuses one that already exists: a retry must not pay twice
  // (the program derives that address from the terms, so it is this leg's).
  const bound: SolanaPin = pin.action === 'fund' ? { ...pin, escrow: built.escrow } : pin;
  if (pin.action === 'fund' && (await solanaAccountExists(api.solanaRpc, built.escrow))) {
    throw new Error('your Solana escrow for this swap already exists — not funding it again');
  }
  const signed = api.solanaSigner().signTransaction(built.transactionBase64, bound.escrow!, bound);
  beforeSend?.();
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

/** Which side the API says this agent is on — used only where nothing of the agent's is at stake (refund, a claim with a public secret). */
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
 * fund a different escrow than the one the server looks for. Its size is bounded in checkDeal.
 */
export function feeForLeg(swap: Pick<Swap, 'feeAssetId' | 'feeAmount'>, assetId: string): bigint {
  const owed = BigInt(swap.feeAmount || '0');
  return owed > 0n && swap.feeAssetId === assetId ? owed : 0n;
}

/**
 * Whether funding `leg` must wait. The short leg is funded only once the swap is `initiator_funded`. A
 * readable early answer only: what actually holds the counterparty back is the on-chain check of the
 * initiator's escrow in fundMyLeg.
 */
export function fundMustWait(swap: Pick<Swap, 'initiatorUserId' | 'makerId' | 'status'>, leg: Leg): boolean {
  const initiators: Leg = swap.initiatorUserId === swap.makerId ? 'a' : 'b';
  return leg !== initiators && swap.status !== 'initiator_funded';
}

/**
 * How long the counterparty's escrow must stay claimable when the initiator reveals the secret: a claim
 * that lands after its timelock lets them refund AND take the long leg with the published secret.
 */
const CLAIM_MARGIN_SECONDS = 15 * 60;

/** The least time the agent's own leg must have left when it funds: the contracts' 30-minute floor plus a margin. */
const MIN_OWN_TIMELOCK_SECONDS = 45 * 60;

/** Everything ever paid to `address`, confirmed or in the mempool. */
async function btcAddressPaid(esplora: string, address: string): Promise<bigint> {
  const s = await esploraAddressStats(esplora, address);
  return BigInt(s.chain_stats.funded_txo_sum + s.mempool_stats.funded_txo_sum);
}

/** The API's MIN_TIMELOCK_GAP_SECONDS: the long leg outlives the short one by at least this much. */
export const MIN_TIMELOCK_GAP_SECONDS = 2 * 3600;

/** An escrow as the chain holds it. Addresses in the chain's own spelling (EVM lower-cased); token null = native. */
export interface OnchainEscrow {
  hashlock: string; // hex, no 0x, lower-case
  recipient: string;
  token: string | null;
  amount: bigint;
  timelock: number;
  /** Neither claimed nor refunded. */
  open: boolean;
}

/** Why `e` is not the escrow the agent may rely on, or null when it is. */
export function escrowProblem(
  e: OnchainEscrow,
  want: { hashlock: string; recipients: string[]; token: string | null; amount: bigint; minTimelock: number },
): string | null {
  if (!Number.isFinite(want.minTimelock)) return 'cannot be judged: the deadline it must outlive is unknown';
  if (!e.open) return 'is already claimed or refunded';
  if (e.hashlock !== want.hashlock) return `is locked to hashlock ${e.hashlock}, not the agreed ${want.hashlock}`;
  if (!want.recipients.includes(e.recipient)) return `pays ${e.recipient}, not you (${want.recipients.join(' or ') || 'no key or address of yours here'})`;
  if (e.token !== want.token) return `holds ${e.token ?? 'the native coin'}, not the agreed ${want.token ?? 'native coin'}`;
  if (e.amount < want.amount) return `holds ${e.amount}, less than the agreed ${want.amount}`;
  if (e.timelock < want.minTimelock) return `expires at ${e.timelock}, before ${want.minTimelock}`;
  return null;
}


/**
 * CHECK ON CHAIN THE ESCROW THIS AGENT IS TO BE PAID FROM (tester 3.4) — before funding its own leg as
 * the counterparty, and before its own secret is released in any way. Every term comes from the chain
 * through this process's own RPC, on the network that RPC answers for, and is compared with the deal as
 * the agent agreed it (asset from its own record, only if pinned) and with this process's OWN key on that
 * chain — never with the payout the API reports. The API still names where to look; a lie about that finds
 * nothing that passes. The escrow is then recorded as backing this swap, so it can never back another.
 */
export async function verifyReceiveEscrow(
  api: HashlockClient,
  swap: Swap,
  view: LegView,
  asset: AssetSnapshot,
  minTimelock: number,
  agreements: Pick<AgreementStore, 'rely' | 'addressesFor'>,
  /** 'fund' before the agent puts money in (current contracts only), 'all' to release against an existing escrow. */
  contracts: 'fund' | 'all' = 'all',
): Promise<void> {
  if (!view.htlcAddress) throw new Error(`the ${view.chain} leg has no escrow on record — it is not funded yet`);
  const hashlock = norm(swap.hashlock);
  // WHO MAY BE PAID: this process's own key on the chain, or an address this MCP itself set on this swap —
  // never one the API reports, lists or calls verified.
  const own = (get: () => string) => {
    try {
      return [get()];
    } catch {
      return []; // no key for this chain here: only the addresses set through this MCP
    }
  };
  const set = agreements.addressesFor(swap.id, view.chain, view.leg);
  let token: string | null;
  let mine: string[];
  let e: OnchainEscrow;
  let key = view.htlcAddress;
  const fam = await api.familyOf(view.chain);
  if (fam === 'evm') {
    const n = await evmNet(api, view.chain);
    mine = [...own(() => api.evmSigner().address), ...set].map((a) => a.toLowerCase());
    token = pinnedToken(n.rail, asset, 'evm');
    e = await readEvmEscrow(n, view.htlcAddress as `0x${string}`, swap.id, feeForLeg(swap, view.assetId), n.rail[contracts]);
    key = `${n.chainId}:${view.htlcAddress.toLowerCase()}`;
  } else if (fam === 'tron') {
    const { rail } = await tronNet(api);
    const signer = api.tronSigner(); // reads the pool through TronWeb, which needs the key
    mine = [signer.address, ...set];
    token = pinnedToken(rail, asset, 'tron');
    assertPinned(rail[contracts], view.htlcAddress, 'a TRON HTLC pool');
    const slot = tronLegKey(swap, view.leg);
    e = await signer.readSlot(await api.tronChain(), view.htlcAddress, slot, swap.id, feeForLeg(swap, view.assetId));
    key = `tron:${view.htlcAddress}:${slot}`;
  } else if (fam === 'svm') {
    const { rail } = await solanaNet(api);
    mine = [...own(() => api.solanaSigner().address), ...set];
    token = pinnedToken(rail, asset, 'svm');
    e = await readSolanaEscrow(api.solanaRpc, view.htlcAddress, swap.id, rail[contracts]);
  } else {
    if (!view.redeemScript) throw new Error('the Bitcoin leg has no redeem script on record');
    const n = await btcNet(api); // the network is the BTC key's own, so the key is needed here
    mine = [(await api.btcSigner()).pubkeyHex, ...set].map((a) => a.toLowerCase());
    token = null;
    if (!asset.isNative || asset.symbol !== 'BTC') throw new Error('a Bitcoin leg can only be native BTC');
    e = await readBtcEscrow(n.esplora, n.network, {
      htlcAddress: view.htlcAddress,
      redeemScript: view.redeemScript,
      hashlockHex: hashlock,
      receivers: mine,
      timelockUnix: view.timelockUnix,
      confirmations: n.confirmations,
    });
  }
  const problem = escrowProblem(e, { hashlock, recipients: mine, token, amount: BigInt(view.amount), minTimelock });
  if (problem) {
    const hint = mine.includes(e.recipient)
      ? ''
      : ' — this MCP pays out only to its own key or to an address it set itself with set_settlement_address; a deal agreed before this release, or an address set elsewhere, is settled in the web app';
    throw new Error(`refusing: the ${view.chain} escrow at ${view.htlcAddress} ${problem}${hint}`);
  }
  agreements.rely(`${view.chain}:${key}`, swap.id);
}

/**
 * THE ONLY WAY THIS AGENT'S OWN SECRET LEAVES IT (claim_leg, get_deal_secret, reveal_claim). If the swap's
 * hashlock is one of this process's secrets for the thread, the deal is checked against what the agent
 * agreed and the counterparty's escrow on chain — present, paying this agent, claimable for a while yet —
 * and only then is the secret handed out and marked revealed. Null: the hashlock is not ours, so there is
 * nothing of the agent's to protect. A secret already marked revealed passed this gate before.
 */
export async function releaseOwnSecret(
  api: HashlockClient,
  swap: Swap,
  secrets: Pick<SecretStore, 'findByHashlock' | 'markRevealed'>,
  agreements: Pick<AgreementStore, 'get' | 'rely' | 'addressesFor'>,
): Promise<{ secret: string; deal: Deal } | null> {
  const hashlock = norm(swap.hashlock);
  const found = secrets.findByHashlock(hashlock);
  if (!found || sha256Hex(found.entry.secret) !== hashlock) return null;
  const own = found.entry;
  // The secret belongs to ONE deal: the thread it was made for, on the request it was made for. A swap that
  // moves this hashlock to another thread, or pairs it with another request's (smaller) agreement, is not it.
  if (found.threadId !== swap.threadId) throw new Error(`refusing: this secret was made for thread ${found.threadId}, not ${swap.threadId}`);
  if (own.rfqId !== swap.rfqId) throw new Error(`refusing: this secret was made for request ${own.rfqId ?? 'unknown'}, not ${String(swap.rfqId)}`);
  const deal = await checkDeal(api, swap, agreements);
  // EVERY time, with no "released before" shortcut: until the claim is on chain the counterparty's escrow
  // can expire or the API can name another one, and the claim this release feeds acts on what is checked here.
  const view = legView(swap, deal.theirs);
  await verifyReceiveEscrow(api, swap, view, deal.asset[deal.theirs], Math.floor(Date.now() / 1000) + CLAIM_MARGIN_SECONDS, agreements);
  secrets.markRevealed(swap.threadId, hashlock);
  return { secret: own.secret, deal };
}

/** Fund the leg the agent gives. Returns the on-chain tx id. */
export async function fundMyLeg(
  api: HashlockClient,
  swap: Swap,
  secrets: Pick<SecretStore, 'findByHashlock' | 'markFunded'>,
  agreements: Pick<AgreementStore, 'get' | 'rely' | 'addressesFor' | 'takeOnce'>,
): Promise<{ tx: string; leg: Leg; chain: string }> {
  const deal = await checkDeal(api, swap, agreements);
  const hashlock = norm(swap.hashlock);
  const view = legView(swap, deal.mine);
  const asset = deal.asset[deal.mine];
  if (view.fundTx) throw new Error(`your ${view.chain} leg is already funded (${view.fundTx})`);
  if (!view.payout) throw new Error('the counterparty has not set their receive address yet — cannot fund');
  // Its own leg must still have time on it: everything below measures from this timelock, and one already
  // at hand would let an initiator escrow expiring in minutes pass the gap check.
  if (!(view.timelockUnix >= Math.floor(Date.now() / 1000) + MIN_OWN_TIMELOCK_SECONDS)) {
    throw new Error(`your ${view.chain} leg's timelock is less than ${MIN_OWN_TIMELOCK_SECONDS / 60} minutes away — not funding it`);
  }
  // WHO FUNDS FIRST is decided by the secret, not by the API: the hashlock is this agent's own only if it
  // is the initiator. Locking under a hashlock this process cannot open, or one already public, is refused;
  // so is an API that disagrees with that about who the initiator is.
  const found = secrets.findByHashlock(hashlock);
  if (found && found.threadId !== swap.threadId) throw new Error(`refusing: this swap's hashlock is your secret for thread ${found.threadId}, not ${swap.threadId}`);
  const own = found?.entry;
  const iAmInitiator = !!own;
  if (iAmInitiator && own!.rfqId !== swap.rfqId) {
    throw new Error(`refusing: this thread's secret was made for request ${own!.rfqId ?? 'unknown'}, not ${String(swap.rfqId)}`);
  }
  const apiSaysInitiator = (deal.side === 'maker' ? swap.makerId : swap.takerId) === swap.initiatorUserId;
  if (iAmInitiator !== apiSaysInitiator) {
    throw new Error(
      iAmInitiator
        ? 'refusing: the swap is locked under your hashlock, but the API names the other side as the initiator'
        : "refusing: you fund first as the initiator, but this swap's hashlock is not sha256 of a secret this process holds for the deal",
    );
  }
  if (iAmInitiator && own!.fundedFor && own!.fundedFor !== swap.id) {
    throw new Error(`refusing: this secret already locks your leg of swap ${own!.fundedFor}`);
  }
  if (iAmInitiator && own!.revealedAt) {
    throw new Error(`refusing: the secret behind this hashlock was already revealed (${own!.revealedAt}) — anyone can claim an escrow under it`);
  }
  if (!iAmInitiator) {
    if (fundMustWait(swap, deal.mine)) throw new Error(`the initiator has not funded their leg yet (swap is ${swap.status}) — wait for it before funding yours`);
    // The initiator's escrow, checked where it lives: it must outlive this leg by the protocol's gap.
    await verifyReceiveEscrow(api, swap, legView(swap, deal.theirs), deal.asset[deal.theirs], view.timelockUnix + MIN_TIMELOCK_GAP_SECONDS, agreements, 'fund');
  }
  const fee = feeForLeg(swap, view.assetId);
  const fam = await api.familyOf(view.chain);
  // One leg of the agent's under one hashlock: revealing it to settle one deal would open every other
  // escrow under it, so a second swap reusing it is refused. Checked and recorded at the last moment —
  // right before the signer sends — so a funding refused by any check leaves both free. A signer that
  // fails after it (an empty wallet) leaves them taken: that swap can be retried, another needs a new
  // agreement.
  const commit = () => {
    agreements.takeOnce(`funded:${swap.id}`, `funding of your ${view.chain} leg of swap ${swap.id}`);
    agreements.rely(`hashlock:${hashlock}`, swap.id);
    if (iAmInitiator) secrets.markFunded(swap.threadId, hashlock, swap.id);
  };

  if (fam === 'evm') {
    const n = await evmNet(api, view.chain);
    assertPinned(n.rail.fund, n.factory, 'an HTLC factory', true);
    const token = pinnedToken(n.rail, asset, 'evm');
    const signer = api.evmSigner();
    const terms = { swapId: swap.id, hashlockHex: hashlock, recipient: view.payout as `0x${string}`, token: token as `0x${string}` | null, amount: BigInt(view.amount), timelockUnix: view.timelockUnix, initiator: signer.address, fee };
    if (await cloneExists(n, terms)) throw new Error(`your ${view.chain} escrow for this swap already exists — not funding it again`);
    commit();
    const tx = await signer.fund(n, {
      swapId: swap.id,
      hashlockHex: hashlock,
      recipient: view.payout as `0x${string}`,
      // The initiator — who the escrow refunds to — is the agent's own key: the redeployed factory refuses
      // any other caller (contract audit issue 5), so the escrow refunds to the wallet that funded it.
      refund: signer.address,
      token: token as `0x${string}` | null,
      amount: BigInt(view.amount),
      timelockUnix: view.timelockUnix,
      fee,
    });
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'tron') {
    const { rail } = await tronNet(api);
    const chain = await api.tronChain();
    if (!chain.sharedHtlc) throw new Error('TRON funding is not available on this API right now (its pool is being rotated)');
    assertPinned(rail.fund, chain.sharedHtlc, 'a TRON HTLC pool to fund');
    const token = pinnedToken(rail, asset, 'tron');
    const signer = api.tronSigner();
    if (await signer.fundedSlot(chain, chain.sharedHtlc, swap.id, token, fee)) throw new Error('your TRON escrow for this swap already exists — not funding it again');
    commit();
    const tx = await signer.fund(chain, {
      swapId: swap.id,
      recipient: view.payout,
      amount: view.amount,
      hashlockHex: hashlock,
      timelockUnix: view.timelockUnix,
      token, // null = native TRX
      fee: fee.toString(),
    });
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'svm') {
    // The escrow address IS the agreed terms on this rail, so the server derives it from BOTH parties'
    // settlement addresses and refuses without them. `view.payout` is checked above; this is the other.
    if (!view.refund) throw new Error('set your refund address first');
    const { rail } = await solanaNet(api);
    const tx = await settleSolanaLeg(api, swap.id, view.leg, {}, {
      programs: rail.fund,
      action: 'fund',
      mint: pinnedToken(rail, asset, 'svm'),
      fund: { swapId: swap.id, hashlock, recipient: view.payout, amount: BigInt(view.amount), timelock: view.timelockUnix, fee },
    }, commit);
    return { tx, leg: view.leg, chain: view.chain };
  }
  // btc: the escrow is a script, so the agent derives it itself — its own key on the refund branch, its own
  // hashlock, the agreed timelock — and pays only the address that script hashes to.
  if (!asset.isNative || asset.symbol !== 'BTC') throw new Error('a Bitcoin leg can only be native BTC');
  if (!view.htlcAddress) throw new Error('BTC HTLC address not derived yet (set both addresses first)');
  const n = await btcNet(api);
  const signer = await api.btcSigner();
  const script = htlcScript(hashlock, view.payout, Buffer.from(signer.pubkeyHex, 'hex'), view.timelockUnix);
  const net = n.net === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: script, network: net }, network: net }).address;
  if (p2wsh !== view.htlcAddress) {
    throw new Error(`refusing: the API's Bitcoin escrow ${view.htlcAddress} is not the HTLC the agreed terms produce (${p2wsh}) with your key on its refund branch`);
  }
  // A retry before the watcher records the first funding must not pay the escrow twice (dust someone else
  // sent there does not count as paid).
  if ((await btcAddressPaid(n.esplora, p2wsh)) >= BigInt(view.amount)) throw new Error(`the Bitcoin escrow ${p2wsh} has already been paid — not paying it again`);
  commit();
  const tx = await signer.fund({ network: n.network, esplora: n.esplora, treasury: n.treasury }, { p2wsh, amountSats: BigInt(view.amount), feeSats: fee });
  return { tx, leg: view.leg, chain: view.chain };
}

/** Claim the leg the agent receives. Returns the tx id. */
export async function claimMyLeg(
  api: HashlockClient,
  swap: Swap,
  secrets: Pick<SecretStore, 'findByHashlock' | 'markRevealed'>,
  agreements: Pick<AgreementStore, 'get' | 'rely' | 'addressesFor'>,
): Promise<{ tx: string; leg: Leg; chain: string }> {
  const hashlock = norm(swap.hashlock);
  // Our own secret only through the release gate, which also fixes the leg from the agent's own record;
  // otherwise the preimage the initiator revealed — public already, so claiming with it puts nothing of the
  // agent's at stake, and the leg is the one the API says it receives.
  const own = await releaseOwnSecret(api, swap, secrets, agreements);
  const r = await role(api, swap);
  if (!own && (r === 'maker' ? swap.makerId : swap.takerId) === swap.initiatorUserId) {
    throw new Error("refusing: this swap's hashlock is not sha256 of your secret — revealing it would not open the escrow");
  }
  const view = legView(swap, own ? own.deal.theirs : r === 'maker' ? 'b' : 'a');
  if (view.claimTx) throw new Error(`your ${view.chain} leg is already claimed (${view.claimTx})`);
  const secretHex = norm(own?.secret ?? swap.secretCiphertext ?? '');
  if (!secretHex) throw new Error('the preimage is not available yet (the initiator has not revealed it)');
  if (sha256Hex(secretHex) !== hashlock) {
    throw new Error("the revealed preimage does not open this swap's hashlock — not claiming with it");
  }

  const fam = await api.familyOf(view.chain);
  let tx: string;
  if (fam === 'evm') {
    if (!view.htlcAddress) throw new Error('EVM clone address unknown (leg not funded yet)');
    tx = await api.evmSigner().claim(await evmNet(api, view.chain), view.htlcAddress as `0x${string}`, secretHex);
  } else if (fam === 'tron') {
    const { rail } = await tronNet(api);
    const chain = await api.tronChain();
    const pool = view.htlcAddress ?? chain.pool!;
    assertPinned(rail.all, pool, 'a TRON HTLC pool');
    tx = await api.tronSigner().claim(chain, tronLegKey(swap, view.leg), secretHex, pool);
  } else if (fam === 'svm') {
    if (!view.htlcAddress) throw new Error('Solana escrow unknown (leg not funded yet)');
    const { rail } = await solanaNet(api);
    // The claim pays the escrow's recipient: this key, or an address this MCP set for the leg — the same
    // recipients the release gate accepts.
    const recipients = agreements.addressesFor(swap.id, view.chain, view.leg);
    tx = await settleSolanaLeg(api, swap.id, view.leg, { secret: secretHex }, { programs: rail.all, action: 'claim', escrow: view.htlcAddress, recipients });
  } else {
    if (!view.htlcAddress || !view.redeemScript) throw new Error('BTC HTLC/redeem script unknown (leg not funded yet)');
    const n = await btcNet(api);
    tx = await (await api.btcSigner()).claim(
      { network: n.network, esplora: n.esplora },
      { p2wsh: view.htlcAddress, redeemHex: view.redeemScript, preimageHex: secretHex },
    );
  }

  // Tell the API so the counterparty/keeper can settle the other leg (best-effort; watchers also see it).
  await api.reveal(swap.id, { secret: secretHex, claimTx: tx, leg: view.leg }).catch(() => undefined);
  return { tx, leg: view.leg, chain: view.chain };
}

/**
 * TAKE BACK THE LEG THE AGENT FUNDED, once its timelock has passed and the counterparty never claimed.
 *
 * Not tied to a recorded agreement or to the pinned FUND contracts: getting the agent's own money back must
 * survive a rotation and a deal agreed elsewhere. The chain is the real gate — every rail refuses a refund
 * before its timelock and pays only the escrow's own funder — and what is signed here moves nothing to
 * anyone else: EVM and TRON call refund() on the escrow, Solana signs a server build bound to this agent
 * as funder on the recorded escrow, Bitcoin signs a server build that may pay only this agent's address.
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
    const tx = await api.evmSigner().refund(await evmNet(api, view.chain), view.htlcAddress as `0x${string}`);
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'tron') {
    const tx = await api.tronSigner().refund(await api.tronChain(), tronLegKey(swap, view.leg), view.htlcAddress ?? undefined);
    return { tx, leg: view.leg, chain: view.chain };
  }
  if (fam === 'svm') {
    if (!view.htlcAddress) throw new Error('Solana escrow unknown (leg not funded yet)');
    const { rail } = await solanaNet(api);
    const tx = await settleSolanaLeg(api, swap.id, view.leg, {}, { programs: rail.all, action: 'refund', escrow: view.htlcAddress });
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
    network: (await btcNet(api)).network,
  });
  // NO preimageHex: its absence is what selects the refund branch in the server's finalizer.
  const { txid } = await api.broadcastSigned('bitcoin', { psbtBase64: built.psbtBase64, signaturesHex });
  return { tx: txid, leg: view.leg, chain: view.chain };
}

/**
 * The pool's key for THIS leg's escrow: the per-leg column the server records at funding. The shared
 * column holds whichever TRON leg was funded last, so it is used only when the swap has one TRON leg
 * (a TRX↔USDT swap on TRON has two). Mirrors the API's legOnchainId.
 */
export function tronLegKey(swap: Swap, leg: 'a' | 'b'): string {
  const own = leg === 'a' ? swap.aOnchainSwapId : swap.bOnchainSwapId;
  if (own) return own;
  if (swap.aChain !== swap.bChain && swap.onchainSwapId) return swap.onchainSwapId;
  throw new Error('TRON on-chain swapId unknown (leg not funded yet)');
}
