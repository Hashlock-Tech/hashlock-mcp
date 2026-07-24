import { describe, expect, it } from 'vitest';
import { BtcSigner } from '../chains/btc.js';
import { EvmSigner } from '../chains/evm.js';
import { TronSigner } from '../chains/tron.js';
import { familyOf } from '../settlement.js';

describe('familyOf', () => {
  it('maps chain names to settlement families', () => {
    expect(familyOf('bitcoin')).toBe('btc');
    expect(familyOf('bitcoin-signet')).toBe('btc');
    expect(familyOf('tron')).toBe('tron');
    expect(familyOf('tron-nile')).toBe('tron');
    expect(familyOf('ethereum')).toBe('evm');
    expect(familyOf('ethereum-sepolia')).toBe('evm');
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
