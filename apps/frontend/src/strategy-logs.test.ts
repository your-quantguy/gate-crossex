import { describe, expect, it } from 'vitest';
import type { StrategyLog } from './api.js';
import {
  groupStrategyLogs,
  localizeStrategyLogCondition,
  localizeStrategyLogResult,
  prepareStrategyLogs,
} from './strategy-logs.js';

function log(overrides: Partial<StrategyLog> & Pick<StrategyLog, 'id' | 'event'>): StrategyLog {
  return {
    level: 'info',
    condition: 'Premium 35.20% ≥ 35.00%',
    quantity: '0.1/0.1 SKHY',
    result: 'Filled',
    createdAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('strategy log grouping', () => {
  it('groups successful entry legs as one position-open execution', () => {
    const logs = [
      log({ id: 'right', event: 'Right leg filled', result: 'BUY hedge @ 1700' }),
      log({ id: 'left', event: 'Left leg filled', result: 'SELL ADR @ 230' }),
      log({ id: 'trigger', event: 'Entry triggered' }),
    ];

    expect(groupStrategyLogs(logs)).toEqual([
      expect.objectContaining({
        id: 'left:right',
        event: 'Position open Executed',
        result: 'SELL ADR @ 230 · BUY hedge @ 1700',
      }),
      logs[2],
    ]);
  });

  it('groups successful exit legs as one take-profit execution', () => {
    const condition = 'Premium 23.50% ≤ 24.00%';
    const logs = [
      log({ id: 'left-exit', event: 'Left leg filled', condition, result: 'BUY ADR @ 210' }),
      log({ id: 'right-exit', event: 'Right leg filled', condition, result: 'SELL hedge @ 1700' }),
      log({ id: 'trigger-exit', event: 'Take-profit triggered', condition }),
    ];

    expect(groupStrategyLogs(logs)[0]).toEqual(expect.objectContaining({
      event: 'Take-profit Executed',
      result: 'BUY ADR @ 210 · SELL hedge @ 1700',
    }));
  });

  it('keeps unmatched leg diagnostics separate', () => {
    const logs = [log({ id: 'left-only', event: 'Left leg filled' })];
    expect(groupStrategyLogs(logs)).toEqual(logs);
  });
});

describe('strategy log execution premium', () => {
  const premiumConfig = { kind: 'premium', adrRatio: '10', leftSide: 'SELL', rightSide: 'BUY' } as const;

  it('uses USD for absolute BZ/CL fill spreads', () => {
    const prepared = prepareStrategyLogs([log({
      id: 'oil', event: 'Position open Executed',
      result: 'SELL HYPERLIQUID_FUTURE_BRENTOIL_USDC 1 @ 98.6 · BUY BINANCE_FUTURE_CL_USDT 1 @ 93.4',
    })], { kind: 'premium', premiumMetric: 'ABSOLUTE', adrRatio: '1', leftSide: 'SELL', rightSide: 'BUY' });
    expect(prepared[0]?.executionPremiumPct).toBe('5.20');
  });

  it('calculates the opening premium from a combined backend execution', () => {
    const logs = [log({
      id: 'open',
      event: 'Position open Executed',
      result: 'SELL GATE_FUTURE_SKHY_USDT 0.1 @ 229.9 · BUY GATE_FUTURE_SKHYNIX_USDT 0.01 @ 1700',
    })];

    expect(prepareStrategyLogs(logs, premiumConfig)[0]?.executionPremiumPct).toBe('35.24');
  });

  it('calculates the take-profit premium from a combined execution', () => {
    const logs = [log({
      id: 'exit',
      event: 'Take-profit Executed',
      result: 'BUY GATE_FUTURE_SKHY_USDT 0.1 @ 210 · SELL GATE_FUTURE_SKHYNIX_USDT 0.01 @ 1700',
    })];

    expect(prepareStrategyLogs(logs, premiumConfig)[0]?.executionPremiumPct).toBe('23.53');
  });

  it('calculates the premium from a reduce-only execution', () => {
    const logs = [log({
      id: 'reduce-only',
      event: 'Reduce-only Executed',
      result: 'BUY BINANCE_FUTURE_SKHY_USDT 10 @ 159.38 · SELL BINANCE_FUTURE_SKHYNIX_USDT 1.33 @ 1189.77',
    })];

    expect(prepareStrategyLogs(logs, premiumConfig)[0]?.executionPremiumPct).toBe('33.96');
  });

  it('calculates legacy grouped execution premiums and leaves diagnostics blank', () => {
    const logs = [
      log({ id: 'right', event: 'Right leg filled', result: 'BUY hedge · avg 1700' }),
      log({ id: 'left', event: 'Left leg filled', result: 'SELL ADR · avg 230' }),
      log({ id: 'trigger', event: 'Entry triggered' }),
    ];
    const prepared = prepareStrategyLogs(logs, premiumConfig);

    expect(prepared[0]?.executionPremiumPct).toBe('35.29');
    expect(prepared[1]?.executionPremiumPct).toBeNull();
  });
});

describe('strategy log execution spread', () => {
  it('calculates the actual hedge spread from the completed fill prices', () => {
    const logs = [log({
      id: 'open',
      event: 'Position open Executed',
      result: 'SELL DERIBIT_FUTURE_HYPE_USDC 10 @ 54.778 · BUY BYBIT_FUTURE_HYPE_USDT 10 @ 54.866',
    })];

    const prepared = prepareStrategyLogs(logs, {
      kind: 'position', leftSide: 'SELL', rightSide: 'BUY',
    });

    expect(prepared[0]?.executionSpreadBps).toBe('-16.04');
    expect(prepared[0]?.executionPremiumPct).toBeNull();
  });

  it('uses the configured sell leg when the hedge direction is reversed', () => {
    const logs = [log({
      id: 'open-reversed',
      event: 'Position open Executed',
      result: 'BUY LEFT_FUTURE_BTC_USDT 0.1 @ 100000 · SELL RIGHT_FUTURE_BTC_USDT 0.1 @ 100150',
    })];

    expect(prepareStrategyLogs(logs, {
      kind: 'auto', leftSide: 'BUY', rightSide: 'SELL',
    })[0]?.executionSpreadBps).toBe('15.00');
  });

  it('leaves non-execution rows without a derived spread', () => {
    const prepared = prepareStrategyLogs([
      log({ id: 'trigger', event: 'Entry triggered' }),
    ], { kind: 'position', leftSide: 'SELL', rightSide: 'BUY' });

    expect(prepared[0]?.executionSpreadBps).toBeNull();
  });
});

describe('strategy log localization', () => {
  it('localizes premium conditions only when Chinese is selected', () => {
    const condition = 'Premium 27.08% ≤ 28.00%';

    expect(localizeStrategyLogCondition(condition, 'zh')).toBe('溢价 27.08% ≤ 28.00%');
    expect(localizeStrategyLogCondition(condition, 'en')).toBe(condition);
  });

  it('localizes order sides in dynamic execution results', () => {
    const result = 'BUY GATE_FUTURE_SKHY_USDT 1 @ 144.81 · SELL GATE_FUTURE_SKHYNIX_USDT 0.127 @ 1139.9';

    expect(localizeStrategyLogResult(result, 'zh')).toBe(
      '买入 GATE_FUTURE_SKHY_USDT 1 @ 144.81 · 卖出 GATE_FUTURE_SKHYNIX_USDT 0.127 @ 1139.9',
    );
    expect(localizeStrategyLogResult(result, 'en')).toBe(result);
  });

  it('localizes the taker submission status', () => {
    expect(localizeStrategyLogResult('Submitting both taker legs', 'zh')).toBe('正在同时提交两条吃单委托');
  });

  it('localizes dynamic strategy lifecycle details', () => {
    expect(localizeStrategyLogResult(
      'Leverage 2× / 3× · reserved margin 120 of 500',
      'zh',
    )).toBe('杠杆 2× / 3× · 预留保证金 120 / 可用保证金 500');
    expect(localizeStrategyLogResult(
      'Stopped with unhedged residual 0.1 SKHY; review positions',
      'zh',
    )).toBe('已停止，存在未对冲剩余敞口 0.1 SKHY；请检查持仓');
  });
});
