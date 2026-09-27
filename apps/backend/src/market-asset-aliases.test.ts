import { describe, expect, it } from 'vitest';
import { canonicalMarketAsset, nativeMarketAsset } from './market-asset-aliases.js';

describe('market asset aliases', () => {
  it('maps Hyperliquid SKHX to the canonical SKHYNIX identity in both directions', () => {
    expect(canonicalMarketAsset('HYPERLIQUID', 'FUTURE', 'SKHX')).toBe('SKHYNIX');
    expect(nativeMarketAsset('HYPERLIQUID', 'FUTURE', 'SKHYNIX')).toBe('SKHX');
  });

  it('maps Hyperliquid BRENTOIL to BZ without changing other venues', () => {
    expect(canonicalMarketAsset('HYPERLIQUID', 'FUTURE', 'BRENTOIL')).toBe('BZ');
    expect(nativeMarketAsset('HYPERLIQUID', 'FUTURE', 'BZ')).toBe('BRENTOIL');
    expect(nativeMarketAsset('BINANCE', 'FUTURE', 'BZ')).toBe('BZ');
    expect(nativeMarketAsset('HYPERLIQUID', 'FUTURE', 'CL')).toBe('CL');
  });

  it('keeps the distinct SKHY instrument and other venues unchanged', () => {
    expect(canonicalMarketAsset('HYPERLIQUID', 'FUTURE', 'SKHY')).toBe('SKHY');
    expect(canonicalMarketAsset('GATE', 'FUTURE', 'SKHX')).toBe('SKHX');
    expect(nativeMarketAsset('GATE', 'FUTURE', 'SKHYNIX')).toBe('SKHYNIX');
  });
});
