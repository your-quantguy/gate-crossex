import { describe, expect, it } from 'vitest';
import type { Candle } from './api.js';
import { buildPremiumHistory, mergeCandleHistory, premiumHistoryViewKey } from './premium-history.js';

function candle(startTime: number, close: string): Candle {
  return { startTime, open: close, high: close, low: close, close, volume: '1', closed: true };
}

describe('buildPremiumHistory', () => {
  it('calculates premium from aligned ADR and ratio-scaled hedge closes', () => {
    const points = buildPremiumHistory(
      [candle(1_000, '225'), candle(2_000, '238')],
      [candle(1_000, '1800'), candle(2_000, '1750')],
      10,
      0,
    );

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ time: 1_000, adrClose: 225, hedgeClose: 1800 });
    expect(points[0].value).toBeCloseTo(25);
    expect(points[1].value).toBeCloseTo(36);
  });

  it('calculates the aligned Brent minus WTI price difference in USD', () => {
    const points = buildPremiumHistory(
      [candle(1_000, '98.6'), candle(2_000, '97.2')],
      [candle(1_000, '93.4'), candle(2_000, '94.1')],
      1, 0, 'ABSOLUTE',
    );
    expect(points.map((point) => point.value)).toEqual([expect.closeTo(5.2), expect.closeTo(3.1)]);
  });

  it('keeps only timestamps shared by both legs and inside the requested range', () => {
    const points = buildPremiumHistory(
      [candle(1_000, '220'), candle(2_000, '225'), candle(3_000, '230')],
      [candle(1_000, '1800'), candle(3_000, '1800')],
      10,
      1_500,
    );

    expect(points.map((point) => point.time)).toEqual([3_000]);
  });

  it('returns no points for an invalid ratio or unusable prices', () => {
    expect(buildPremiumHistory([candle(1_000, '225')], [candle(1_000, '1800')], 0, 0)).toEqual([]);
    expect(buildPremiumHistory([candle(1_000, '0')], [candle(1_000, '1800')], 10, 0)).toEqual([]);
  });
});

describe('mergeCandleHistory', () => {
  it('prepends older candles, deduplicates timestamps, and keeps incoming updates', () => {
    expect(mergeCandleHistory(
      [candle(2_000, '20'), candle(3_000, '30')],
      [candle(1_000, '10'), candle(2_000, '21')],
    )).toEqual([
      candle(1_000, '10'),
      candle(2_000, '21'),
      candle(3_000, '30'),
    ]);
  });
});

describe('premiumHistoryViewKey', () => {
  it('resets the chart viewport when switching between 1H and 4H on the same 1m series', () => {
    const pairKey = 'GATE_FUTURE_SKHY_USDT:GATE_FUTURE_SKHYNIX_USDT:1m';
    expect(premiumHistoryViewKey(pairKey, '1H', '10'))
      .not.toBe(premiumHistoryViewKey(pairKey, '4H', '10'));
  });
});
