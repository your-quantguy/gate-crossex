import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { LiveMarket } from './market-hub.js';
import type { TradingSession } from './trading-session.js';
import { GateApiError } from './crossex-client.js';
import { nativeMarketAsset } from './market-asset-aliases.js';
import {
  CreateStrategyInputSchema,
  UpdatePremiumTakeProfitInputSchema,
  TradingRuntime,
  TradingRuntimeError,
  isTerminalOrderState,
  type CreateStrategyInput,
  type ExecutionOrder,
  type StrategyRecord,
  type UpdatePremiumTakeProfitInput,
  unresolvedOrderDetails,
  type UnresolvedOrderReport,
} from './trading-runtime.js';

/** Read access to the live market cache; the production implementation is CrossExMarketHub. */
export interface MarketSource {
  market(symbol: string): LiveMarket | null;
  /** Register a catalog-known symbol on demand so its ticker streams; false when unknown. */
  ensureMarket?(symbol: string): boolean;
  /** Current upstream public-stream state, when the source can expose it. */
  connectionState?(): 'connecting' | 'healthy' | 'reconnecting' | 'stale' | 'disconnected';
}

export interface StrategyEngineOptions {
  /** Milliseconds between trigger evaluations. */
  tickIntervalMs?: number;
  /** How long to wait for a taker order to reach a terminal state before repairing. */
  orderTimeoutMs?: number;
  /** Minimum milliseconds between maker requotes per quote slot. */
  requoteIntervalMs?: number;
  /** Market data older than this is considered unusable for triggering. */
  marketFreshnessMs?: number;
  /** Maximum delay from the exchange source timestamp to local WebSocket receipt. */
  marketMaxTransportLagMs?: number;
  /** Small allowance for clock skew; quotes further in the future are rejected. */
  futureQuoteToleranceMs?: number;
  /** Cooldown between hedge-repair attempts. */
  repairCooldownMs?: number;
  now?: () => number;
}

type QuoteIntent = 'entry' | 'exit';

interface MakerQuote {
  orderId: string;
  price: Decimal;
  quantity: Decimal;
  quotedAt: number;
  cancelling: boolean;
}

interface StrategyActor {
  id: string;
  config: CreateStrategyInput;
  kind: 'position' | 'auto' | 'premium';
  status: string;
  busy: boolean;
  queue: Promise<void>;
  quotes: Map<QuoteIntent, MakerQuote>;
  repairAttempts: number;
  lastRepairAt: number;
  failureCount: number;
  cooldownUntil: number;
  lastQuoteAt: number;
  suspended: boolean;
  quiesceTarget: 'PAUSED' | 'STOPPED' | null;
  quiesceReason: string | null;
  /** Orders the last quiesce attempt could not prove terminal, kept for recovery diagnostics. */
  unresolvedOrders: UnresolvedOrderReport[];
  createdAt: number;
  lastCloseAt: number;
}

interface LegDefinition {
  leg: 'left' | 'right';
  venue: string;
  side: 'BUY' | 'SELL';
  symbol: string;
}

interface InstrumentConstraints {
  tickSize: string | null;
  lotSize: string | null;
  minSize: string | null;
  minNotional: string | null;
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const QUANTITY_EPSILON = new Decimal('1e-12');
/** Tolerance for rung arithmetic on decimal quantities; far below any real lot size. */
const RUNG_EPSILON = new Decimal('1e-9');
const BPS = new Decimal(10_000);
/** Keep dust-repair orders clear of a moving venue's exact minimum-notional boundary. */
const MIN_NOTIONAL_REPAIR_BUFFER = new Decimal('1.1');

function symbolFor(venue: string, asset: string): string {
  const quote = venue === 'KRAKEN' ? 'USD' : venue === 'HYPERLIQUID' || venue === 'DERIBIT' ? 'USDC' : 'USDT';
  const nativeAsset = nativeMarketAsset(venue, 'FUTURE', asset);
  return `${venue}_FUTURE_${nativeAsset}_${quote}`;
}

function legsOf(config: CreateStrategyInput): { left: LegDefinition; right: LegDefinition } {
  // Premium strategies hedge the ADR (left) with the local listing (right); other kinds trade the
  // same asset on both venues.
  const rightAsset = config.kind === 'premium' ? config.hedgeAsset ?? config.asset : config.asset;
  return {
    left: { leg: 'left', venue: config.leftVenue, side: config.leftSide, symbol: symbolFor(config.leftVenue, config.asset) },
    right: { leg: 'right', venue: config.rightVenue, side: config.rightSide, symbol: symbolFor(config.rightVenue, rightAsset) },
  };
}

/**
 * ADR shares per one hedge-leg share (SK hynix: 1 Korean share ≈ 10 ADRs). Strategy quantities
 * are always expressed in left-leg (ADR) units; the right leg converts through this ratio at
 * order submission (hedge qty = ADR qty ÷ ratio), and executed right-leg quantities multiply by
 * it so exposure, matching, and progress stay in one unit.
 */
function adrRatioOf(config: CreateStrategyInput): Decimal {
  if (config.kind !== 'premium') return ONE;
  const ratio = new Decimal(config.adrRatio ?? '1');
  return ratio.gt(0) ? ratio : ONE;
}

function oppositeSide(side: 'BUY' | 'SELL'): 'BUY' | 'SELL' {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

interface StrategyOrderRow {
  leg: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  executed_quantity: string;
  strategy_clip: string | null;
  reduce_only: number;
}

interface StrategyLedgerCache {
  loadedAt: number;
  rows: StrategyOrderRow[];
  configKey?: string;
  exposure?: { left: Decimal; right: Decimal; rightShares: Decimal };
  shortfalls?: Array<{ clip: string | null; k: Decimal; lagging: 'left' | 'right'; delta: Decimal }>;
  premiumExitStarted?: boolean;
  openOrderIds?: string[];
}

interface ClipGroup {
  clip: string | null;
  rows: StrategyOrderRow[];
}

function signedExecuted(row: StrategyOrderRow): Decimal {
  const executed = new Decimal(row.executed_quantity || '0');
  return row.side === 'BUY' ? executed : executed.neg();
}

/** Groups a strategy's orders by clip, preserving insertion order within and across groups. */
function clipGroups(rows: StrategyOrderRow[]): ClipGroup[] {
  const groups = new Map<string, ClipGroup>();
  for (const row of rows) {
    const key = row.strategy_clip ?? '__unclipped__';
    let group = groups.get(key);
    if (!group) {
      group = { clip: row.strategy_clip, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/**
 * Intended right-shares per left-share of one clip, recovered from the requested quantities of
 * its original two legs (rows are insertion-ordered, and both original rows exist before any
 * repair order — a row is written even when submission fails). Falls back to the strategy's
 * fixed conversion for legacy rows without a clip id.
 */
function clipRatio(group: ClipGroup, fixedRatio: Decimal): Decimal {
  const firstLeft = group.rows.find((row) => row.leg === 'left');
  const firstRight = group.rows.find((row) => row.leg === 'right');
  const fallback = ONE.div(fixedRatio);
  if (!firstLeft || !firstRight) return fallback;
  const leftQuantity = new Decimal(firstLeft.quantity);
  const rightQuantity = new Decimal(firstRight.quantity);
  if (!leftQuantity.gt(0) || !rightQuantity.gt(0)) return fallback;
  return rightQuantity.div(leftQuantity);
}

function roundToStep(value: Decimal, step: string | null, direction: 'up' | 'down'): Decimal {
  if (!step) return value;
  const stepDecimal = new Decimal(step);
  if (!stepDecimal.gt(0)) return value;
  const units = value.div(stepDecimal);
  const rounded = direction === 'up' ? units.ceil() : units.floor();
  return rounded.mul(stepDecimal);
}

function parseFailureReason(reason: string | null): { label: string | null; message: string } | null {
  if (!reason?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(reason);
    if (parsed && typeof parsed === 'object') {
      const value = parsed as { label?: unknown; message?: unknown };
      const label = typeof value.label === 'string' ? value.label : null;
      const message = typeof value.message === 'string' ? value.message : label ?? reason;
      return { label, message };
    }
  } catch { /* Some adapters return a plain label instead of JSON. */ }
  return { label: reason, message: reason };
}

function failureSummary(reason: string | null): string | null {
  const parsed = parseFailureReason(reason);
  if (!parsed) return null;
  const detail = parsed.label && parsed.label !== parsed.message
    ? `${parsed.label}: ${parsed.message}`
    : parsed.message;
  return detail.slice(0, 240);
}

function isRouterCapacityFailure(reason: string | null): boolean {
  const parsed = parseFailureReason(reason);
  return parsed?.label === 'NOT_BEST_ACCOUNT_ROUTER'
    || parsed?.message.includes('NOT_BEST_ACCOUNT_ROUTER') === true;
}

export class StrategyEngineError extends TradingRuntimeError {}

export class StrategyEngine {
  private readonly actors = new Map<string, StrategyActor>();
  private readonly options: Required<StrategyEngineOptions>;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRun: Promise<void> | null = null;
  private tickRequested = false;
  private readonly constraintCache = new Map<string, { value: InstrumentConstraints; cachedAt: number }>();
  private readonly ledgerCache = new Map<string, StrategyLedgerCache>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly strategyOrderRowsStatement;
  private readonly openStrategyOrderIdsStatement;
  private readonly instrumentConstraintsStatement;
  private readonly latestLegOrderStatement;
  private stopped = false;

  constructor(
    private readonly database: Database.Database,
    private readonly session: TradingSession,
    private readonly runtime: TradingRuntime,
    private readonly markets: MarketSource,
    options: StrategyEngineOptions = {},
  ) {
    this.options = {
      tickIntervalMs: options.tickIntervalMs ?? 500,
      orderTimeoutMs: options.orderTimeoutMs ?? 20_000,
      requoteIntervalMs: options.requoteIntervalMs ?? 2_000,
      marketFreshnessMs: options.marketFreshnessMs ?? 15_000,
      marketMaxTransportLagMs: options.marketMaxTransportLagMs ?? 3_000,
      futureQuoteToleranceMs: options.futureQuoteToleranceMs ?? 2_000,
      repairCooldownMs: options.repairCooldownMs ?? 3_000,
      now: options.now ?? Date.now,
    };
    this.strategyOrderRowsStatement = database.prepare(`SELECT strategy_leg AS leg, symbol, side, quantity, executed_quantity, strategy_clip, reduce_only
      FROM execution_orders WHERE strategy_id = ? ORDER BY created_at ASC, rowid ASC`);
    this.openStrategyOrderIdsStatement = database.prepare(`SELECT id FROM execution_orders
      WHERE strategy_id = ? AND state IN ('PENDING_SUBMIT', 'PENDING_CANCEL', 'NEW', 'OPEN', 'PARTIALLY_FILLED')`);
    this.instrumentConstraintsStatement = database.prepare(
      'SELECT tick_size, lot_size, min_size, min_notional FROM crossex_instruments WHERE symbol = ?',
    );
    this.latestLegOrderStatement = database.prepare(`SELECT state, quantity, executed_quantity, failure_reason
      FROM execution_orders
      WHERE strategy_id = ? AND strategy_leg = ? AND symbol = ? AND side = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`);
    this.unsubscribers.push(this.runtime.onFill((fill) => {
      if (!fill.strategyId) return;
      this.invalidateLedger(fill.strategyId);
      const actor = this.actors.get(fill.strategyId);
      if (actor) this.enqueue(actor, () => this.afterExecutionChange(actor));
    }));
    this.unsubscribers.push(this.runtime.onOrderUpdate((order) => {
      if (!order.strategyId) return;
      this.invalidateLedger(order.strategyId);
      const actor = this.actors.get(order.strategyId);
      if (!actor) return;
      if (isTerminalOrderState(order.state)) {
        for (const [intent, quote] of actor.quotes) {
          if (quote.orderId === order.id) actor.quotes.delete(intent);
        }
      }
      this.enqueue(actor, () => this.afterExecutionChange(actor));
    }));
  }

  start(): void {
    this.stopped = false;
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => { void this.tick(); }, this.options.tickIntervalMs);
      this.tickTimer.unref?.();
    }
    // Production always starts locked. Persisted strategies are attached only after the live-mode
    // route has reconciled/cancelled every pre-existing order and the user acknowledges the risk.
    if (this.session.liveTradingEnabled) this.activatePersistedStrategies();
  }

  async prepareForLiveActivation(): Promise<void> {
    const quiesced = await this.runtime.quiesceOpenOrders({ timeoutMs: this.options.orderTimeoutMs });
    if (quiesced.unresolved.length > 0) {
      throw new StrategyEngineError('strategy_recovery_unresolved', 409,
        quiesced.unresolved.map(({ order }) => order.id).join(','),
        { unresolvedOrders: unresolvedOrderDetails(quiesced.unresolved) });
    }
    for (const actor of this.actors.values()) actor.suspended = true;
    this.actors.clear();
    // A process may have exited while a pause/stop was waiting for remote cancellation. Once every
    // persisted order is confirmed terminal, finish that state transition before any RUNNING
    // strategy is allowed to resume.
    for (const record of this.runtime.listStrategies()) {
      if (record.status !== 'PAUSE_PENDING_REMOTE' && record.status !== 'STOP_PENDING_REMOTE') continue;
      const actor = this.attach(record, true);
      actor.quiesceTarget = record.status === 'PAUSE_PENDING_REMOTE' ? 'PAUSED' : 'STOPPED';
      actor.quiesceReason = 'Recovered pending safety transition after restart';
      await this.maintainQuiesce(actor);
      if (this.actors.has(record.id)) {
        throw new StrategyEngineError('strategy_recovery_unresolved', 409, record.id, {
          strategyId: record.id,
          unresolvedOrders: unresolvedOrderDetails(actor.unresolvedOrders),
        });
      }
    }
  }

  activatePersistedStrategies(credentialProfileId?: string | null): void {
    if (!this.session.liveTradingEnabled) return;
    for (const record of this.runtime.listStrategies()) {
      if (record.status !== 'RUNNING') continue;
      if (credentialProfileId !== undefined
        && record.accountProfileId !== credentialProfileId
        // Legacy rows without an owner are considered part of the active account until reviewed.
        && record.accountProfileId !== null) continue;
      if (this.actors.has(record.id)) continue;
      this.attach(record);
      this.runtime.addStrategyLog(record.id, 'info', 'Strategy resumed', 'Live mode enabled after order reconciliation', '—', 'Monitoring live spreads');
    }
  }

  async suspendForTradingLock(): Promise<Array<{ order: ExecutionOrder; reason: string }>> {
    for (const actor of this.actors.values()) actor.suspended = true;
    await Promise.all([...this.actors.values()].map((actor) => actor.queue.catch(() => undefined)));
    const result = await this.runtime.quiesceOpenOrders({ timeoutMs: this.options.orderTimeoutMs });
    if (result.unresolved.length === 0) {
      for (const actor of this.actors.values()) actor.quotes.clear();
      this.actors.clear();
    }
    return result.unresolved;
  }

  /**
   * A saved strategy belongs to the account on which it was created. Credential replacement can
   * point at a different Gate account even when the user reuses the same connection label, so a
   * successful credential mutation must make persisted RUNNING strategies non-resumable before
   * the new profile can become active.
   */
  runningStrategiesForCredentialProfile(credentialProfileId?: string | null): StrategyRecord[] {
    return this.runtime.listStrategies().filter((record) => record.status === 'RUNNING'
      && (credentialProfileId === undefined
        || record.accountProfileId === credentialProfileId
        // Legacy strategies are treated as belonging to the account active during migration.
        || record.accountProfileId === null));
  }

  pauseRunningStrategiesForCredentialChange(credentialProfileId?: string | null): number {
    const running = this.runningStrategiesForCredentialProfile(credentialProfileId);
    if (running.length === 0) return 0;
    const updatedAt = new Date().toISOString();
    const update = this.database.prepare(`UPDATE execution_strategies
      SET status = 'PAUSED', updated_at = ?
      WHERE id = ? AND status = 'RUNNING'`);
    this.database.transaction(() => {
      for (const record of running) update.run(updatedAt, record.id);
    })();
    for (const actor of this.actors.values()) actor.suspended = true;
    this.actors.clear();
    this.ledgerCache.clear();
    for (const record of running) {
      this.runtime.addStrategyLog(record.id, 'warning', 'Strategy paused',
        'Account credentials changed', '—', 'Manual review required before trading this strategy again');
      this.runtime.emitStrategyUpdate(this.runtime.getStrategy(record.id));
    }
    return running.length;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.tickRun?.catch(() => undefined);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const actor of this.actors.values()) actor.suspended = true;
    await Promise.all([...this.actors.values()].map((actor) => actor.queue.catch(() => undefined)));
    const result = await this.runtime.quiesceOpenOrders({ timeoutMs: this.options.orderTimeoutMs });
    for (const { order, reason } of result.unresolved) {
      if (!order.strategyId) continue;
      this.runtime.addStrategyLog(order.strategyId, 'error', 'Shutdown cancellation pending',
        'Remote cancellation not confirmed', '—', `${order.id} · ${reason}`);
    }
    this.actors.clear();
    this.ledgerCache.clear();
  }

  listActiveStrategyIds(): string[] {
    return [...this.actors.keys()];
  }

  async startStrategy(
    raw: unknown,
    account: { profileId: string; label: string } | null = null,
  ): Promise<StrategyRecord> {
    const input = CreateStrategyInputSchema.parse(raw);
    // Grid strategies remain readable/resumable for historical compatibility, but the product no
    // longer allows creating new premium grids.
    if (input.kind === 'premium' && input.grid) {
      throw new StrategyEngineError('premium_grid_mode_removed', 400);
    }
    if (input.kind === 'auto' && input.takeProfitBps && input.entryBps && new Decimal(input.takeProfitBps).gte(new Decimal(input.entryBps))) {
      throw new StrategyEngineError('take_profit_must_be_below_entry', 400);
    }
    if (input.kind === 'premium' && !input.grid && !input.reduceOnly
      && input.entryPremiumPct !== undefined && input.takeProfitPremiumPct !== undefined) {
      const entry = new Decimal(input.entryPremiumPct);
      const takeProfit = new Decimal(input.takeProfitPremiumPct);
      // Short premium (SELL the ADR) profits as the premium falls; long premium as it rises.
      if (input.leftSide === 'SELL' && takeProfit.gte(entry)) throw new StrategyEngineError('take_profit_must_be_below_entry', 400);
      if (input.leftSide === 'BUY' && takeProfit.lte(entry)) throw new StrategyEngineError('take_profit_must_be_above_entry', 400);
    }
    if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
    const running = this.runtime.listStrategies().filter((strategy) => strategy.status === 'RUNNING');
    if (running.length >= 10) throw new StrategyEngineError('too_many_running_strategies', 409);
    let marginPreflight = { requiredMargin: '0', availableMargin: '0' };
    if (input.closePlan) {
      for (const target of input.closePlan.targets) {
        if (!this.markets.market(target.symbol) && !this.markets.ensureMarket?.(target.symbol)) {
          throw new StrategyEngineError('unknown_strategy_market', 400);
        }
      }
      this.validateClosePlanOrderSizes(input);
      await this.runtime.prepareReduceOnlyStrategy(input.closePlan.targets.map((target) => ({
        symbol: target.symbol,
        venue: target.symbol.split('_', 1)[0] ?? '',
        side: target.side,
        leverage: '1',
        estimatedQuantity: target.quantity,
        estimatedPrice: '0',
        positionSide: target.positionSide,
      })));
    } else {
      const legs = legsOf(input);
      for (const leg of [legs.left, legs.right]) {
        if (!this.markets.market(leg.symbol) && !this.markets.ensureMarket?.(leg.symbol)) {
          throw new StrategyEngineError('unknown_strategy_market', 400);
        }
      }
      this.validateStrategyOrderSizes(input, legs);
      marginPreflight = await this.prepareStrategy(input, legs);
    }
    const prefix = input.closePlan ? 'CLOSE' : input.kind === 'auto' ? 'AUTO' : input.kind === 'premium' ? 'PREM' : 'PAIR';
    const id = `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress,
      filled_quantity, filled_left, filled_right, open_position, credential_profile_id,
      credential_profile_label, created_at, updated_at, stopped_at)
      VALUES (?, ?, 'live', 'RUNNING', ?, 0, '0', '0', '0', '0', ?, ?, ?, ?, NULL)`)
      .run(id, input.kind, JSON.stringify(input), account?.profileId ?? null, account?.label ?? null, now, now);
    const shortPremium = input.leftSide === 'SELL';
    const hedgeModeLabel = input.hedgeMode === 'EQUAL_NOTIONAL' ? 'equal-notional hedge' : 'share-ratio hedge';
    const startCondition = input.closePlan
      ? `${input.closePlan.orderCount} reduce-only slices · ${input.closePlan.intervalSeconds}s interval`
      : input.kind === 'premium'
      ? input.grid
        ? `Grid ${input.gridLevels} × ${input.gridStepPct}% from ${input.entryPremiumPct}% premium · ${hedgeModeLabel}`
        : input.reduceOnly
          ? `Reduce existing positions at ${shortPremium ? '≥' : '≤'} ${input.entryPremiumPct}% premium · ${hedgeModeLabel}`
          : `Enter ${shortPremium ? '≥' : '≤'} ${input.entryPremiumPct}% · exit ${shortPremium ? '≤' : '≥'} ${input.takeProfitPremiumPct}% premium · ${hedgeModeLabel}`
      : input.kind === 'auto'
        ? `Enter ≥ ${input.entryBps} bps · exit ≤ ${input.takeProfitBps} bps`
        : `Enter ≥ ${input.entryBps} bps`;
    this.runtime.addStrategyLog(id, 'info', 'Strategy started', startCondition,
      input.closePlan ? `${input.closePlan.targets.length} position${input.closePlan.targets.length === 1 ? '' : 's'}` : `${input.perOrderQuantity} ${input.asset}`,
      input.closePlan
        ? 'Timed reduce-only close · existing positions validated before scheduling'
        : input.reduceOnly
        ? 'Reduce-only mode · existing positions validated on both legs'
        : `Leverage ${input.leftLeverage}× / ${input.rightLeverage}× · reserved margin ${marginPreflight.requiredMargin} of ${marginPreflight.availableMargin}`);
    const record = this.runtime.getStrategy(id);
    this.attach(record);
    this.runtime.emitStrategyUpdate(record);
    return record;
  }

  async stopStrategy(id: string): Promise<StrategyRecord> {
    const record = this.runtime.getStrategy(id);
    let actor = this.actors.get(id);
    if (!actor && ['RUNNING', 'PAUSE_PENDING_REMOTE', 'STOP_PENDING_REMOTE'].includes(record.status)) {
      actor = this.attach(record, true);
    }
    if (actor) {
      actor.suspended = true;
      actor.quiesceTarget = 'STOPPED';
      actor.quiesceReason = 'Manual stop';
      await actor.queue.catch(() => undefined);
      const finished = await this.finishQuiesce(actor);
      if (!finished) throw new StrategyEngineError('strategy_stop_pending_remote', 409);
    } else if (record.status === 'PAUSED') {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE execution_strategies SET status = 'STOPPED', stopped_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    }
    const stopped = this.runtime.getStrategy(id);
    this.runtime.emitStrategyUpdate(stopped);
    return stopped;
  }

  async resumeStrategy(id: string, credentialProfileId: string): Promise<StrategyRecord> {
    if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
    const record = this.runtime.getStrategy(id);
    if (record.status !== 'PAUSED') throw new StrategyEngineError('strategy_not_paused', 409);
    if (record.accountProfileId !== null && record.accountProfileId !== credentialProfileId) {
      throw new StrategyEngineError('strategy_account_not_active', 409);
    }
    if (this.actors.has(id)) throw new StrategyEngineError('strategy_already_active', 409);
    if (this.runtime.listStrategies().filter((strategy) => strategy.status === 'RUNNING').length >= 10) {
      throw new StrategyEngineError('too_many_running_strategies', 409);
    }

    // PAUSED normally means every order was already confirmed terminal. Re-prove that invariant
    // here so a stale or externally modified database row can never re-arm live execution while
    // an older remote order is still working.
    const quiesced = await this.runtime.quiesceOpenOrders({
      strategyId: id,
      timeoutMs: this.options.orderTimeoutMs,
    });
    if (quiesced.unresolved.length > 0) {
      throw new StrategyEngineError('strategy_resume_unresolved_orders', 409,
        quiesced.unresolved.map(({ order }) => order.id).join(','));
    }

    const config = record.config;
    if (config.closePlan) {
      for (const target of config.closePlan.targets) {
        if (!this.markets.market(target.symbol) && !this.markets.ensureMarket?.(target.symbol)) {
          throw new StrategyEngineError('unknown_strategy_market', 400);
        }
      }
      this.validateClosePlanOrderSizes(config);
      await this.runtime.prepareReduceOnlyStrategy(config.closePlan.targets.map((target) => ({
        symbol: target.symbol,
        venue: target.symbol.split('_', 1)[0] ?? '',
        side: target.side,
        leverage: '1',
        estimatedQuantity: target.quantity,
        estimatedPrice: '0',
        positionSide: target.positionSide,
      })));
    } else {
      const legs = legsOf(config);
      for (const leg of [legs.left, legs.right]) {
        if (!this.markets.market(leg.symbol) && !this.markets.ensureMarket?.(leg.symbol)) {
          throw new StrategyEngineError('unknown_strategy_market', 400);
        }
      }
      this.validateStrategyOrderSizes(config, legs);
      await this.prepareStrategy(config, legs);
    }

    // Re-check after the asynchronous account and order preflights. Another request may have
    // locked trading, resumed this strategy, or consumed the final running-strategy slot in the
    // meantime.
    if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
    const current = this.runtime.getStrategy(id);
    if (current.status !== 'PAUSED') throw new StrategyEngineError('strategy_not_paused', 409);
    if (current.accountProfileId !== null && current.accountProfileId !== credentialProfileId) {
      throw new StrategyEngineError('strategy_account_not_active', 409);
    }
    if (this.runtime.listStrategies().filter((strategy) => strategy.status === 'RUNNING').length >= 10) {
      throw new StrategyEngineError('too_many_running_strategies', 409);
    }

    const now = new Date().toISOString();
    const updated = this.database.prepare(`UPDATE execution_strategies
      SET status = 'RUNNING', stopped_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'PAUSED'`).run(now, id);
    if (updated.changes !== 1) throw new StrategyEngineError('strategy_not_paused', 409);
    this.runtime.addStrategyLog(id, 'info', 'Strategy resumed', 'Manual resume', '—', 'Preflight passed · monitoring live spreads');
    const resumed = this.runtime.getStrategy(id);
    this.attach(resumed);
    this.runtime.emitStrategyUpdate(resumed);
    return resumed;
  }

  async updatePremiumTakeProfit(id: string, raw: unknown): Promise<StrategyRecord> {
    const input = UpdatePremiumTakeProfitInputSchema.parse(raw);
    if (!this.session.liveTradingEnabled) throw new StrategyEngineError('live_trading_locked', 403);
    const record = this.runtime.getStrategy(id);
    if (record.kind !== 'premium' || record.config.grid || record.config.reduceOnly) {
      throw new StrategyEngineError('take_profit_update_not_supported', 400);
    }
    if (record.status !== 'RUNNING') {
      throw new StrategyEngineError('strategy_not_running', 409);
    }
    this.validatePremiumTakeProfit(record.config, input);

    const actor = this.actors.get(id);
    if (!actor) throw new StrategyEngineError('strategy_not_active', 409);

    // Serialize the change with trigger evaluation so no tick can observe a database config that
    // differs from the live actor config.
    const update = actor.queue.then(() => {
      const current = this.runtime.getStrategy(id);
      if (current.status !== 'RUNNING') {
        throw new StrategyEngineError('strategy_not_running', 409);
      }
      this.validatePremiumTakeProfit(current.config, input);
      const previousTakeProfit = current.config.takeProfitPremiumPct;
      const nextConfig: CreateStrategyInput = {
        ...current.config,
        takeProfitPremiumPct: input.takeProfitPremiumPct,
      };
      const now = new Date().toISOString();
      this.database.transaction(() => {
        this.database.prepare('UPDATE execution_strategies SET config_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(nextConfig), now, id);
        this.runtime.addStrategyLog(id, 'info', 'Take-profit updated',
          `${previousTakeProfit}% → ${input.takeProfitPremiumPct}%`, '—', 'Monitoring live premium');
      })();
      actor.config = nextConfig;
      this.invalidateLedger(id);
      const updated = this.runtime.getStrategy(id);
      this.runtime.emitStrategyUpdate(updated);
      return updated;
    });
    actor.queue = update.then(() => undefined, () => undefined);
    return update;
  }

  /** Evaluate every active strategy once. Exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.tickRun) {
      // Keep only one follow-up pass. Further interval ticks are superseded because that pending
      // pass will already observe newer market and execution state.
      this.tickRequested = true;
      return this.tickRun;
    }
    const run = this.drainTicks();
    this.tickRun = run;
    try {
      await run;
    } finally {
      if (this.tickRun === run) this.tickRun = null;
    }
  }

  private async drainTicks(): Promise<void> {
    do {
      this.tickRequested = false;
      await this.tickOnce();
    } while (this.tickRequested && !this.stopped);
  }

  private async tickOnce(): Promise<void> {
    for (const actor of [...this.actors.values()]) {
      this.enqueue(actor, () => actor.suspended ? this.maintainQuiesce(actor) : this.evaluate(actor));
    }
    await Promise.all([...this.actors.values()].map((actor) => actor.queue.catch(() => undefined)));
  }

  private attach(record: StrategyRecord, suspended = false): StrategyActor {
    this.invalidateLedger(record.id);
    const actor: StrategyActor = {
      id: record.id, config: record.config, kind: record.kind, status: record.status,
      busy: false, queue: Promise.resolve(), quotes: new Map(), repairAttempts: 0,
      lastRepairAt: 0, failureCount: 0, cooldownUntil: 0, lastQuoteAt: 0,
      suspended, quiesceTarget: null, quiesceReason: null, unresolvedOrders: [], createdAt: Date.parse(record.createdAt),
      lastCloseAt: Date.parse(record.updatedAt),
    };
    this.actors.set(record.id, actor);
    return actor;
  }

  private validatePremiumTakeProfit(config: CreateStrategyInput, input: UpdatePremiumTakeProfitInput): void {
    const entry = new Decimal(config.entryPremiumPct ?? '0');
    const takeProfit = new Decimal(input.takeProfitPremiumPct);
    if (config.leftSide === 'SELL' && takeProfit.gte(entry)) {
      throw new StrategyEngineError('take_profit_must_be_below_entry', 400);
    }
    if (config.leftSide === 'BUY' && takeProfit.lte(entry)) {
      throw new StrategyEngineError('take_profit_must_be_above_entry', 400);
    }
  }

  /**
   * Price the strategy's entire configured capacity, not just its first clip. This prevents any
   * paired or continuously accumulating strategy from launching with enough margin for one order
   * but not for the maximum exposure the user authorized.
   */
  private async prepareStrategy(
    config: CreateStrategyInput,
    legs: { left: LegDefinition; right: LegDefinition },
  ): Promise<{ requiredMargin: string; availableMargin: string }> {
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) throw new StrategyEngineError('strategy_market_data_unavailable', 409);
    const { left: leftMarket, right: rightMarket } = pair;
    const executablePrice = (market: LiveMarket, side: 'BUY' | 'SELL') =>
      new Decimal(side === 'BUY' ? market.askPrice : market.bidPrice);
    const leftPrice = executablePrice(leftMarket, legs.left.side);
    const rightPrice = executablePrice(rightMarket, legs.right.side);
    if (!leftPrice.gt(0) || !rightPrice.gt(0)) {
      throw new StrategyEngineError('strategy_market_data_unavailable', 409);
    }
    const target = this.strategyTarget(config);
    const leftNotional = target.mul(leftPrice);
    const rightQuantity = config.kind !== 'premium'
      ? target
      : this.equalNotional(config)
        ? leftNotional.div(rightPrice)
        : target.div(adrRatioOf(config));
    const plannedLegs = [
      {
        symbol: legs.left.symbol,
        venue: legs.left.venue,
        side: legs.left.side,
        leverage: config.leftLeverage,
        estimatedQuantity: target.toString(),
        estimatedPrice: leftPrice.toString(),
      },
      {
        symbol: legs.right.symbol,
        venue: legs.right.venue,
        side: legs.right.side,
        leverage: config.rightLeverage,
        estimatedQuantity: rightQuantity.toString(),
        estimatedPrice: rightPrice.toString(),
      },
    ];
    if (config.reduceOnly) {
      await this.runtime.prepareReduceOnlyStrategy(plannedLegs);
      return { requiredMargin: '0', availableMargin: '0' };
    }
    return this.runtime.prepareStrategyMargin(plannedLegs);
  }

  private enqueue(actor: StrategyActor, work: () => Promise<void>): void {
    actor.queue = actor.queue.then(work).catch((error: unknown) => {
      this.runtime.addStrategyLog(actor.id, 'error', 'Strategy engine error', '—', '—',
        error instanceof Error ? error.message.slice(0, 200) : 'unknown error');
    });
  }

  private freshMarket(symbol: string): LiveMarket | null {
    if (this.markets.connectionState && this.markets.connectionState() !== 'healthy') return null;
    const market = this.markets.market(symbol);
    if (!market || market.source !== 'gate_crossex_websocket') return null;
    const sourceTimestamp = Date.parse(market.updatedAt);
    const receivedTimestamp = Date.parse(market.receivedAt);
    const age = this.options.now() - sourceTimestamp;
    const transportLag = receivedTimestamp - sourceTimestamp;
    if (!Number.isFinite(age)
      || !Number.isFinite(transportLag)
      || age > this.options.marketFreshnessMs
      || age < -this.options.futureQuoteToleranceMs
      || transportLag > this.options.marketMaxTransportLagMs) return null;
    return market;
  }

  private freshMarketPair(
    leftSymbol: string,
    rightSymbol: string,
  ): { left: LiveMarket; right: LiveMarket } | null {
    const left = this.freshMarket(leftSymbol);
    const right = this.freshMarket(rightSymbol);
    if (!left || !right) return null;
    return { left, right };
  }

  private strategyLedger(strategyId: string): StrategyLedgerCache {
    const cached = this.ledgerCache.get(strategyId);
    // Execution events invalidate immediately. This TTL provides periodic durable reconciliation
    // for any missed or legacy update path without returning to per-tick database scans.
    if (cached && this.options.now() - cached.loadedAt < 5_000) return cached;
    const loaded: StrategyLedgerCache = {
      loadedAt: this.options.now(),
      rows: this.strategyOrderRowsStatement.all(strategyId) as StrategyOrderRow[],
    };
    this.ledgerCache.set(strategyId, loaded);
    return loaded;
  }

  private invalidateLedger(strategyId: string): void {
    this.ledgerCache.delete(strategyId);
  }

  /**
   * Exit state is derived from durable order history so a restarted backend cannot re-enter a
   * premium strategy after take profit has begun. Checking both the side and reduce-only flag
   * avoids mistaking a reduce-only entry configuration for a take-profit order.
   */
  private premiumExitStarted(actor: StrategyActor): boolean {
    if (actor.kind !== 'premium') return false;
    const ledger = this.strategyLedger(actor.id);
    const configKey = JSON.stringify(actor.config);
    if (ledger.configKey === configKey && ledger.premiumExitStarted !== undefined) {
      return ledger.premiumExitStarted;
    }
    const legs = legsOf(actor.config);
    const started = ledger.rows.some((row) => row.reduce_only === 1 && (
      (row.leg === 'left' && row.side === oppositeSide(legs.left.side))
      || (row.leg === 'right' && row.side === oppositeSide(legs.right.side))
    ));
    ledger.configKey = configKey;
    ledger.premiumExitStarted = started;
    return started;
  }

  private equalNotional(config: CreateStrategyInput): boolean {
    return config.kind === 'premium' && config.hedgeMode === 'EQUAL_NOTIONAL';
  }

  /**
   * Executed exposure per leg in left-leg (ADR) units, plus the raw right-leg venue shares.
   * SHARE_RATIO (and non-premium) strategies convert right-leg fills through the fixed ratio.
   * EQUAL_NOTIONAL clips have no strategy-wide conversion — each clip's hedge was sized at its
   * own execution prices — so right-leg fills convert through their clip's intended ratio.
   */
  private legExposures(strategyId: string, config: CreateStrategyInput): { left: Decimal; right: Decimal; rightShares: Decimal } {
    const ledger = this.strategyLedger(strategyId);
    const configKey = JSON.stringify(config);
    if (ledger.configKey === configKey && ledger.exposure) return ledger.exposure;
    const rows = ledger.rows;
    const fixedRatio = adrRatioOf(config);
    let left = ZERO;
    let right = ZERO;
    let rightShares = ZERO;
    if (!this.equalNotional(config)) {
      for (const row of rows) {
        const signed = signedExecuted(row);
        if (row.leg === 'left') left = left.plus(signed);
        else if (row.leg === 'right') {
          rightShares = rightShares.plus(signed);
          right = right.plus(signed.mul(fixedRatio));
        }
      }
      const exposure = { left, right, rightShares };
      ledger.configKey = configKey;
      ledger.exposure = exposure;
      return exposure;
    }
    for (const group of clipGroups(rows)) {
      const clipConversion = clipRatio(group, fixedRatio);
      for (const row of group.rows) {
        const signed = signedExecuted(row);
        if (row.leg === 'left') left = left.plus(signed);
        else if (row.leg === 'right') {
          rightShares = rightShares.plus(signed);
          right = right.plus(signed.div(clipConversion));
        }
      }
    }
    const exposure = { left, right, rightShares };
    ledger.configKey = configKey;
    ledger.exposure = exposure;
    return exposure;
  }

  /** Per-clip hedge shortfalls for equal-notional strategies, oldest clip first. */
  private clipShortfalls(strategyId: string, config: CreateStrategyInput): Array<{ clip: string | null; k: Decimal; lagging: 'left' | 'right'; delta: Decimal }> {
    const ledger = this.strategyLedger(strategyId);
    const configKey = JSON.stringify(config);
    if (ledger.configKey === configKey && ledger.shortfalls) return ledger.shortfalls;
    const fixedRatio = adrRatioOf(config);
    const shortfalls: Array<{ clip: string | null; k: Decimal; lagging: 'left' | 'right'; delta: Decimal }> = [];
    for (const group of clipGroups(ledger.rows)) {
      const k = clipRatio(group, fixedRatio);
      let left = ZERO;
      let rightConverted = ZERO;
      for (const row of group.rows) {
        const signed = signedExecuted(row);
        if (row.leg === 'left') left = left.plus(signed);
        else if (row.leg === 'right') rightConverted = rightConverted.plus(signed.div(k));
      }
      if (left.plus(rightConverted).abs().lte(QUANTITY_EPSILON)) continue;
      const lagging = left.abs().lt(rightConverted.abs()) ? 'left' : 'right';
      const laggingExposure = lagging === 'left' ? left : rightConverted;
      const otherExposure = lagging === 'left' ? rightConverted : left;
      shortfalls.push({ clip: group.clip, k, lagging, delta: otherExposure.neg().minus(laggingExposure) });
    }
    ledger.configKey = configKey;
    ledger.shortfalls = shortfalls;
    return shortfalls;
  }

  /** Aggregate unhedged quantity in ADR units — per clip for equal-notional, global otherwise. */
  private hedgeImbalance(strategyId: string, config: CreateStrategyInput, exposure: { left: Decimal; right: Decimal }): Decimal {
    if (this.equalNotional(config)) {
      return this.clipShortfalls(strategyId, config).reduce((sum, shortfall) => sum.plus(shortfall.delta.abs()), ZERO);
    }
    return exposure.left.plus(exposure.right).abs();
  }

  private matchedQuantity(exposure: { left: Decimal; right: Decimal }): Decimal {
    if (exposure.left.isZero() || exposure.right.isZero()) return ZERO;
    if (exposure.left.isNegative() === exposure.right.isNegative()) return ZERO;
    return Decimal.min(exposure.left.abs(), exposure.right.abs());
  }

  private openStrategyOrders(strategyId: string, excludeIds: Set<string>): ExecutionOrder[] {
    const ledger = this.strategyLedger(strategyId);
    ledger.openOrderIds ??= (this.openStrategyOrderIdsStatement.all(strategyId) as Array<{ id: string }>)
      .map((row) => row.id);
    return ledger.openOrderIds.filter((id) => !excludeIds.has(id)).map((id) => this.runtime.getOrder(id));
  }

  private constraintsFor(symbol: string): InstrumentConstraints {
    const cached = this.constraintCache.get(symbol);
    if (cached && this.options.now() - cached.cachedAt < 5 * 60_000) return cached.value;
    const row = this.instrumentConstraintsStatement.get(symbol) as {
      tick_size: string;
      lot_size: string;
      min_size: string;
      min_notional: string | null;
    } | undefined;
    const value: InstrumentConstraints = {
      tickSize: row?.tick_size ?? null,
      lotSize: row?.lot_size ?? null,
      minSize: row?.min_size ?? null,
      minNotional: row?.min_notional ?? null,
    };
    // Do not cache a miss: the catalog may be fetched immediately after a startup/API preflight.
    if (row) this.constraintCache.set(symbol, { value, cachedAt: this.options.now() });
    return value;
  }

  private orderSizeError(symbol: string, quantity: Decimal, price?: Decimal): StrategyEngineError | null {
    const constraints = this.constraintsFor(symbol);
    if (!constraints.minSize || !constraints.lotSize) {
      return new StrategyEngineError('strategy_instrument_constraints_unavailable', 409, symbol);
    }
    const minimum = new Decimal(constraints.minSize);
    if (minimum.gt(0) && quantity.lt(minimum)) {
      return new StrategyEngineError(
        'strategy_order_below_minimum_size',
        400,
        `${symbol}: ${quantity.toString()} < ${constraints.minSize}`,
      );
    }
    const lot = new Decimal(constraints.lotSize);
    if (lot.gt(0) && !quantity.mod(lot).isZero()) {
      return new StrategyEngineError(
        'strategy_order_invalid_lot_size',
        400,
        `${symbol}: ${quantity.toString()} must be a multiple of ${constraints.lotSize}`,
      );
    }
    if (price && constraints.minNotional) {
      const minimumNotional = new Decimal(constraints.minNotional);
      const notional = quantity.mul(price);
      if (minimumNotional.gt(0) && notional.lt(minimumNotional)) {
        return new StrategyEngineError(
          'strategy_order_below_minimum_notional',
          400,
          `${symbol}: ${notional.toString()} < ${constraints.minNotional}`,
        );
      }
    }
    return null;
  }

  private executablePrice(symbol: string, side: 'BUY' | 'SELL'): Decimal | null {
    const market = this.freshMarket(symbol);
    if (!market) return null;
    const price = new Decimal(side === 'BUY' ? market.askPrice : market.bidPrice);
    return price.gt(0) ? price : null;
  }

  private marketOrderSizeError(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: Decimal,
  ): StrategyEngineError | null {
    const price = this.executablePrice(symbol, side);
    if (!price && this.constraintsFor(symbol).minNotional) {
      return new StrategyEngineError('strategy_market_data_unavailable', 409, symbol);
    }
    return this.orderSizeError(symbol, quantity, price ?? undefined);
  }

  /**
   * Validate every possible configured entry clip, including a smaller final remainder. This is
   * deliberately authoritative and runs against the locally cached exchange instrument catalog;
   * an execution strategy cannot start when either selected venue's constraints are unavailable.
   */
  private validateStrategyOrderSizes(
    config: CreateStrategyInput,
    legs: { left: LegDefinition; right: LegDefinition },
  ): void {
    const perOrder = new Decimal(config.perOrderQuantity);
    const target = this.strategyTarget(config);
    const firstClip = Decimal.min(perOrder, target);
    const remainder = target.mod(perOrder);
    const leftClips = remainder.gt(QUANTITY_EPSILON) && !remainder.eq(firstClip)
      ? [firstClip, remainder]
      : [firstClip];

    let equalNotionalRatio: Decimal | null = null;
    if (this.equalNotional(config)) {
      const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
      if (!pair) throw new StrategyEngineError('strategy_market_data_unavailable', 409);
      const leftPrice = new Decimal(legs.left.side === 'BUY' ? pair.left.askPrice : pair.left.bidPrice);
      const rightPrice = new Decimal(legs.right.side === 'BUY' ? pair.right.askPrice : pair.right.bidPrice);
      if (!leftPrice.gt(0) || !rightPrice.gt(0)) throw new StrategyEngineError('strategy_market_data_unavailable', 409);
      equalNotionalRatio = leftPrice.div(rightPrice);
    }

    for (const leftQuantity of leftClips) {
      const leftError = this.marketOrderSizeError(legs.left.symbol, legs.left.side, leftQuantity);
      if (leftError) throw leftError;
      const rightRaw = equalNotionalRatio
        ? leftQuantity.mul(equalNotionalRatio)
        : leftQuantity.div(adrRatioOf(config));
      const rightQuantity = roundToStep(rightRaw, this.constraintsFor(legs.right.symbol).lotSize, 'down');
      const rightError = this.marketOrderSizeError(legs.right.symbol, legs.right.side, rightQuantity);
      if (rightError) throw rightError;
    }
  }

  private closePlanSlices(config: CreateStrategyInput, targetIndex: number): Decimal[] {
    const plan = config.closePlan;
    if (!plan) return [];
    const target = plan.targets[targetIndex];
    if (!target) return [];
    const total = new Decimal(target.quantity);
    const lotText = this.constraintsFor(target.symbol).lotSize;
    const base = roundToStep(total.div(plan.orderCount), lotText, 'down');
    if (!base.gt(QUANTITY_EPSILON)) {
      throw new StrategyEngineError('strategy_order_below_minimum_size', 400, target.symbol);
    }
    return Array.from({ length: plan.orderCount }, (_, index) => index === plan.orderCount - 1
      ? total.minus(base.mul(plan.orderCount - 1))
      : base);
  }

  private validateClosePlanOrderSizes(config: CreateStrategyInput): void {
    const plan = config.closePlan;
    if (!plan) return;
    plan.targets.forEach((target, targetIndex) => {
      for (const quantity of this.closePlanSlices(config, targetIndex)) {
        const error = this.marketOrderSizeError(target.symbol, target.side, quantity);
        if (error) throw error;
      }
    });
  }

  private closePlanSubmittedClips(actor: StrategyActor): number {
    return new Set(this.strategyLedger(actor.id).rows
      .map((row) => row.strategy_clip)
      .filter((clip): clip is string => Boolean(clip?.startsWith('close-')))).size;
  }

  private closePlanExecutedQuantity(actor: StrategyActor, targetIndex: number): Decimal {
    return this.strategyLedger(actor.id).rows
      .filter((row) => row.leg === `close-${targetIndex}`)
      .reduce((sum, row) => sum.plus(row.executed_quantity || '0'), ZERO);
  }

  private closePlanResiduals(actor: StrategyActor): Array<{ symbol: string; quantity: Decimal }> {
    const plan = actor.config.closePlan;
    if (!plan) return [];
    return plan.targets.map((target, targetIndex) => ({
      symbol: target.symbol,
      quantity: Decimal.max(ZERO, new Decimal(target.quantity).minus(this.closePlanExecutedQuantity(actor, targetIndex))),
    })).filter((target) => target.quantity.gt(QUANTITY_EPSILON));
  }

  private completeClosePlan(actor: StrategyActor): void {
    const now = new Date().toISOString();
    actor.status = 'COMPLETED';
    this.database.prepare(`UPDATE execution_strategies SET status = 'COMPLETED', progress = 100,
      stopped_at = ?, updated_at = ? WHERE id = ?`).run(now, now, actor.id);
    this.runtime.addStrategyLog(actor.id, 'info', 'Strategy completed',
      `${actor.config.closePlan?.orderCount ?? 0} timed close slices`, '100%', 'All reduce-only close orders filled');
    this.actors.delete(actor.id);
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
  }

  private async evaluateClosePlan(actor: StrategyActor): Promise<void> {
    const plan = actor.config.closePlan;
    if (!plan || actor.busy) return;
    if (this.openStrategyOrders(actor.id, new Set()).length > 0) return;

    const clipIndex = this.closePlanSubmittedClips(actor);
    if (clipIndex >= plan.orderCount) {
      const residuals = this.closePlanResiduals(actor);
      if (residuals.length > 0) {
        await this.pause(actor, `Timed close ended with residual positions: ${residuals.map((item) => `${item.quantity.toString()} ${item.symbol}`).join(', ')}`);
        return;
      }
      this.completeClosePlan(actor);
      return;
    }
    const dueAt = clipIndex === 0 ? actor.createdAt : actor.lastCloseAt + plan.intervalSeconds * 1_000;
    if (this.options.now() < dueAt) return;

    const submissions = plan.targets.flatMap((target, targetIndex) => {
      const executed = this.closePlanExecutedQuantity(actor, targetIndex);
      const remaining = Decimal.max(ZERO, new Decimal(target.quantity).minus(executed));
      if (!remaining.gt(QUANTITY_EPSILON)) return [];
      const planned = this.closePlanSlices(actor.config, targetIndex)[clipIndex] ?? ZERO;
      const quantity = clipIndex === plan.orderCount - 1 ? remaining : Decimal.min(planned, remaining);
      if (!quantity.gt(QUANTITY_EPSILON)) return [];
      const sizeError = this.marketOrderSizeError(target.symbol, target.side, quantity);
      if (sizeError) throw sizeError;
      return [{ target, targetIndex, quantity }];
    });
    if (submissions.length === 0) {
      this.completeClosePlan(actor);
      return;
    }

    actor.busy = true;
    const clip = `close-${clipIndex}`;
    this.runtime.addStrategyLog(actor.id, 'info', 'Timed close triggered',
      `Slice ${clipIndex + 1}/${plan.orderCount}`, `${submissions.length} position${submissions.length === 1 ? '' : 's'}`,
      `Submitting reduce-only market orders · next interval ${plan.intervalSeconds}s`);
    try {
      const results = await Promise.allSettled(submissions.map(({ target, targetIndex, quantity }) =>
        this.runtime.createOrder({
          symbol: target.symbol,
          side: target.side,
          type: 'MARKET',
          timeInForce: 'IOC',
          quantity: quantity.toString(),
          reduceOnly: true,
          positionSide: target.positionSide,
        }, { strategyId: actor.id, strategyLeg: `close-${targetIndex}`, strategyClip: clip })));
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const accepted = results.filter((result): result is PromiseFulfilledResult<ExecutionOrder> => result.status === 'fulfilled');
      const settled = await Promise.all(accepted.map((result) => this.runtime.awaitTerminalOrder(result.value.id, this.options.orderTimeoutMs)));
      const incomplete = settled.filter((order) => order.state !== 'FILLED');
      if (rejected.length > 0 || incomplete.length > 0) {
        const reason = rejected[0]?.reason instanceof Error
          ? rejected[0].reason.message
          : incomplete[0]?.failureReason ?? incomplete[0]?.state ?? 'order not filled';
        this.runtime.addStrategyLog(actor.id, 'error', 'Timed close slice failed',
          `Slice ${clipIndex + 1}/${plan.orderCount}`, `${settled.length}/${submissions.length} orders accepted`, String(reason).slice(0, 200));
        await this.pause(actor, `Timed close slice ${clipIndex + 1} failed; review remaining positions`);
        return;
      }

      const now = new Date().toISOString();
      actor.lastCloseAt = this.options.now();
      const progress = ((clipIndex + 1) / plan.orderCount) * 100;
      this.database.prepare(`UPDATE execution_strategies SET progress = ?, filled_quantity = ?, updated_at = ? WHERE id = ?`)
        .run(progress, String(clipIndex + 1), now, actor.id);
      this.runtime.addStrategyLog(actor.id, 'info', 'Timed close slice executed',
        `Slice ${clipIndex + 1}/${plan.orderCount}`, `${settled.length} order${settled.length === 1 ? '' : 's'}`,
        settled.map((order) => `${order.side} ${order.symbol} ${order.executedQuantity}`).join(' · '));
      if (clipIndex + 1 >= plan.orderCount) {
        const residuals = this.closePlanResiduals(actor);
        if (residuals.length > 0) {
          await this.pause(actor, `Timed close ended with residual positions: ${residuals.map((item) => `${item.quantity.toString()} ${item.symbol}`).join(', ')}`);
        } else {
          this.completeClosePlan(actor);
        }
      }
      else this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
    } finally {
      actor.busy = false;
    }
  }

  /** Maximum matched quantity the strategy may accumulate, in left-leg units. */
  private strategyTarget(config: CreateStrategyInput): Decimal {
    if (config.kind === 'position') return new Decimal(config.totalAmount ?? '0');
    if (config.kind === 'premium' && config.grid) {
      return new Decimal(config.perOrderQuantity).mul(config.gridLevels ?? 0);
    }
    return new Decimal(config.maxPosition ?? '0');
  }

  private persist(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): StrategyRecord {
    const matched = this.matchedQuantity(exposure);
    const target = this.strategyTarget(actor.config);
    const progress = target.gt(0) ? Decimal.min(matched.div(target).mul(100), new Decimal(100)).toNumber() : 0;
    this.database.prepare(`UPDATE execution_strategies SET status = ?, progress = ?, filled_quantity = ?,
      filled_left = ?, filled_right = ?, open_position = ?, updated_at = ? WHERE id = ?`).run(
      actor.status, progress, matched.toString(), exposure.left.abs().toString(), exposure.right.abs().toString(),
      actor.kind === 'position' || actor.config.reduceOnly ? '0' : matched.toString(), new Date().toISOString(), actor.id);
    const record = this.runtime.getStrategy(actor.id);
    this.runtime.emitStrategyUpdate(record);
    return record;
  }

  private async afterExecutionChange(actor: StrategyActor): Promise<void> {
    if (!this.actors.has(actor.id)) return;
    if (actor.config.closePlan) return;
    const exposure = this.legExposures(actor.id, actor.config);
    this.persist(actor, exposure);
    await this.reconcileExposure(actor, exposure);
    if (actor.suspended) {
      await this.finishQuiesce(actor);
      return;
    }
    if (actor.status !== 'RUNNING') return;
    await this.checkCompletion(actor);
  }

  private async checkCompletion(actor: StrategyActor): Promise<void> {
    if (actor.status !== 'RUNNING') return;
    if (actor.config.closePlan) return;
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    let condition: string | null = null;
    let result = '';
    let details = '';
    if (actor.kind === 'position') {
      const total = new Decimal(actor.config.totalAmount ?? '0');
      const imbalance = exposure.left.plus(exposure.right);
      if (total.gt(0) && matched.gte(total.minus(QUANTITY_EPSILON)) && imbalance.abs().lte(QUANTITY_EPSILON)) {
        condition = `Target ${total.toString()} ${actor.config.asset}`;
        result = matched.toString();
        details = 'Both legs fully executed and hedged';
      }
    } else if (actor.kind === 'premium' && actor.config.reduceOnly) {
      const target = this.strategyTarget(actor.config);
      const imbalance = exposure.left.plus(exposure.right);
      if (target.gt(0) && matched.gte(target.minus(QUANTITY_EPSILON))
        && imbalance.abs().lte(QUANTITY_EPSILON)) {
        condition = `Reduce-only target ${target.toString()} ${actor.config.asset}`;
        result = `${matched.toString()} ${actor.config.asset}`;
        details = 'Existing exposure reduced in configured per-order clips';
      }
    } else if (actor.kind === 'premium' && this.premiumExitStarted(actor)) {
      const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
      const noOpenOrders = this.openStrategyOrders(actor.id, quoteOrderIds).length === 0;
      const flat = exposure.left.abs().lte(QUANTITY_EPSILON)
        && exposure.right.abs().lte(QUANTITY_EPSILON)
        && exposure.rightShares.abs().lte(QUANTITY_EPSILON);
      if (noOpenOrders && flat) {
        condition = 'Take-profit lifecycle';
        result = `0 ${actor.config.asset} remaining`;
        details = 'All opened exposure was closed; this strategy will not re-enter';
      }
    }
    if (condition === null) return;
    if (!(await this.cancelQuotes(actor))) return;
    actor.status = 'COMPLETED';
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE execution_strategies SET status = 'COMPLETED', progress = 100,
      open_position = '0', stopped_at = ?, updated_at = ? WHERE id = ?`).run(now, now, actor.id);
    this.runtime.addStrategyLog(actor.id, 'info', 'Strategy completed', condition, result, details);
    this.actors.delete(actor.id);
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
  }

  private async pause(actor: StrategyActor, reason: string): Promise<void> {
    actor.suspended = true;
    actor.quiesceTarget = 'PAUSED';
    actor.quiesceReason = reason;
    await this.finishQuiesce(actor);
  }

  private async cancelQuotes(actor: StrategyActor): Promise<boolean> {
    let allTerminal = true;
    for (const [intent, quote] of [...actor.quotes]) {
      if (quote.cancelling) continue;
      quote.cancelling = true;
      try {
        const pending = await this.runtime.cancelOrder(quote.orderId);
        const settled = isTerminalOrderState(pending.state)
          ? pending
          : await this.runtime.awaitTerminalOrder(quote.orderId, this.options.orderTimeoutMs);
        if (isTerminalOrderState(settled.state)) actor.quotes.delete(intent);
        else {
          quote.cancelling = false;
          allTerminal = false;
        }
      } catch (error) {
        if (error instanceof TradingRuntimeError && error.code === 'order_not_cancellable') actor.quotes.delete(intent);
        else {
          quote.cancelling = false;
          allTerminal = false;
        }
      }
    }
    return allTerminal;
  }

  private async maintainQuiesce(actor: StrategyActor): Promise<void> {
    if (!this.actors.has(actor.id)) return;
    const exposure = this.legExposures(actor.id, actor.config);
    this.persist(actor, exposure);
    await this.reconcileExposure(actor, exposure);
    await this.finishQuiesce(actor);
  }

  private async finishQuiesce(actor: StrategyActor): Promise<boolean> {
    const target = actor.quiesceTarget;
    if (!target) return false;
    const result = await this.runtime.quiesceOpenOrders({
      strategyId: actor.id,
      timeoutMs: this.options.orderTimeoutMs,
    });
    actor.unresolvedOrders = result.unresolved;
    if (result.unresolved.length > 0) {
      actor.status = target === 'PAUSED' ? 'PAUSE_PENDING_REMOTE' : 'STOP_PENDING_REMOTE';
      const now = new Date().toISOString();
      this.database.prepare('UPDATE execution_strategies SET status = ?, updated_at = ? WHERE id = ?')
        .run(actor.status, now, actor.id);
      this.runtime.addStrategyLog(actor.id, 'error',
        target === 'PAUSED' ? 'Strategy pause pending' : 'Strategy stop pending',
        'Remote cancellation not confirmed', '—',
        `${actor.quiesceReason ?? 'Safety quiesce'} · unresolved ${result.unresolved.map(({ order, reason }) => `${order.id} (${reason})`).join(', ')}`);
      this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
      return false;
    }
    actor.quotes.clear();
    actor.status = target;
    const now = new Date().toISOString();
    if (target === 'STOPPED') {
      this.database.prepare("UPDATE execution_strategies SET status = 'STOPPED', stopped_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, actor.id);
      const exposure = this.legExposures(actor.id, actor.config);
      const residual = this.hedgeImbalance(actor.id, actor.config, exposure);
      this.runtime.addStrategyLog(actor.id, residual.gt(QUANTITY_EPSILON) ? 'warning' : 'info', 'Strategy stopped',
        actor.quiesceReason ?? 'Manual stop', '—', residual.gt(QUANTITY_EPSILON)
          ? `Stopped with unhedged residual ${residual.toString()} ${actor.config.asset}; review positions`
          : 'Stopped after all remote orders reached terminal state');
    } else {
      this.database.prepare("UPDATE execution_strategies SET status = 'PAUSED', updated_at = ? WHERE id = ?")
        .run(now, actor.id);
      this.runtime.addStrategyLog(actor.id, 'error', 'Strategy paused', '—', '—',
        actor.quiesceReason ?? 'Safety pause');
    }
    this.actors.delete(actor.id);
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(actor.id));
    return true;
  }

  private entrySpreadBps(config: CreateStrategyInput): { spread: Decimal; sell: LiveMarket; buy: LiveMarket } | null {
    const legs = legsOf(config);
    const sellLeg = legs.left.side === 'SELL' ? legs.left : legs.right;
    const buyLeg = legs.left.side === 'BUY' ? legs.left : legs.right;
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const sell = sellLeg.leg === 'left' ? pair.left : pair.right;
    const buy = buyLeg.leg === 'left' ? pair.left : pair.right;
    const sellBid = new Decimal(sell.bidPrice);
    const buyAsk = new Decimal(buy.askPrice);
    if (!sellBid.gt(0) || !buyAsk.gt(0)) return null;
    return { spread: sellBid.minus(buyAsk).div(buyAsk).mul(BPS), sell, buy };
  }

  private exitSpreadBps(config: CreateStrategyInput): Decimal | null {
    const legs = legsOf(config);
    const sellLeg = legs.left.side === 'SELL' ? legs.left : legs.right;
    const buyLeg = legs.left.side === 'BUY' ? legs.left : legs.right;
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const sell = sellLeg.leg === 'left' ? pair.left : pair.right;
    const buy = buyLeg.leg === 'left' ? pair.left : pair.right;
    const sellAsk = new Decimal(sell.askPrice);
    const buyBid = new Decimal(buy.bidPrice);
    if (!sellAsk.gt(0) || !buyBid.gt(0)) return null;
    return sellAsk.minus(buyBid).div(buyBid).mul(BPS);
  }

  /**
   * Executable ADR premium in percent — ADR price over ratio-scaled local price, minus one —
   * plus the two leg prices it was computed from, using the bid/ask each leg would actually
   * trade at for the given intent. Null while either quote is missing or stale.
   */
  private premiumQuote(config: CreateStrategyInput, intent: QuoteIntent): {
    premium: Decimal;
    adrPrice: Decimal;
    hedgePrice: Decimal;
  } | null {
    const legs = legsOf(config);
    const adrSide = intent === 'entry' ? legs.left.side : oppositeSide(legs.left.side);
    const hedgeSide = intent === 'entry' ? legs.right.side : oppositeSide(legs.right.side);
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const { left: adr, right: hedge } = pair;
    const adrPrice = new Decimal(adrSide === 'SELL' ? adr.bidPrice : adr.askPrice);
    const hedgePrice = new Decimal(hedgeSide === 'SELL' ? hedge.bidPrice : hedge.askPrice);
    const fairValue = hedgePrice.div(adrRatioOf(config));
    if (!adrPrice.gt(0) || !fairValue.gt(0)) return null;
    return {
      premium: adrPrice.div(fairValue).minus(1).mul(100),
      adrPrice,
      hedgePrice,
    };
  }

  private async evaluate(actor: StrategyActor): Promise<void> {
    if (!this.actors.has(actor.id) || actor.status !== 'RUNNING' || actor.busy) return;
    if (actor.config.closePlan) {
      await this.evaluateClosePlan(actor);
      return;
    }
    const exposure = this.legExposures(actor.id, actor.config);
    await this.reconcileExposure(actor, exposure);
    await this.checkCompletion(actor);
    if (!this.actors.has(actor.id) || actor.status !== 'RUNNING') return;
    if (actor.busy || actor.status !== 'RUNNING') return;
    if (this.options.now() < actor.cooldownUntil) return;
    if (actor.config.executionMethod === 'MAKER_TAKER') {
      await this.evaluateMakerQuotes(actor);
    } else if (actor.kind === 'premium') {
      await this.evaluatePremiumClip(actor);
    } else {
      await this.evaluateTakerClip(actor);
    }
    await this.checkCompletion(actor);
  }

  /**
   * Premium bot single lifecycle. Quantities are in ADR units throughout. It accumulates entry
   * clips until take profit first triggers. That transition is durable and one-way: after it
   * begins, the strategy only reduces the quantity that actually opened, completes at zero, and
   * can never start a second entry cycle.
   */
  private async evaluatePremiumClip(actor: StrategyActor): Promise<void> {
    const config = actor.config;
    const exposure = this.legExposures(actor.id, config);
    if (this.premiumExitStarted(actor)) {
      await this.ensurePremiumFlat(actor, exposure);
      return;
    }
    if (exposure.left.plus(exposure.right).abs().gt(QUANTITY_EPSILON)) return;
    const matched = this.matchedQuantity(exposure);
    const perOrder = new Decimal(config.perOrderQuantity);
    const shortPremium = config.leftSide === 'SELL';
    const entryLevel = new Decimal(config.entryPremiumPct ?? '0');
    const step = config.grid ? new Decimal(config.gridStepPct ?? '0') : ZERO;
    const target = this.strategyTarget(config);
    const inFlight = this.inFlightQuantity(actor, new Set());
    const capacity = Decimal.max(ZERO, target.minus(matched).minus(inFlight));

    // Equal-notional hedges are sized from the same executable prices that trigger the clip; the
    // exit unwinds the actually-held share ratio so both legs converge to zero together.
    const equalNotional = this.equalNotional(config);
    const entryQuote = this.premiumQuote(config, 'entry');
    if (entryQuote !== null && capacity.gt(QUANTITY_EPSILON)) {
      const entryPremium = entryQuote.premium;
      // The rung currently being filled: completed rungs plus any partial one gate at its level.
      const rung = config.grid ? matched.plus(inFlight).div(perOrder).plus(RUNG_EPSILON).floor() : ZERO;
      const level = shortPremium ? entryLevel.plus(step.mul(rung)) : entryLevel.minus(step.mul(rung));
      const triggered = shortPremium ? entryPremium.gte(level) : entryPremium.lte(level);
      if (triggered) {
        // Cap grid clips at the current rung's remaining size so one wide tick cannot jump rungs.
        const rungRoom = config.grid ? perOrder.mul(rung.plus(1)).minus(matched).minus(inFlight) : perOrder;
        const quantity = Decimal.min(perOrder, rungRoom, capacity);
        if (quantity.gt(QUANTITY_EPSILON)) {
          const entryHedge = equalNotional ? quantity.mul(entryQuote.adrPrice).div(entryQuote.hedgePrice) : undefined;
          await this.executeTakerClip(actor, 'entry', quantity,
            `Premium ${entryPremium.toFixed(2)}% ${shortPremium ? '≥' : '≤'} ${level.toFixed(2)}%`
            + ` · quotes ${entryQuote.adrPrice.toString()} / ${entryQuote.hedgePrice.toString()}`,
          entryHedge);
          return;
        }
      }
    }

    // Reduce-only premium strategies use the entry threshold as a close trigger. They stop after
    // the configured amount is reduced and never run the opposite-side take-profit lifecycle.
    if (config.reduceOnly) return;
    if (!matched.gt(QUANTITY_EPSILON)) return;
    const exitQuote = this.premiumQuote(config, 'exit');
    if (exitQuote === null) return;
    const exitPremium = exitQuote.premium;
    const exitHedgeFor = (quantity: Decimal): Decimal | undefined => equalNotional && exposure.left.abs().gt(QUANTITY_EPSILON)
      ? quantity.mul(exposure.rightShares.abs()).div(exposure.left.abs())
      : undefined;
    if (config.grid) {
      const topRung = matched.div(perOrder).minus(RUNG_EPSILON).ceil().minus(1);
      const rungEntry = shortPremium ? entryLevel.plus(step.mul(topRung)) : entryLevel.minus(step.mul(topRung));
      const exitLevel = shortPremium ? rungEntry.minus(step) : rungEntry.plus(step);
      const triggered = shortPremium ? exitPremium.lte(exitLevel) : exitPremium.gte(exitLevel);
      if (triggered) {
        const quantity = Decimal.min(matched.minus(perOrder.mul(topRung)), perOrder, matched);
        if (quantity.gt(QUANTITY_EPSILON)) {
          await this.executeTakerClip(actor, 'exit', quantity,
            `Premium ${exitPremium.toFixed(2)}% ${shortPremium ? '≤' : '≥'} rung ${topRung.plus(1).toString()} exit ${exitLevel.toFixed(2)}%`
            + ` · quotes ${exitQuote.adrPrice.toString()} / ${exitQuote.hedgePrice.toString()}`,
          exitHedgeFor(quantity));
        }
      }
    } else {
      const takeProfitLevel = new Decimal(config.takeProfitPremiumPct ?? '0');
      const triggered = shortPremium ? exitPremium.lte(takeProfitLevel) : exitPremium.gte(takeProfitLevel);
      if (triggered) {
        const quantity = Decimal.min(perOrder, matched);
        if (quantity.gt(QUANTITY_EPSILON)) {
          await this.executeTakerClip(actor, 'exit', quantity,
            `Premium ${exitPremium.toFixed(2)}% ${shortPremium ? '≤' : '≥'} ${takeProfitLevel.toFixed(2)}%`
            + ` · quotes ${exitQuote.adrPrice.toString()} / ${exitQuote.hedgePrice.toString()}`,
          exitHedgeFor(quantity));
        }
      }
    }
  }

  /**
   * Open strategy-order quantity in left-leg (ADR) units (right-leg orders multiply by the
   * ratio). Equal-notional right-leg orders convert slightly above their true ADR equivalent,
   * which only makes the capacity estimate more conservative while a clip is in flight.
   */
  private inFlightQuantity(actor: StrategyActor, excludeIds: Set<string>): Decimal {
    const ratio = adrRatioOf(actor.config);
    return this.openStrategyOrders(actor.id, excludeIds).reduce((sum, order) => {
      const quantity = new Decimal(order.quantity);
      return sum.plus(order.strategyLeg === 'right' ? quantity.mul(ratio) : quantity);
    }, ZERO);
  }

  private remainingEntryCapacity(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): Decimal {
    const matched = this.matchedQuantity(exposure);
    const inFlight = this.inFlightQuantity(actor, new Set([...actor.quotes.values()].map((quote) => quote.orderId)));
    const target = this.strategyTarget(actor.config);
    return Decimal.max(ZERO, target.minus(matched).minus(inFlight));
  }

  /**
   * A sub-minimum maker-taker residual can be absorbed by the next normal clip. When the maker
   * leg is already the excess leg, reduce its next quote by that residual; the taker repair then
   * remains one full configured clip. When the taker leg is excess, leave the maker clip whole
   * and the subsequent hedge naturally shrinks by the residual instead.
   */
  private carryAdjustedMakerQuantity(
    actor: StrategyActor,
    exposure: { left: Decimal; right: Decimal },
    quantity: Decimal,
  ): Decimal {
    if (actor.kind !== 'position') return quantity;
    const imbalance = exposure.left.plus(exposure.right);
    if (imbalance.abs().lte(QUANTITY_EPSILON)) return quantity;
    const legs = legsOf(actor.config);
    const makerLeg = (actor.config.makerLeg ?? 'left') === 'left' ? legs.left : legs.right;
    const makerDirection = makerLeg.side === 'BUY' ? ONE : ONE.neg();
    if (imbalance.mul(makerDirection).lte(QUANTITY_EPSILON)) return quantity;
    return Decimal.max(ZERO, quantity.minus(imbalance.abs()));
  }

  private async evaluateTakerClip(actor: StrategyActor): Promise<void> {
    const entry = this.entrySpreadBps(actor.config);
    const exposure = this.legExposures(actor.id, actor.config);
    const imbalance = exposure.left.plus(exposure.right);
    if (imbalance.abs().gt(QUANTITY_EPSILON)) return;
    const matched = this.matchedQuantity(exposure);
    const perOrder = new Decimal(actor.config.perOrderQuantity);

    if (entry && entry.spread.gte(new Decimal(actor.config.entryBps ?? '0'))) {
      const capacity = this.remainingEntryCapacity(actor, exposure);
      const quantity = Decimal.min(perOrder, capacity);
      if (quantity.gt(QUANTITY_EPSILON)) {
        await this.executeTakerClip(actor, 'entry', quantity, `Spread ${entry.spread.toFixed(2)} bps ≥ ${actor.config.entryBps} bps`);
        return;
      }
    }
    if (actor.kind === 'auto' && actor.config.takeProfitBps && matched.gt(QUANTITY_EPSILON)) {
      const exitSpread = this.exitSpreadBps(actor.config);
      if (exitSpread && exitSpread.lte(new Decimal(actor.config.takeProfitBps))) {
        const quantity = Decimal.min(perOrder, matched);
        if (quantity.gt(QUANTITY_EPSILON)) {
          await this.executeTakerClip(actor, 'exit', quantity, `Exit spread ${exitSpread.toFixed(2)} bps ≤ ${actor.config.takeProfitBps} bps`);
        }
      }
    }
  }

  private legsForIntent(actor: StrategyActor, intent: QuoteIntent): { left: LegDefinition; right: LegDefinition } {
    const legs = legsOf(actor.config);
    if (intent === 'entry') return legs;
    return {
      left: { ...legs.left, side: oppositeSide(legs.left.side) },
      right: { ...legs.right, side: oppositeSide(legs.right.side) },
    };
  }

  private async executeTakerClip(actor: StrategyActor, intent: QuoteIntent, quantity: Decimal, condition: string, rightQuantityOverride?: Decimal): Promise<void> {
    const legs = this.legsForIntent(actor, intent);
    // Default hedge sizing is the strategy's fixed conversion; premium callers override it for
    // equal-notional clips (entry: priced hedge, exit: proportional unwind).
    const rightRaw = rightQuantityOverride ?? quantity.div(adrRatioOf(actor.config));
    const rightQuantity = roundToStep(rightRaw, this.constraintsFor(legs.right.symbol).lotSize, 'down');
    const sizeError = this.marketOrderSizeError(legs.left.symbol, legs.left.side, quantity)
      ?? this.marketOrderSizeError(legs.right.symbol, legs.right.side, rightQuantity);
    if (sizeError) {
      await this.pause(actor, `Order-size compliance check failed: ${sizeError.label ?? sizeError.code}`);
      return;
    }
    const clip = `clip-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    actor.busy = true;
    try {
      const reduceOnly = intent === 'exit' || actor.config.reduceOnly;
      const triggeredEvent = intent === 'exit' ? 'Take-profit triggered'
        : actor.config.reduceOnly ? 'Reduce-only triggered' : 'Entry triggered';
      this.runtime.addStrategyLog(actor.id, 'info', triggeredEvent, condition,
        `${quantity.toString()} ${actor.config.asset}`, 'Submitting both taker legs');
      const submissions = await Promise.allSettled([
        this.runtime.createOrder({ symbol: legs.left.symbol, side: legs.left.side, type: 'MARKET', timeInForce: 'IOC',
          quantity: quantity.toString(), reduceOnly }, { strategyId: actor.id, strategyLeg: 'left', strategyClip: clip }),
        this.runtime.createOrder({ symbol: legs.right.symbol, side: legs.right.side, type: 'MARKET', timeInForce: 'IOC',
          quantity: rightQuantity.toString(), reduceOnly }, { strategyId: actor.id, strategyLeg: 'right', strategyClip: clip }),
      ]);
      const accepted = submissions.filter((entry): entry is PromiseFulfilledResult<ExecutionOrder> => entry.status === 'fulfilled');
      const rejected = submissions.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (rejected.length > 0) {
        actor.failureCount += 1;
        const gateErrors = rejected.map((entry) => entry.reason).filter((reason): reason is GateApiError => reason instanceof GateApiError);
        const rateLimitWait = gateErrors
          .filter((error) => error.statusCode === 429)
          .reduce((longest, error) => Math.max(longest, error.retryAfterMs ?? 30_000), 0);
        actor.cooldownUntil = this.options.now() + Math.max(
          rateLimitWait,
          Math.min(60_000, 2_000 * 2 ** Math.min(4, actor.failureCount)),
        );
        this.runtime.addStrategyLog(actor.id, 'warning', 'Leg submission failed', condition, quantity.toString(),
          rejected.map((entry) => entry.reason instanceof Error ? entry.reason.message.slice(0, 120) : 'submit error').join(' · '));
        const insufficientMargin = gateErrors.some((error) => /(?:MARGIN|BALANCE)/.test(error.label));
        if (intent === 'entry' && insufficientMargin && accepted.length === 0) {
          await this.pause(actor, 'Order rejected for insufficient margin; strategy stopped retrying until manually reviewed');
        } else if (actor.failureCount >= 5) {
          await this.pause(actor, 'Five consecutive order submissions failed; check credentials, balances, and venue status');
        }
      } else {
        actor.failureCount = 0;
      }
      const settled = await Promise.all(accepted.map((entry) => this.runtime.awaitTerminalOrder(entry.value.id, this.options.orderTimeoutMs)));
      const left = settled.find((order) => order.strategyLeg === 'left');
      const right = settled.find((order) => order.strategyLeg === 'right');
      if (left?.state === 'FILLED' && right?.state === 'FILLED') {
        const executedEvent = intent === 'exit' ? 'Take-profit Executed'
          : actor.config.reduceOnly ? 'Reduce-only Executed' : 'Position open Executed';
        this.runtime.addStrategyLog(actor.id, 'info',
          executedEvent,
          condition, `${left.executedQuantity} ${actor.config.asset}`,
          `${left.side} ${left.symbol} ${left.executedQuantity} @ ${left.executedAveragePrice ?? '—'} · `
          + `${right.side} ${right.symbol} ${right.executedQuantity} @ ${right.executedAveragePrice ?? '—'}`);
      } else {
        // Preserve leg-level diagnostics when the clip did not complete cleanly.
        for (const order of settled) {
          const failure = failureSummary(order.failureReason);
          this.runtime.addStrategyLog(actor.id, isTerminalOrderState(order.state) && order.state === 'FILLED' ? 'info' : 'warning',
            `${order.strategyLeg === 'left' ? 'Left' : 'Right'} leg ${order.state.toLowerCase()}`,
            condition, `${order.executedQuantity}/${order.quantity} ${actor.config.asset}`,
            `${order.side} ${order.symbol} · ${failure ?? `avg ${order.executedAveragePrice ?? '—'}`}`);
        }
      }
    } finally {
      actor.busy = false;
    }
    await this.afterExecutionChange(actor);
  }

  private desiredMakerPrice(actor: StrategyActor, intent: QuoteIntent): { price: Decimal; makerLeg: LegDefinition; takerLeg: LegDefinition } | null {
    const makerLegKey = actor.config.makerLeg ?? 'left';
    const legs = this.legsForIntent(actor, intent);
    const makerLeg = makerLegKey === 'left' ? legs.left : legs.right;
    const takerLeg = makerLegKey === 'left' ? legs.right : legs.left;
    const pair = this.freshMarketPair(legs.left.symbol, legs.right.symbol);
    if (!pair) return null;
    const makerMarket = makerLeg.leg === 'left' ? pair.left : pair.right;
    const takerMarket = takerLeg.leg === 'left' ? pair.left : pair.right;
    const threshold = intent === 'entry' ? new Decimal(actor.config.entryBps ?? '0') : new Decimal(actor.config.takeProfitBps ?? '0');
    const factor = threshold.div(BPS);
    const tick = this.constraintsFor(makerLeg.symbol).tickSize;
    let boundary: Decimal;
    if (intent === 'entry') {
      boundary = makerLeg.side === 'SELL'
        ? roundToStep(new Decimal(takerMarket.askPrice).mul(new Decimal(1).plus(factor)), tick, 'up')
        : roundToStep(new Decimal(takerMarket.bidPrice).mul(new Decimal(1).minus(factor)), tick, 'down');
    } else {
      boundary = makerLeg.side === 'BUY'
        ? roundToStep(new Decimal(takerMarket.bidPrice).mul(new Decimal(1).plus(factor)), tick, 'down')
        : roundToStep(new Decimal(takerMarket.askPrice).div(new Decimal(1).plus(factor)), tick, 'up');
    }
    // Join the maker venue's best queue whenever that price already satisfies the configured
    // spread. Otherwise rest at the spread boundary. A BUY never exceeds its maximum acceptable
    // price; a SELL never goes below its minimum acceptable price, so the POC order cannot cross
    // the maker book merely because the economic boundary lies through the best ask/bid.
    const makerTop = new Decimal(makerLeg.side === 'BUY' ? makerMarket.bidPrice : makerMarket.askPrice);
    const price = makerLeg.side === 'BUY'
      ? Decimal.min(boundary, makerTop)
      : Decimal.max(boundary, makerTop);
    if (!price.gt(0)) return null;
    return { price, makerLeg, takerLeg };
  }

  private async evaluateMakerQuotes(actor: StrategyActor): Promise<void> {
    const exposure = this.legExposures(actor.id, actor.config);
    const matched = this.matchedQuantity(exposure);
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    const intents: Array<{ intent: QuoteIntent; quantity: Decimal }> = [];
    const entryCapacity = this.remainingEntryCapacity(actor, exposure);
    if (entryCapacity.gt(QUANTITY_EPSILON)) {
      const entryQuantity = this.carryAdjustedMakerQuantity(actor, exposure, Decimal.min(perOrder, entryCapacity));
      if (entryQuantity.gt(QUANTITY_EPSILON)) intents.push({ intent: 'entry', quantity: entryQuantity });
    }
    if (actor.kind === 'auto' && actor.config.takeProfitBps && matched.gt(QUANTITY_EPSILON)) {
      intents.push({ intent: 'exit', quantity: Decimal.min(perOrder, matched) });
    }
    for (const [intent] of [...actor.quotes]) {
      if (!intents.some((candidate) => candidate.intent === intent)) {
        const quote = actor.quotes.get(intent);
        if (quote && !quote.cancelling) {
          quote.cancelling = true;
          try { await this.runtime.cancelOrder(quote.orderId); actor.quotes.delete(intent); }
          catch { quote.cancelling = false; }
        }
      }
    }
    for (const candidate of intents) {
      await this.maintainQuote(actor, candidate.intent, candidate.quantity);
    }
  }

  private async maintainQuote(actor: StrategyActor, intent: QuoteIntent, quantity: Decimal): Promise<void> {
    if (actor.status !== 'RUNNING') return;
    const desired = this.desiredMakerPrice(actor, intent);
    if (!desired) return;
    const existing = actor.quotes.get(intent);
    const now = this.options.now();
    if (existing) {
      if (existing.cancelling) return;
      const tick = this.constraintsFor(desired.makerLeg.symbol).tickSize;
      const tolerance = tick ? new Decimal(tick) : existing.price.mul('0.0001');
      const drifted = desired.price.minus(existing.price).abs().gte(tolerance);
      if (!drifted || now - existing.quotedAt < this.options.requoteIntervalMs) return;
      existing.cancelling = true;
      try {
        await this.runtime.cancelOrder(existing.orderId);
        actor.quotes.delete(intent);
      } catch (error) {
        if (error instanceof TradingRuntimeError && error.code === 'order_not_cancellable') actor.quotes.delete(intent);
        else existing.cancelling = false;
        return;
      }
    }
    if (now - actor.lastQuoteAt < this.options.requoteIntervalMs / 2) return;
    const lot = this.constraintsFor(desired.makerLeg.symbol).lotSize;
    const roundedQuantity = roundToStep(quantity, lot, 'down');
    const sizeError = this.orderSizeError(desired.makerLeg.symbol, roundedQuantity, desired.price);
    if (sizeError) {
      await this.pause(actor, `Order-size compliance check failed: ${sizeError.label ?? sizeError.code}`);
      return;
    }
    actor.busy = true;
    try {
      const reduceOnly = intent === 'exit' || actor.config.reduceOnly;
      const order = await this.runtime.createOrder({
        symbol: desired.makerLeg.symbol, side: desired.makerLeg.side, type: 'LIMIT', timeInForce: 'POC',
        quantity: roundedQuantity.toString(), price: desired.price.toString(), reduceOnly,
      }, { strategyId: actor.id, strategyLeg: desired.makerLeg.leg });
      actor.quotes.set(intent, { orderId: order.id, price: desired.price, quantity: roundedQuantity, quotedAt: now, cancelling: false });
      actor.lastQuoteAt = now;
      actor.failureCount = 0;
      this.runtime.addStrategyLog(actor.id, 'info', intent === 'entry' ? 'Maker quote placed' : 'Maker exit quote placed',
        `Post-only at ${desired.price.toString()}`, `${roundedQuantity.toString()} ${actor.config.asset}`,
        `${desired.makerLeg.side} ${desired.makerLeg.symbol}`);
    } catch (error) {
      actor.failureCount += 1;
      actor.cooldownUntil = this.options.now() + Math.min(60_000, 2_000 * 2 ** Math.min(4, actor.failureCount));
      this.runtime.addStrategyLog(actor.id, 'warning', 'Maker quote rejected', `Post-only at ${desired.price.toString()}`,
        roundedQuantity.toString(), error instanceof Error ? error.message.slice(0, 120) : 'submit error');
      if (actor.failureCount >= 5) {
        await this.pause(actor, 'Five consecutive maker quotes were rejected; check credentials, balances, and venue status');
      }
    } finally {
      actor.busy = false;
    }
  }

  /**
   * During the entry phase, repair the lagging leg to restore the configured hedge. Once a
   * premium take-profit order exists, the objective changes: reduce every remaining leg toward
   * zero instead of reopening a leg that already closed.
   */
  private async reconcileExposure(actor: StrategyActor, exposure: { left: Decimal; right: Decimal; rightShares: Decimal }): Promise<void> {
    if (actor.kind === 'premium' && this.premiumExitStarted(actor)) {
      await this.ensurePremiumFlat(actor, exposure);
      return;
    }
    await this.ensureHedged(actor, exposure);
  }

  /** Maximum hedge-leg quantity represented by one entry clip, used when only that leg remains. */
  private premiumRightClipLimit(actor: StrategyActor): Decimal {
    const fallback = new Decimal(actor.config.perOrderQuantity).div(adrRatioOf(actor.config));
    return this.strategyLedger(actor.id).rows
      .filter((row) => row.leg === 'right' && row.reduce_only === 0)
      .reduce((largest, row) => Decimal.max(largest, new Decimal(row.quantity)), fallback);
  }

  /**
   * Finish a latched premium exit one configured clip at a time. Quantities come from actual
   * executed exposure, including partial clips and one-leg failures, and every order is
   * reduce-only. A follow-up must never collapse the entire residual position into one order.
   */
  private async ensurePremiumFlat(
    actor: StrategyActor,
    exposure: { left: Decimal; right: Decimal; rightShares: Decimal },
  ): Promise<void> {
    if (actor.busy || (actor.status !== 'RUNNING' && !actor.suspended) || this.options.now() < actor.cooldownUntil) return;
    const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
    if (this.openStrategyOrders(actor.id, quoteOrderIds).length > 0) return;
    const legs = legsOf(actor.config);
    const perOrder = new Decimal(actor.config.perOrderQuantity);
    const leftRemaining = exposure.left.abs();
    const rightRemaining = exposure.rightShares.abs();
    const leftQuantity = roundToStep(
      Decimal.min(leftRemaining, perOrder),
      this.constraintsFor(legs.left.symbol).lotSize,
      'down',
    );
    // When both legs remain, preserve their actual residual proportion. If only the hedge leg
    // survived a failed exit, fall back to the largest requested hedge quantity of one entry clip.
    const rightRaw = leftRemaining.gt(QUANTITY_EPSILON) && leftQuantity.gt(QUANTITY_EPSILON)
      ? Decimal.min(rightRemaining, rightRemaining.mul(leftQuantity).div(leftRemaining))
      : Decimal.min(rightRemaining, this.premiumRightClipLimit(actor));
    const rightQuantity = roundToStep(rightRaw, this.constraintsFor(legs.right.symbol).lotSize, 'down');
    const candidates = [
      ...(leftQuantity.gt(QUANTITY_EPSILON) ? [{
        leg: legs.left,
        side: exposure.left.gt(0) ? 'SELL' as const : 'BUY' as const,
        quantity: leftQuantity,
      }] : []),
      ...(rightQuantity.gt(QUANTITY_EPSILON) ? [{
        leg: legs.right,
        side: exposure.rightShares.gt(0) ? 'SELL' as const : 'BUY' as const,
        quantity: rightQuantity,
      }] : []),
    ];
    if (candidates.length === 0) {
      actor.repairAttempts = 0;
      return;
    }
    const now = this.options.now();
    if (now - actor.lastRepairAt < this.options.repairCooldownMs) return;
    if (actor.repairAttempts >= 3) {
      await this.pause(actor, `Unable to close residual premium exposure after 3 attempts; manual review required`);
      return;
    }
    const clip = `exit-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    actor.busy = true;
    actor.lastRepairAt = now;
    actor.repairAttempts += 1;
    try {
      this.runtime.addStrategyLog(actor.id, 'info', 'Closing remaining exposure', 'Take profit already triggered',
        candidates.map(({ leg, quantity }) => `${quantity.toString()} ${leg.symbol}`).join(' · '),
        'Submitting reduce-only market orders');
      const submissions = await Promise.allSettled(candidates.map(({ leg, side, quantity }) => (
        this.runtime.createOrder({
          symbol: leg.symbol,
          side,
          type: 'MARKET',
          timeInForce: 'IOC',
          quantity: quantity.toString(),
          reduceOnly: true,
        }, { strategyId: actor.id, strategyLeg: leg.leg, strategyClip: clip, riskReducing: true })
      )));
      const accepted = submissions.filter((entry): entry is PromiseFulfilledResult<ExecutionOrder> => entry.status === 'fulfilled');
      const rejected = submissions.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (rejected.length > 0) {
        const gateErrors = rejected.map((entry) => entry.reason).filter((reason): reason is GateApiError => reason instanceof GateApiError);
        const rateLimitWait = gateErrors
          .filter((error) => error.statusCode === 429)
          .reduce((longest, error) => Math.max(longest, error.retryAfterMs ?? 30_000), 0);
        actor.cooldownUntil = this.options.now() + Math.max(
          rateLimitWait,
          Math.min(60_000, 2_000 * 2 ** Math.min(4, actor.repairAttempts)),
        );
        this.runtime.addStrategyLog(actor.id, 'warning', 'Residual close submission failed', 'Take profit already triggered',
          candidates.map(({ quantity }) => quantity.toString()).join(' / '),
          rejected.map((entry) => entry.reason instanceof Error ? entry.reason.message.slice(0, 120) : 'submit error').join(' · '));
      }
      const settled = await Promise.all(accepted.map((entry) => (
        this.runtime.awaitTerminalOrder(entry.value.id, this.options.orderTimeoutMs)
      )));
      if (rejected.length === 0 && settled.length === candidates.length
        && settled.every((order) => order.state === 'FILLED')) {
        // Successful clips are normal progress, not failed repair attempts. Resetting here lets
        // positions larger than three clips unwind fully while still bounding genuine retries.
        actor.repairAttempts = 0;
      }
      for (const order of settled) {
        this.runtime.addStrategyLog(actor.id, order.state === 'FILLED' ? 'info' : 'warning', 'Residual close settled',
          'Take profit already triggered', `${order.executedQuantity}/${order.quantity}`,
          `${order.side} ${order.symbol} · ${order.state}`);
      }
    } finally {
      actor.busy = false;
    }
    const refreshed = this.legExposures(actor.id, actor.config);
    if (refreshed.left.abs().lte(QUANTITY_EPSILON) && refreshed.rightShares.abs().lte(QUANTITY_EPSILON)) {
      actor.repairAttempts = 0;
    }
    this.persist(actor, refreshed);
  }

  /**
   * Keep the two legs hedged. Executable differences are repaired immediately; maker-taker dust
   * below venue constraints is carried into the next clip until the configured target is full,
   * when the excess leg is reduced without increasing the strategy's completed hedge.
   */
  private terminalPaddingQuantity(
    symbol: string,
    paddingSide: 'BUY' | 'SELL',
    trimSide: 'BUY' | 'SELL',
    residual: Decimal,
  ): Decimal | null {
    const constraints = this.constraintsFor(symbol);
    if (!constraints.minNotional || !constraints.lotSize || !constraints.minSize) return null;
    const minimumNotional = new Decimal(constraints.minNotional);
    const paddingPrice = this.executablePrice(symbol, paddingSide);
    const trimPrice = this.executablePrice(symbol, trimSide);
    if (!minimumNotional.gt(0) || !paddingPrice || !trimPrice) return null;
    const bufferedNotional = minimumNotional.mul(MIN_NOTIONAL_REPAIR_BUFFER);
    const minimumSize = new Decimal(constraints.minSize);
    const paddingForOpen = bufferedNotional.div(paddingPrice);
    const paddingForTrim = Decimal.max(ZERO, bufferedNotional.div(trimPrice).minus(residual));
    const padding = roundToStep(
      Decimal.max(minimumSize, paddingForOpen, paddingForTrim),
      constraints.lotSize,
      'up',
    );
    const trimQuantity = padding.plus(residual);
    if (this.marketOrderSizeError(symbol, paddingSide, padding)
      || this.marketOrderSizeError(symbol, trimSide, trimQuantity)) return null;
    return padding;
  }

  private async executeTerminalTopUpAndTrim(
    actor: StrategyActor,
    repairLeg: LegDefinition,
    trimSide: 'BUY' | 'SELL',
    residual: Decimal,
    clip: string,
  ): Promise<boolean> {
    const paddingSide = oppositeSide(trimSide);
    const paddingQuantity = this.terminalPaddingQuantity(
      repairLeg.symbol,
      paddingSide,
      trimSide,
      residual,
    );
    if (!paddingQuantity) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Residual top-up unavailable',
        `Terminal residual ${residual.toString()} ${actor.config.asset}`, residual.toString(),
        'Fresh prices or complete min-notional constraints unavailable');
      return false;
    }

    this.runtime.addStrategyLog(actor.id, 'info', 'Padding terminal residual',
      `Target filled; residual ${residual.toString()} ${actor.config.asset}`,
      `${paddingQuantity.toString()} ${actor.config.asset}`,
      `${paddingSide} ${repairLeg.symbol} market · 10% min-notional buffer`);
    const paddingOrder = await this.runtime.createOrder({
      symbol: repairLeg.symbol,
      side: paddingSide,
      type: 'MARKET',
      timeInForce: 'IOC',
      quantity: paddingQuantity.toString(),
      reduceOnly: false,
    }, { strategyId: actor.id, strategyLeg: repairLeg.leg, strategyClip: clip });
    const settledPadding = await this.runtime.awaitTerminalOrder(paddingOrder.id, this.options.orderTimeoutMs);
    const padded = new Decimal(settledPadding.executedQuantity || '0');
    this.runtime.addStrategyLog(actor.id, padded.gt(QUANTITY_EPSILON) ? 'info' : 'warning', 'Residual padding settled',
      `Terminal residual ${residual.toString()}`, `${settledPadding.executedQuantity}/${settledPadding.quantity}`,
      `${settledPadding.state} · ${failureSummary(settledPadding.failureReason) ?? `avg ${settledPadding.executedAveragePrice ?? '—'}`}`);
    if (!padded.gt(QUANTITY_EPSILON)) return false;

    const constraints = this.constraintsFor(repairLeg.symbol);
    const exactTrim = padded.plus(residual);
    const trimQuantity = roundToStep(exactTrim, constraints.lotSize, 'down');
    if (!trimQuantity.eq(exactTrim)) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Residual trim deferred',
        `Terminal residual ${residual.toString()}`, trimQuantity.toString(),
        `Exact trim ${exactTrim.toString()} is not aligned to ${constraints.lotSize ?? 'unknown'} lot size`);
      return false;
    }
    const trimError = this.marketOrderSizeError(repairLeg.symbol, trimSide, trimQuantity);
    if (trimError) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Residual trim deferred',
        `Terminal residual ${residual.toString()}`, trimQuantity.toString(), trimError.label ?? trimError.code);
      return false;
    }

    this.runtime.addStrategyLog(actor.id, 'info', 'Trimming padded residual',
      `Padding ${padded.toString()} + residual ${residual.toString()}`,
      `${trimQuantity.toString()} ${actor.config.asset}`,
      `${trimSide} ${repairLeg.symbol} market · reduce-only exact trim`);
    const trimOrder = await this.runtime.createOrder({
      symbol: repairLeg.symbol,
      side: trimSide,
      type: 'MARKET',
      timeInForce: 'IOC',
      quantity: trimQuantity.toString(),
      reduceOnly: true,
    }, { strategyId: actor.id, strategyLeg: repairLeg.leg, strategyClip: clip, riskReducing: true });
    const settledTrim = await this.runtime.awaitTerminalOrder(trimOrder.id, this.options.orderTimeoutMs);
    const complete = settledTrim.state === 'FILLED'
      && new Decimal(settledTrim.executedQuantity || '0').gte(trimQuantity.minus(QUANTITY_EPSILON));
    this.runtime.addStrategyLog(actor.id, complete ? 'info' : 'warning', 'Padded residual trim settled',
      `Terminal residual ${residual.toString()}`, `${settledTrim.executedQuantity}/${settledTrim.quantity}`,
      `${settledTrim.state} · ${failureSummary(settledTrim.failureReason) ?? `avg ${settledTrim.executedAveragePrice ?? '—'}`}`);
    return complete;
  }

  private async ensureHedged(actor: StrategyActor, exposure: { left: Decimal; right: Decimal }): Promise<void> {
    if (actor.busy || (actor.status !== 'RUNNING' && !actor.suspended)) return;
    // One repair target per pass: for equal-notional the oldest broken clip (each clip has its
    // own intended ratio), otherwise the global fixed-ratio imbalance. `k` is always the
    // right-shares-per-ADR-unit conversion used to size a right-leg repair order.
    const target = (() => {
      if (this.equalNotional(actor.config)) {
        const shortfalls = this.clipShortfalls(actor.id, actor.config);
        if (shortfalls.length === 0) return null;
        return { ...shortfalls[0], residual: shortfalls.reduce((sum, item) => sum.plus(item.delta.abs()), ZERO) };
      }
      const imbalance = exposure.left.plus(exposure.right);
      if (imbalance.abs().lte(QUANTITY_EPSILON)) return null;
      const lagging: 'left' | 'right' = exposure.left.abs().lt(exposure.right.abs()) ? 'left' : 'right';
      const laggingExposure = lagging === 'left' ? exposure.left : exposure.right;
      const otherExposure = lagging === 'left' ? exposure.right : exposure.left;
      return { clip: null, k: ONE.div(adrRatioOf(actor.config)), lagging, delta: otherExposure.neg().minus(laggingExposure), residual: imbalance.abs() };
    })();
    if (!target) {
      actor.repairAttempts = 0;
      return;
    }
    const quoteOrderIds = new Set([...actor.quotes.values()].map((quote) => quote.orderId));
    if (this.openStrategyOrders(actor.id, quoteOrderIds).length > 0) return;
    const now = this.options.now();
    if (now - actor.lastRepairAt < this.options.repairCooldownMs) return;
    if (actor.repairAttempts >= 3) {
      await this.pause(actor, `Unable to hedge residual exposure of ${target.residual.toString()} ${actor.config.asset} after 3 attempts; manual review required`);
      return;
    }
    const legs = legsOf(actor.config);
    const completedTarget = actor.kind === 'position' && this.matchedQuantity(exposure)
      .gte(this.strategyTarget(actor.config).minus(QUANTITY_EPSILON));
    if (completedTarget && actor.quotes.size > 0) return;
    let trimExcess = completedTarget;
    let repairLeg = trimExcess
      ? (target.lagging === 'left' ? legs.right : legs.left)
      : (target.lagging === 'left' ? legs.left : legs.right);
    let side: 'BUY' | 'SELL' = trimExcess
      ? (repairLeg.leg === 'left'
          ? (exposure.left.gt(0) ? 'SELL' : 'BUY')
          : (exposure.right.gt(0) ? 'SELL' : 'BUY'))
      : (target.delta.gt(0) ? 'BUY' : 'SELL');
    let lot = this.constraintsFor(repairLeg.symbol).lotSize;
    const venueDeltaFor = (leg: LegDefinition): Decimal => leg.leg === 'right'
      ? target.delta.abs().mul(target.k)
      : target.delta.abs();
    let desiredQuantity = roundToStep(venueDeltaFor(repairLeg), lot, 'down');
    let sizeError = desiredQuantity.gt(QUANTITY_EPSILON)
      ? this.marketOrderSizeError(repairLeg.symbol, side, desiredQuantity)
      : new StrategyEngineError('strategy_order_below_minimum_size', 400, repairLeg.symbol);

    // Before the target is full, do not manufacture extra volume for dust. A maker-taker strategy
    // carries this residual into its next quote; that next normal fill makes the opposite hedge
    // executable (for example 0.97 after a prior 0.03 overfill in a 1.00-HYPE clip).
    if (sizeError && !completedTarget && actor.kind === 'position'
      && actor.config.executionMethod === 'MAKER_TAKER') return;

    // Non-maker strategies cannot carry dust through a resting quote. Preserve the old safe
    // fallback for them: trim the excess leg directly when that exact quantity is executable.
    if (sizeError && !completedTarget) {
      if (actor.quotes.size > 0) return;
      repairLeg = target.lagging === 'left' ? legs.right : legs.left;
      side = repairLeg.leg === 'left'
        ? (exposure.left.gt(0) ? 'SELL' : 'BUY')
        : (exposure.right.gt(0) ? 'SELL' : 'BUY');
      lot = this.constraintsFor(repairLeg.symbol).lotSize;
      desiredQuantity = roundToStep(venueDeltaFor(repairLeg), lot, 'down');
      sizeError = desiredQuantity.gt(QUANTITY_EPSILON)
        ? this.marketOrderSizeError(repairLeg.symbol, side, desiredQuantity)
        : new StrategyEngineError('strategy_order_below_minimum_size', 400, repairLeg.symbol);
      if (sizeError) return;
      trimExcess = true;
    }
    if (completedTarget && sizeError?.code === 'strategy_order_below_minimum_notional'
      && actor.config.reduceOnly) {
      await this.pause(actor, 'Terminal residual is below minimum notional and cannot be padded in reduce-only mode');
      return;
    }
    const topUpRequired = completedTarget
      && sizeError?.code === 'strategy_order_below_minimum_notional';
    if (sizeError && !topUpRequired) return;
    const previous = this.latestLegOrderStatement.get(
      actor.id,
      repairLeg.leg,
      repairLeg.symbol,
      side,
    ) as { state: string; quantity: string; executed_quantity: string; failure_reason: string | null } | undefined;
    // Gate's account router explicitly recommends a smaller order for this terminal rejection.
    // Halve only after that exact zero-fill failure; a successful smaller clip becomes the latest
    // order, so the remaining residual continues normally instead of shrinking forever.
    const splitQuantity = previous?.state === 'FAIL'
      && new Decimal(previous.executed_quantity || '0').isZero()
      && isRouterCapacityFailure(previous.failure_reason)
      ? roundToStep(new Decimal(previous.quantity).div(2), lot, 'down')
      : null;
    const quantity = splitQuantity?.gt(QUANTITY_EPSILON) && splitQuantity.lt(desiredQuantity)
      ? splitQuantity
      : desiredQuantity;
    if (!quantity.gt(QUANTITY_EPSILON)) return;
    actor.busy = true;
    actor.lastRepairAt = now;
    actor.repairAttempts += 1;
    try {
      if (topUpRequired) {
        const dustClip = `dust-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        if (await this.executeTerminalTopUpAndTrim(actor, repairLeg, side, desiredQuantity, dustClip)) {
          actor.repairAttempts = 0;
        }
      } else {
        this.runtime.addStrategyLog(actor.id, 'info', trimExcess ? 'Trimming residual imbalance' : 'Hedging filled quantity',
          `Residual ${target.residual.toString()} ${actor.config.asset}`,
          quantity.toString(), `${side} ${repairLeg.symbol} market${trimExcess ? ' · reduce-only excess trim' : ''}`
          + (quantity.lt(desiredQuantity) ? ` · split after router rejected ${previous?.quantity}` : ''));
        const order = await this.runtime.createOrder({ symbol: repairLeg.symbol, side, type: 'MARKET', timeInForce: 'IOC',
          quantity: quantity.toString(), reduceOnly: trimExcess || actor.config.reduceOnly },
        { strategyId: actor.id, strategyLeg: repairLeg.leg, riskReducing: true,
          ...(target.clip ? { strategyClip: target.clip } : {}) });
        const settled = await this.runtime.awaitTerminalOrder(order.id, this.options.orderTimeoutMs);
        if (settled.state === 'FILLED') actor.repairAttempts = 0;
        const failure = failureSummary(settled.failureReason);
        this.runtime.addStrategyLog(actor.id, settled.state === 'FILLED' ? 'info' : 'warning',
          trimExcess ? 'Residual trim settled' : 'Hedge order settled',
          `Residual ${target.residual.toString()}`, `${settled.executedQuantity}/${settled.quantity}`,
          `${settled.state} · ${failure ?? `avg ${settled.executedAveragePrice ?? '—'}`}`);
      }
    } catch (error) {
      this.runtime.addStrategyLog(actor.id, 'warning', 'Hedge order failed', `Residual ${target.residual.toString()}`,
        quantity.toString(), error instanceof Error ? error.message.slice(0, 120) : 'submit error');
    } finally {
      actor.busy = false;
    }
    const refreshed = this.legExposures(actor.id, actor.config);
    if (this.hedgeImbalance(actor.id, actor.config, refreshed).lte(QUANTITY_EPSILON)) actor.repairAttempts = 0;
    this.persist(actor, refreshed);
  }
}
