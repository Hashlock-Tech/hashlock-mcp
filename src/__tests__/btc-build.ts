import * as bitcoin from 'bitcoinjs-lib';

/**
 * A spend as the API's Bitcoin builder answers it: a PSBT sweeping `inputs` outputs of 100 000 sats at the
 * P2WSH of `witnessScript` (or at `from`, the metadata beside the digest), paying `to`, with every input's
 * BIP-143 sighash — what signServerSpend reproduces before it signs.
 */
export function serverBuild(p: { witnessScript: Buffer; network: bitcoin.Network; to: string; from?: Buffer; inputs?: number; outputs?: number }) {
  const htlc = bitcoin.payments.p2wsh({ redeem: { output: p.witnessScript, network: p.network }, network: p.network });
  const inputs = p.inputs ?? 1;
  const outs = p.outputs ?? 1;
  const psbt = new bitcoin.Psbt({ network: p.network });
  for (let i = 0; i < inputs; i++) {
    psbt.addInput({
      hash: Buffer.alloc(32, i + 1),
      index: 0,
      witnessUtxo: { script: p.from ?? htlc.output!, value: 100_000 },
      witnessScript: p.witnessScript,
    });
  }
  // What is not paid out goes to a miner, and the signer refuses a transaction that hands over most of the
  // escrow — so the fixture leaves an ordinary fee behind: 1000 sats across the outputs.
  const each = Math.floor((inputs * 100_000 - 1_000) / (outs || 1));
  for (let i = 0; i < outs; i++) psbt.addOutput({ address: p.to, value: each });
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.getTransaction());
  const sighashHexes = psbt.data.inputs.map((_, i) =>
    tx.hashForWitnessV0(i, p.witnessScript, 100_000, bitcoin.Transaction.SIGHASH_ALL).toString('hex'),
  );
  return { psbtBase64: psbt.toBase64(), sighashHexes };
}
