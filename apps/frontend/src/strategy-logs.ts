import type { StrategyConfig, StrategyLog } from './api.js';

export interface DisplayStrategyLog extends StrategyLog {
  executionPremiumPct: string | null;
  executionSpreadBps: string | null;
}

type StrategyLogMetricConfig = Pick<StrategyConfig, 'kind' | 'adrRatio' | 'premiumMetric' | 'leftSide' | 'rightSide'>;

type StrategyLogLanguage = 'en' | 'zh';

const chineseResultText: Record<string, string> = {
  'Submitting both taker legs': '正在同时提交两条吃单委托',
  'Submitting reduce-only market orders': '正在提交只减仓市价单',
  'Monitoring live premium': '正在监控实时溢价',
  'Monitoring live spreads': '正在监控实时价差',
  'Both legs fully executed and hedged': '两条分腿均已完全执行并完成对冲',
  'All opened exposure was closed; this strategy will not re-enter': '所有已开敞口均已平仓；该策略不会再次入场',
  'Order rejected for insufficient margin; strategy stopped retrying until manually reviewed': '订单因保证金不足被拒绝；策略已停止重试，请人工检查',
  'Five consecutive order submissions failed; check credentials, balances, and venue status': '连续五次提交订单失败；请检查凭证、余额和交易所状态',
  'Five consecutive maker quotes were rejected; check credentials, balances, and venue status': '连续五次挂单报价被拒绝；请检查凭证、余额和交易所状态',
  'Unable to close residual premium exposure after 3 attempts; manual review required': '三次尝试后仍无法平掉剩余溢价敞口；需要人工检查',
  Filled: '已成交',
  Stopped: '已停止',
  'submit error': '提交失败',
  'unknown error': '未知错误',
};

/**
 * Strategy logs are persisted in a language-neutral form by the backend. Localize their dynamic
 * text at render time so switching languages also updates historical rows.
 */
export function localizeStrategyLogCondition(condition: string, language: StrategyLogLanguage): string {
  if (language !== 'zh') return condition;
  return condition.replace(/\bPremium\b/gi, '溢价').replace(/\bSpread\b/gi, '价差');
}

export function localizeStrategyLogResult(result: string, language: StrategyLogLanguage): string {
  if (language !== 'zh') return result;

  let localized = chineseResultText[result] ?? result;
  localized = localized
    .replace(/^Leverage (.+?)× \/ (.+?)× · reserved margin (.+?) of (.+)$/i, '杠杆 $1× / $2× · 预留保证金 $3 / 可用保证金 $4')
    .replace(/^Stopped with unhedged residual (.+); review positions$/i, '已停止，存在未对冲剩余敞口 $1；请检查持仓')
    .replace(/^Hedge quantity (.+) rounds below the (.+) lot size; raise per-order quantity$/i, '对冲数量 $1 按步长取整后低于 $2 的最小下单量；请提高每单数量')
    .replace(/^Unable to hedge residual exposure of (.+) after 3 attempts; manual review required$/i, '三次尝试后仍无法对冲剩余敞口 $1；需要人工检查')
    .replace(/^(.+) remaining$/i, '剩余 $1');

  return localized
    .replace(/\bPARTIALLY_FILLED\b/g, '部分成交')
    .replace(/\bBUY\b/g, '买入')
    .replace(/\bSELL\b/g, '卖出')
    .replace(/\bFILLED\b/g, '已成交')
    .replace(/\bCANCELLED\b/g, '已取消')
    .replace(/\bREJECTED\b/g, '已拒绝')
    .replace(/\bEXPIRED\b/g, '已过期')
    .replace(/\bFAILED\b/g, '失败')
    .replace(/\bavg\b/gi, '均价')
    .replace(/\bhedge\b/gi, '对冲腿')
    .replace(/\bmarket\b/gi, '市价');
}

function isFilledLeg(log: StrategyLog): boolean {
  return log.event === 'Left leg filled' || log.event === 'Right leg filled';
}

/**
 * Collapses legacy successful taker clips, which were persisted as one row per leg, into the
 * clip-level execution row now emitted by the backend. Incomplete clips stay ungrouped so their
 * leg-level diagnostics remain visible.
 */
export function groupStrategyLogs(logs: StrategyLog[]): StrategyLog[] {
  const consumed = new Set<number>();
  const grouped: StrategyLog[] = [];

  for (let index = 0; index < logs.length; index += 1) {
    if (consumed.has(index)) continue;
    const log = logs[index];
    if (!log || !isFilledLeg(log)) {
      if (log) grouped.push(log);
      continue;
    }

    const counterpartEvent = log.event === 'Left leg filled' ? 'Right leg filled' : 'Left leg filled';
    const counterpartIndex = logs.findIndex((candidate, candidateIndex) =>
      candidateIndex !== index
      && !consumed.has(candidateIndex)
      && candidate.event === counterpartEvent
      && candidate.condition === log.condition);
    if (counterpartIndex < 0) {
      grouped.push(log);
      continue;
    }

    const counterpart = logs[counterpartIndex];
    if (!counterpart) {
      grouped.push(log);
      continue;
    }
    const left = log.event === 'Left leg filled' ? log : counterpart;
    const right = log.event === 'Right leg filled' ? log : counterpart;
    const takeProfit = logs.some((candidate) =>
      candidate.event === 'Take-profit triggered' && candidate.condition === log.condition);
    consumed.add(index);
    consumed.add(counterpartIndex);
    grouped.push({
      id: `${left.id}:${right.id}`,
      level: 'info',
      event: takeProfit ? 'Take-profit Executed' : 'Position open Executed',
      condition: log.condition,
      quantity: `${left.quantity} · ${right.quantity}`,
      result: `${left.result} · ${right.result}`,
      createdAt: Date.parse(left.createdAt) >= Date.parse(right.createdAt) ? left.createdAt : right.createdAt,
    });
  }

  return grouped;
}

function executionPrices(result: string): number[] {
  const atPrices = [...result.matchAll(/@\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (atPrices.length >= 2) return atPrices;

  return [...result.matchAll(/\bavg\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

/**
 * Adds a fill-price-derived metric to successful executions. Premium strategies show ADR premium;
 * regular cross-exchange strategies show the actual spread between the original sell and buy legs.
 * The execution result always stores the left-leg fill first and the right-leg fill second.
 */
export function prepareStrategyLogs(logs: StrategyLog[], config?: StrategyLogMetricConfig): DisplayStrategyLog[] {
  const ratio = Number(config?.adrRatio);

  return groupStrategyLogs(logs).map((log) => {
    const isExecution = log.event === 'Position open Executed'
      || log.event === 'Take-profit Executed'
      || log.event === 'Reduce-only Executed';
    if (!isExecution || !config) {
      return { ...log, executionPremiumPct: null, executionSpreadBps: null };
    }

    const [leftPrice, rightPrice] = executionPrices(log.result);
    if (leftPrice === undefined || rightPrice === undefined || leftPrice <= 0 || rightPrice <= 0) {
      return { ...log, executionPremiumPct: null, executionSpreadBps: null };
    }

    if (config.kind === 'premium') {
      if (!Number.isFinite(ratio) || ratio <= 0) {
        return { ...log, executionPremiumPct: null, executionSpreadBps: null };
      }
      return {
        ...log,
        executionPremiumPct: (config.premiumMetric === 'ABSOLUTE'
          ? leftPrice - rightPrice / ratio
          : ((leftPrice * ratio) / rightPrice - 1) * 100).toFixed(2),
        executionSpreadBps: null,
      };
    }

    const sellPrice = config.leftSide === 'SELL' ? leftPrice : rightPrice;
    const buyPrice = config.leftSide === 'BUY' ? leftPrice : rightPrice;
    return {
      ...log,
      executionPremiumPct: null,
      executionSpreadBps: (((sellPrice - buyPrice) / buyPrice) * 10_000).toFixed(2),
    };
  });
}
