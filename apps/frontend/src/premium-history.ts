import type { Candle } from './api.js';

export interface PremiumHistoryPoint {
  time: number;
  value: number;
  adrClose: number;
  hedgeClose: number;
}

/** Range belongs in the chart key even when two ranges share the same candle interval. */
export function premiumHistoryViewKey(pairKey: string, range: string, adrRatio: string): string {
  return `${pairKey}:${range}:${adrRatio}`;
}

export function mergeCandleHistory(current: Candle[], incoming: Candle[]): Candle[] {
  const byStartTime = new Map(current.map((candle) => [candle.startTime, candle]));
  for (const candle of incoming) byStartTime.set(candle.startTime, candle);
  return [...byStartTime.values()].sort((left, right) => left.startTime - right.startTime);
}

/**
 * Builds one venue-pair premium series from timestamp-aligned candle closes.
 *
 * One hedge share represents `adrRatio` ADRs, so its fair per-ADR value is
 * hedgeClose / adrRatio and premium = ADR / fair value - 1.
 */
export function buildPremiumHistory(
  adrCandles: Candle[],
  hedgeCandles: Candle[],
  adrRatio: number,
  since: number,
  metric: 'PERCENT' | 'ABSOLUTE' = 'PERCENT',
): PremiumHistoryPoint[] {
  if (!Number.isFinite(adrRatio) || adrRatio <= 0) return [];

  const hedgeByTime = new Map(hedgeCandles.map((candle) => [candle.startTime, Number(candle.close)]));
  const points: PremiumHistoryPoint[] = [];
  for (const candle of adrCandles) {
    if (candle.startTime < since) continue;
    const adrClose = Number(candle.close);
    const hedgeClose = hedgeByTime.get(candle.startTime);
    if (!Number.isFinite(adrClose) || adrClose <= 0 || hedgeClose === undefined || !Number.isFinite(hedgeClose) || hedgeClose <= 0) continue;
    points.push({
      time: candle.startTime,
      value: metric === 'ABSOLUTE'
        ? adrClose - hedgeClose / adrRatio
        : ((adrClose * adrRatio) / hedgeClose - 1) * 100,
      adrClose,
      hedgeClose,
    });
  }
  return points.sort((left, right) => left.time - right.time);
}
