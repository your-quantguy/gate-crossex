import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault, type GateCredentials } from './credential-vault.js';
import { GateApiError, type CrossExOrderRequest, type GateCrossExAccount, type GateCrossExOrder, type GateCrossExPortfolio, type GateCrossExRiskLimit, type GateCrossExSymbol, type GateFeeRate, type GateOrderActionResponse, type TradingCrossExGateway } from './crossex-client.js';
import type { LiveMarket } from './market-hub.js';
import { StrategyEngine, type MarketSource, type StrategyEngineOptions } from './strategy-engine.js';
import { TradingRuntime } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';

class ScriptedGateway implements TradingCrossExGateway {
  readonly createdOrders: Array<CrossExOrderRequest & { remoteId: string }> = [];
  readonly createAttempts: CrossExOrderRequest[] = [];
  readonly cancelledOrders: string[] = [];
  readonly leverageUpdates: Array<{ symbol: string; leverage: string }> = [];
  readonly leverageQueries: string[][] = [];
  readonly accountQueries: Array<string | null> = [];
  positions: GateCrossExPortfolio['positions'] = [];
  leverages: Record<string, string> = {};
  riskLimits: Record<string, GateCrossExRiskLimit['tiers']> = {};
  availableMargin = '1000000';
  accountAssets: GateCrossExAccount['assets'] = [];
  accountMode: 'CROSS_EXCHANGE' | 'ISOLATED_EXCHANGE' = 'CROSS_EXCHANGE';
  isolatedAvailableMargins: Record<string, string> = {};
  holdCancellations = false;
  private readonly failCreateBudget = new Map<string, number>();
  private readonly remoteStates = new Map<string, string>();
  private sequence = 0;

  failCreate(symbol: string, times: number): void {
    this.failCreateBudget.set(symbol, (this.failCreateBudget.get(symbol) ?? 0) + times);
  }

  async queryAccount(_credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount> {
    this.accountQueries.push(exchangeType ?? null);
    if (this.accountMode === 'ISOLATED_EXCHANGE' && exchangeType === undefined) {
      throw new GateApiError(400, 'MISSING_REQUIRED_PARAM');
    }
    const normalizedExchange = exchangeType?.toUpperCase() ?? 'CROSSEX';
    const availableMargin = this.accountMode === 'ISOLATED_EXCHANGE'
      ? this.isolatedAvailableMargins[normalizedExchange] ?? '0'
      : this.availableMargin;
    return {
      available_margin: availableMargin, margin_balance: availableMargin, initial_margin: '0',
      maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0',
      position_mode: 'SINGLE', account_mode: this.accountMode, exchange_type: normalizedExchange,
      update_time: String(Date.now()), assets: this.accountAssets,
    };
  }
  async queryPositions(): Promise<GateCrossExPortfolio['positions']> { return this.positions; }
  async queryPortfolio(): Promise<GateCrossExPortfolio> { throw new GateApiError(0, 'NOT_SCRIPTED'); }
  async querySymbols(): Promise<GateCrossExSymbol[]> { return []; }
  async queryRiskLimits(symbols: string[]): Promise<GateCrossExRiskLimit[]> {
    return symbols.map((symbol) => ({
      symbol,
      tiers: this.riskLimits[symbol] ?? [{
        tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '1000000000',
        quick_cal_amount: '0', leverage_max: '200', maintenance_rate: '0.001',
      }],
    }));
  }
  async queryLeverages(_credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>> {
    this.leverageQueries.push([...symbols]);
    return Object.fromEntries(symbols.flatMap((symbol) => (
      this.leverages[symbol] === undefined ? [] : [[symbol, this.leverages[symbol]]]
    )));
  }
  async setLeverage(_credentials: GateCredentials, symbol: string, leverage: string): Promise<{ symbol: string; leverage: string }> {
    this.leverageUpdates.push({ symbol, leverage });
    this.leverages[symbol] = leverage;
    return { symbol, leverage };
  }
  async queryFeeRates(): Promise<GateFeeRate[]> { return []; }
  async queryOrder(_credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder> {
    const created = this.createdOrders.find((order) => order.remoteId === orderId);
    if (!created) throw new GateApiError(404, 'ORDER_NOT_FOUND');
    const state = this.remoteStates.get(orderId) ?? 'OPEN';
    return {
      order_id: orderId,
      text: created.text ?? '',
      symbol: created.symbol,
      side: created.side,
      type: created.type,
      attribute: created.time_in_force === 'POC' ? 'POST_ONLY' : 'NORMAL',
      exchange_type: created.symbol.split('_')[0] ?? 'GATE',
      business_type: 'FUTURE',
      qty: created.qty ?? '0',
      quote_qty: '0',
      price: created.price ?? '0',
      time_in_force: created.time_in_force,
      state,
      executed_qty: '0',
      executed_amount: '0',
      executed_avg_price: '0',
      fee_coin: 'USDT',
      fee: '0',
      reduce_only: String(created.reduce_only),
      leverage: '0',
      reason: '',
      last_executed_qty: '0',
      last_executed_price: '0',
      last_executed_amount: '0',
      position_side: 'NONE',
      create_time: String(Date.now()),
      update_time: String(Date.now()),
    };
  }

  async createOrder(_credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    this.createAttempts.push({ ...order });
    const budget = order.symbol ? this.failCreateBudget.get(order.symbol) ?? 0 : 0;
    if (order.symbol && budget > 0) {
      this.failCreateBudget.set(order.symbol, budget - 1);
      throw new GateApiError(400, 'TRADE_INSUFFICIENT_AVAILABLE_MARGIN_ERROR');
    }
    this.sequence += 1;
    const remoteId = `remote-${this.sequence}`;
    this.createdOrders.push({ ...order, remoteId });
    this.remoteStates.set(remoteId, 'OPEN');
    return { order_id: remoteId, text: order.text ?? '' };
  }

  async cancelOrder(_credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse> {
    this.cancelledOrders.push(orderId);
    if (!this.holdCancellations) this.remoteStates.set(orderId, 'CANCELLED');
    return { order_id: orderId, text: '' };
  }
}

function futuresPosition(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: string,
): GateCrossExPortfolio['positions'][number] {
  return {
    position_id: `position-${symbol}`,
    symbol,
    position_side: side,
    initial_margin: '0',
    maintenance_margin: '0',
    position_qty: quantity,
    position_value: '0',
    upnl: '0',
    upnl_rate: '0',
    entry_price: '0',
    mark_price: '0',
    leverage: '5',
    max_leverage: '20',
    risk_limit: '0',
    fee: '0',
    funding_fee: '0',
    funding_time: '0',
    create_time: '0',
    update_time: '0',
    closed_pnl: '0',
  };
}

class StubMarkets implements MarketSource {
  private readonly markets = new Map<string, LiveMarket>();
  private state: ReturnType<NonNullable<MarketSource['connectionState']>> = 'healthy';

  constructor(private readonly database: Database.Database) {}

  set(
    symbol: string,
    bid: string,
    ask: string,
    updatedAt = new Date().toISOString(),
    receivedAt = updatedAt,
  ): void {
    const [venue = 'GATE', , asset = 'BTC'] = symbol.split('_');
    this.markets.set(symbol, {
      symbol, venue: venue as LiveMarket['venue'], asset, lastPrice: bid, bidPrice: bid, bidSize: '10',
      askPrice: ask, askSize: '10', open24h: bid, high24h: ask, low24h: bid, volume24h: '100',
      quoteVolume24h: '100000', fundingRate: '0.0001', nextFundingAt: new Date(Date.now() + 3_600_000).toISOString(),
      openInterest: '1000', openInterestValue: '1000000', receivedAt, updatedAt,
      source: 'gate_crossex_websocket',
    });
    this.database.prepare(`INSERT OR IGNORE INTO crossex_instruments (
      symbol, exchange_type, business_type, state, min_size, min_notional, lot_size,
      tick_size, max_num_orders, max_market_size, max_limit_size, contract_size,
      liquidation_fee, default_leverage, delist_time, fetched_at
    ) VALUES (?, ?, 'FUTURE', 'live', '0.00000001', NULL, '0.00000001', '0.01', '100', NULL, NULL, NULL, NULL, '1', '0', ?)`)
      .run(symbol, venue, new Date().toISOString());
  }

  market(symbol: string): LiveMarket | null { return this.markets.get(symbol) ?? null; }
  connectionState(): ReturnType<NonNullable<MarketSource['connectionState']>> { return this.state; }
  setConnectionState(state: ReturnType<NonNullable<MarketSource['connectionState']>>): void { this.state = state; }
}

interface Harness {
  database: Database.Database;
  runtime: TradingRuntime;
  engine: StrategyEngine;
  gateway: ScriptedGateway;
  markets: StubMarkets;
  directory: string;
}

const harnesses: Harness[] = [];

async function createHarness(engineOptions: StrategyEngineOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-engine-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const session = new TradingSession();
  session.set('live');
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault = new MemoryCredentialVault();
  await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'engine-key', apiSecret: 'engine-secret' });
  const gateway = new ScriptedGateway();
  const runtime = new TradingRuntime(database, session, vault, gateway);
  const markets = new StubMarkets(database);
  const engine = new StrategyEngine(database, session, runtime, markets, {
    tickIntervalMs: 20, orderTimeoutMs: 400, requoteIntervalMs: 10, repairCooldownMs: 0,
    ...engineOptions,
  });
  const harness = { database, runtime, engine, gateway, markets, directory };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function ackOrder(
  runtime: TradingRuntime,
  remoteId: string,
  state: string,
  executedQty: string,
  avgPrice: string,
  reason?: string,
): void {
  runtime.ingestPrivateEvent({ channel: 'order', payload: {
    order_id: remoteId, state, executed_qty: executedQty, executed_avg_price: avgPrice,
    ...(reason ? { reason } : {}), update_time: String(Date.now()),
  } });
}

function ingestFill(runtime: TradingRuntime, remoteId: string, symbol: string, side: 'BUY' | 'SELL', qty: string, price: string, realizedPnl = '0'): void {
  runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
    transaction_id: `txn-${remoteId}-${qty}-${Math.random().toString(36).slice(2, 8)}`, order_id: remoteId,
    symbol, exchange_type: symbol.split('_')[0] ?? 'GATE', side, qty, price, fee: '0.01', rpnl: realizedPnl,
    match_role: 'TAKER', create_time: String(Date.now()),
  } });
}

function seedFilledStrategyOrder(
  database: Database.Database,
  strategyId: string,
  id: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: string,
  leg: 'left' | 'right',
): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_orders (
    id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
    quantity, price, reduce_only, state, executed_quantity, executed_average_price,
    created_at, updated_at, strategy_id, strategy_leg
  ) VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, '54', ?, ?, ?, ?)`)
    .run(id, `${id}-client`, symbol, symbol.split('_')[0], side, quantity, quantity, now, now, strategyId, leg);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.engine.stop();
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const takerTakerConfig = {
  kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
  entryBps: '10', totalAmount: '0.2', perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
} as const;

describe('strategy engine', () => {
  it('closes a position in the requested number of timed reduce-only slices', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    markets.set(symbol, '100000', '100001', new Date(now).toISOString());
    gateway.positions = [futuresPosition(symbol, 'LONG', '0.1')];

    const record = await engine.startStrategy({
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'BINANCE',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.03',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 3,
        intervalSeconds: 5,
        targets: [{ symbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' }],
      },
    });
    expect(record).toMatchObject({ status: 'RUNNING', kind: 'position', config: { closePlan: { orderCount: 3, intervalSeconds: 5 } } });

    // Strategy timestamps use the wall clock. Anchor the injected clock after creation so slower
    // runners cannot leave the first close slice scheduled in the future.
    now = Date.parse(record.createdAt) + 100;
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol, side: 'SELL', qty: '0.03333333', reduce_only: 'true' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.03333333', '100000');
    await firstTick;

    now += 4_999;
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(1);

    now += 1;
    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]?.qty).toBe('0.03333333');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.03333333', '100000');
    await secondTick;

    now += 5_000;
    const finalTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]?.qty).toBe('0.03333334');
    ackOrder(runtime, 'remote-3', 'FILLED', '0.03333334', '100000');
    await finalTick;

    expect(runtime.getStrategy(record.id)).toMatchObject({ status: 'COMPLETED', progress: 100, filledQuantity: '3' });
    expect(runtime.listOrders().filter((order) => order.strategyId === record.id).every((order) => order.reduceOnly)).toBe(true);
  });

  it('submits every Close all target together in each timed slice', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const longSymbol = 'BINANCE_FUTURE_BTC_USDT';
    const shortSymbol = 'OKX_FUTURE_BTC_USDT';
    markets.set(longSymbol, '100000', '100001', new Date(now).toISOString());
    markets.set(shortSymbol, '99999', '100000', new Date(now).toISOString());
    gateway.positions = [futuresPosition(longSymbol, 'LONG', '0.1'), futuresPosition(shortSymbol, 'SHORT', '0.2')];
    const record = await engine.startStrategy({
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 2,
        intervalSeconds: 3,
        targets: [
          { symbol: longSymbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' },
          { symbol: shortSymbol, side: 'BUY', quantity: '0.2', positionSide: 'NONE' },
        ],
      },
    });

    now = Date.parse(record.createdAt) + 100;
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: longSymbol, side: 'SELL', qty: '0.05', reduce_only: 'true' }),
      expect.objectContaining({ symbol: shortSymbol, side: 'BUY', qty: '0.1', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-1', 'FILLED', '0.05', '100000');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await firstTick;

    now += 3_000;
    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.05', '100000');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await secondTick;

    expect(runtime.getStrategy(record.id)).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(new Set(runtime.listOrders().filter((order) => order.strategyId === record.id).map((order) => order.strategyClip)))
      .toEqual(new Set(['close-0', 'close-1']));
  });

  it('routes the canonical SKHYNIX asset through Hyperliquid native SKHX', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1081', '1082');
    markets.set('HYPERLIQUID_FUTURE_SKHX_USDC', '1080', '1081');

    const record = await engine.startStrategy({
      ...takerTakerConfig,
      asset: 'SKHYNIX',
      leftVenue: 'GATE',
      rightVenue: 'HYPERLIQUID',
      entryBps: '1000',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageQueries.flat()).toContain('HYPERLIQUID_FUTURE_SKHX_USDC');
    expect(gateway.leverageQueries.flat()).not.toContain('HYPERLIQUID_FUTURE_SKHYNIX_USDC');
  });

  it('refuses to start strategies while live trading is locked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-engine-locked-'));
    const config = loadConfig({ GCT_DATA_DIR: directory, GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations') });
    const database = openDatabase(config.databasePath, config.migrationsDir);
    const vault = new MemoryCredentialVault();
    const gateway = new ScriptedGateway();
    // A freshly constructed session is 'unset': the boot state before anyone accepts the disclaimer.
    const lockedSession = new TradingSession();
    const runtime = new TradingRuntime(database, lockedSession, vault, gateway);
    const markets = new StubMarkets(database);
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    const engine = new StrategyEngine(database, lockedSession, runtime, markets);
    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({ code: 'live_trading_locked' });
    await engine.stop();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects auto strategies whose take profit is not below entry', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    await expect(engine.startStrategy({
      ...takerTakerConfig, kind: 'auto', maxPosition: '0.2', takeProfitBps: '10',
    })).rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
  });

  it('rejects a strategy when a per-order clip is below a selected exchange minimum', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.2', lot_size = '0.1' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_size',
      label: 'OKX_FUTURE_BTC_USDT: 0.1 < 0.2',
    });
  });

  it('rejects a final target remainder that would create an undersized order', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.15' })).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_size',
    });
  });

  it('rejects a configured clip below the instrument minimum notional', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.09', perOrderQuantity: '0.09',
    })).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_notional', statusCode: 400,
    });
  });

  it('rejects a paired strategy when its full target exceeds available margin', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '10000';
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    await expect(engine.startStrategy({
      ...takerTakerConfig,
      totalAmount: '10',
      perOrderQuantity: '0.005',
      leftLeverage: '5',
      rightLeverage: '12',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('uses unified available margin without applying venue asset-row caps in cross-exchange mode', async () => {
    const { engine, gateway, markets } = await createHarness();
    gateway.availableMargin = '100000';
    gateway.accountAssets = [
      {
        coin: 'USDT', exchange_type: 'BINANCE', balance: '0', upnl: '0', equity: '0',
        futures_initial_margin: '0', futures_maintenance_margin: '0', borrowing_initial_margin: '0',
        borrowing_maintenance_margin: '0', available_balance: '0', liability: '0',
      },
      {
        coin: 'USDT', exchange_type: 'OKX', balance: '1', upnl: '0', equity: '1',
        futures_initial_margin: '0', futures_maintenance_margin: '0', borrowing_initial_margin: '0',
        borrowing_maintenance_margin: '0', available_balance: '1', liability: '0',
      },
    ];
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    const record = await engine.startStrategy(takerTakerConfig);

    expect(record.status).toBe('RUNNING');
  });

  it('queries and enforces each selected account top-level margin in isolated mode', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.accountMode = 'ISOLATED_EXCHANGE';
    gateway.isolatedAvailableMargins = { BINANCE: '100000', OKX: '1' };
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({
      code: 'insufficient_strategy_margin', statusCode: 409,
    });

    expect(gateway.accountQueries).toEqual([null, 'BINANCE', 'OKX']);
    expect(runtime.listStrategies()).toHaveLength(0);
  });

  it('executes a taker-taker paired position clip by clip and completes at the target', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Sell BINANCE at 100050 bid, buy OKX at 100000 ask: spread = 50/100000 = 5 bps < 10 bps entry.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100050', '100051');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    expect(record.status).toBe('RUNNING');

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);

    // Widen the spread beyond the 10 bps entry threshold.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [leftOrder, rightOrder] = gateway.createdOrders;
    expect(leftOrder).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', time_in_force: 'IOC', qty: '0.1' });
    expect(rightOrder).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'IOC', qty: '0.1' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await firstTick;

    const midway = runtime.getStrategy(record.id);
    expect(midway.status).toBe('RUNNING');
    expect(midway.filledQuantity).toBe('0.1');
    expect(midway.progress).toBe(50);

    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await secondTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    const completed = runtime.getStrategy(record.id);
    expect(completed.filledQuantity).toBe('0.2');
    expect(completed.progress).toBe(100);
    const strategyOrders = runtime.listOrders().filter((order) => order.strategyId === record.id);
    expect(strategyOrders).toHaveLength(4);
    expect(new Set(strategyOrders.map((order) => order.strategyLeg))).toEqual(new Set(['left', 'right']));
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(4);
  });

  it('coalesces overlapping ticks into a single latest follow-up pass', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({ ...takerTakerConfig, totalAmount: '1' });

    const first = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const superseded = Array.from({ length: 12 }, () => engine.tick());
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');

    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await Promise.all([first, ...superseded]);

    expect(gateway.createdOrders).toHaveLength(4);
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.2');
  });

  it('hedges the filled leg when the opposite taker leg fails to submit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    gateway.failCreate('OKX_FUTURE_BTC_USDT', 1);
    const record = await engine.startStrategy(takerTakerConfig);

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    await firstTick;

    // The left leg filled 0.1 SELL with no right leg. The engine must repair by buying the lagging leg.
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const repair = gateway.createdOrders[1];
    expect(repair).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.1' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100010');
    await repairTick;

    const strategy = runtime.getStrategy(record.id);
    expect(strategy.status).toBe('RUNNING');
    expect(strategy.filledQuantity).toBe('0.1');
    const logs = runtime.strategyLogs(record.id);
    expect(logs.some((log) => log.event === 'Hedging filled quantity')).toBe(true);
  });

  it('splits a router-rejected hedge into smaller clips and reports the upstream reason', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.1' });
    const routerFailure = JSON.stringify({
      label: 'NOT_BEST_ACCOUNT_ROUTER',
      message: 'All trading channels are currently busy. Consider reducing the order amount.',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FAIL', '0', '0', routerFailure);

    // The first repair follows Gate's explicit advice and halves the rejected 0.1 order.
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.05',
    });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.05', '100000');
    await firstTick;

    // A successful split resets the failure budget; the remaining 0.05 can finish the hedge.
    const secondRepair = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.05',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.05', '100000');
    await secondRepair;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Right leg fail', result: expect.stringContaining('NOT_BEST_ACCOUNT_ROUTER') }),
      expect.objectContaining({ event: 'Hedging filled quantity', result: expect.stringContaining('split after router rejected 0.1') }),
    ]));
  });

  it('pauses after repeated failed hedge attempts instead of trading blind', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    // The right leg rejects the clip submission and every hedge-repair attempt after it.
    gateway.failCreate('OKX_FUTURE_BTC_USDT', 10);
    const record = await engine.startStrategy(takerTakerConfig);

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    await firstTick;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await engine.tick();
      if (runtime.getStrategy(record.id).status === 'PAUSED') break;
    }

    const paused = runtime.getStrategy(record.id);
    expect(paused.status).toBe('PAUSED');
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Strategy paused')).toBe(true);
    // A paused strategy must not submit anything further.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(1);
  });

  it('manually resumes a paused strategy only on its active account', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig, {
      profileId: DEFAULT_CREDENTIAL_PROFILE,
      label: 'Primary Trading',
    });
    expect(engine.pauseRunningStrategiesForCredentialChange(DEFAULT_CREDENTIAL_PROFILE)).toBe(1);
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');

    await expect(engine.resumeStrategy(record.id, 'another-account')).rejects.toMatchObject({
      code: 'strategy_account_not_active', statusCode: 409,
    });
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');

    await expect(engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE)).resolves.toMatchObject({
      id: record.id, status: 'RUNNING',
    });
    expect(engine.listActiveStrategyIds()).toEqual([record.id]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy resumed', condition: 'Manual resume' }),
    ]));
    await expect(engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE)).rejects.toMatchObject({
      code: 'strategy_not_paused', statusCode: 409,
    });
  });

  it('rests a post-only maker quote and hedges each maker fill on the taker venue', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.2', perOrderQuantity: '0.2',
      executionMethod: 'MAKER_TAKER', makerLeg: 'left',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    const quote = gateway.createdOrders[0];
    // SELL maker at OKX ask 100000 * (1 + 10 bps) = 100100.
    expect(quote).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', time_in_force: 'POC', qty: '0.2', price: '100100' });

    ackOrder(runtime, 'remote-1', 'PARTIALLY_FILLED', '0.08', '100100');
    ingestFill(runtime, 'remote-1', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.08', '100100');
    await waitFor(() => gateway.createdOrders.length === 2);
    const hedge = gateway.createdOrders[1];
    expect(hedge).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'IOC', qty: '0.08' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.08', '100005');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.08');

    ackOrder(runtime, 'remote-1', 'FILLED', '0.2', '100100');
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', qty: '0.12' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.12', '100008');
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.2');
  });

  it('joins the maker best bid when it is within the configured buy-price boundary', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100', '100.01');
    markets.set('OKX_FUTURE_BTC_USDT', '100.01', '100.02');
    await engine.startStrategy({
      ...takerTakerConfig, entryBps: '-3', totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    // Spread ceiling = 100 × 1.0003 = 100.03. The 100.01 best bid is cheaper and can be joined.
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC', price: '100.01',
    });
  });

  it('joins the maker best ask when it is within the configured sell-price boundary', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '99.98', '99.99');
    markets.set('OKX_FUTURE_BTC_USDT', '99.99', '100');
    await engine.startStrategy({
      ...takerTakerConfig, entryBps: '-3', totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'left',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    // Spread floor = 100 × 0.9997 = 99.97. The 99.99 best ask is better and can be joined.
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', time_in_force: 'POC', price: '99.99',
    });
  });

  it('carries an untradeable maker residual into the next clip before the target is complete', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol = 'BINANCE_FUTURE_BTC_USDT'").run();
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', lot_size = '0.01' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.2', perOrderQuantity: '0.2',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', qty: '0.2' });

    // The fine-step maker fills 0.13, while the coarse taker venue can hedge only 0.1.
    ackOrder(runtime, 'remote-1', 'PARTIALLY_FILLED', '0.13', '99900');
    ingestFill(runtime, 'remote-1', 'OKX_FUTURE_BTC_USDT', 'BUY', '0.13', '99900');
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');

    // Once the partial maker quote closes, keep the 0.03 residual for the next normal clip. The
    // excess maker leg quotes only 0.07, after which the coarse taker leg can execute a full 0.1.
    ackOrder(runtime, 'remote-1', 'CANCELLED', '0.13', '99900');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    const carryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC', qty: '0.07', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.07', '99900');
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await carryTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      status: 'COMPLETED', filledLeft: '0.2', filledRight: '0.2', filledQuantity: '0.2', progress: 100,
    });
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Trimming residual imbalance')).toBe(false);
  });

  it('absorbs a sub-min-notional residual in the next maker-taker clip before 100%', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '2', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'carry-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'carry-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    // Progress is below 100%, so do not top up or submit the invalid 0.03 repair. The excess
    // maker leg absorbs it by quoting 0.97 in the next configured 1.00 clip.
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC',
      qty: '0.97', reduce_only: 'false',
    });

    ackOrder(runtime, 'remote-1', 'FILLED', '0.97', '54.05');
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '1', '54.2');
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      progress: 100, filledLeft: '2', filledRight: '2', filledQuantity: '2',
    });
    expect(gateway.createdOrders.some((order) => order.qty === '0.03')).toBe(false);
  });

  it('tops up and exactly trims a sub-min-notional residual only after reaching 100%', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'terminal-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'terminal-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.11', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.11', '54.1');

    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.14', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.14', '54');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      progress: 100, filledLeft: '1', filledRight: '1', filledQuantity: '1',
    });
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Padding terminal residual', quantity: '0.11 BTC' }),
      expect.objectContaining({ event: 'Trimming padded residual', quantity: '0.14 BTC' }),
      expect.objectContaining({ event: 'Padded residual trim settled' }),
    ]));
  });

  it('retries the enlarged reduce-only trim without padding twice after a close failure', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'retry-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'retry-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    const firstRepair = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.11', '54.1');
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-2', 'FAIL', '0', '0', 'TEMPORARY_CLOSE_REJECTION');
    await firstRepair;

    const retry = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.14', reduce_only: 'true',
    });
    expect(gateway.createdOrders.filter((order) => order.side === 'BUY')).toHaveLength(1);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.14', '54');
    await retry;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
  });

  it('completes a full position after trimming a persisted terminal-fill residual', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol = 'BINANCE_FUTURE_BTC_USDT'").run();
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', lot_size = '0.01' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    const now = new Date().toISOString();
    const insertFill = database.prepare(`INSERT INTO execution_orders (
      id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
      quantity, price, reduce_only, state, executed_quantity, executed_average_price,
      created_at, updated_at, strategy_id, strategy_leg
    ) VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, '100000', ?, ?, ?, ?)`);
    insertFill.run('seed-left', 'seed-left-client', 'BINANCE_FUTURE_BTC_USDT', 'BINANCE', 'SELL',
      '0.1', '0.1', now, now, record.id, 'left');
    insertFill.run('seed-right', 'seed-right-client', 'OKX_FUTURE_BTC_USDT', 'OKX', 'BUY',
      '0.13', '0.13', now, now, record.id, 'right');

    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', qty: '0.03', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.03', '100000');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      status: 'COMPLETED', filledLeft: '0.1', filledRight: '0.1', filledQuantity: '0.1', progress: 100,
    });
  });

  it('requotes the maker order when the taker leg moves beyond tolerance', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]?.price).toBe('100100');

    markets.set('OKX_FUTURE_BTC_USDT', '100499', '100500');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    const requoteTick = engine.tick();
    await waitFor(() => gateway.cancelledOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'CANCELLED', '0', '0');
    await requoteTick;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]?.price).toBe('100600.5');
  });

  it('runs an auto spread bot through an entry and take-profit cycle with reduce-only exits', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // At max position no further entries are sent even though the spread is still wide.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Collapse the spread: exit spread = (BINANCE ask - OKX bid) / OKX bid ≈ 1 bp ≤ 2 bps.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100009', '100010');
    markets.set('OKX_FUTURE_BTC_USDT', '100000', '100001');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'BINANCE_FUTURE_BTC_USDT')).toMatchObject({ side: 'BUY', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'OKX_FUTURE_BTC_USDT')).toMatchObject({ side: 'SELL', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100010');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');

    const strategy = runtime.getStrategy(record.id);
    expect(strategy.status).toBe('RUNNING');
    expect(strategy.filledLeft).toBe('0');
    expect(strategy.filledRight).toBe('0');
  });

  it('cancels resting maker quotes when a strategy is stopped', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    const stopped = await engine.stopStrategy(record.id);
    expect(stopped.status).toBe('STOPPED');
    expect(gateway.cancelledOrders).toEqual(['remote-1']);
    expect(engine.listActiveStrategyIds()).toEqual([]);
  });

  it('keeps a stop pending until the exchange confirms every cancellation', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    gateway.holdCancellations = true;
    await expect(engine.stopStrategy(record.id)).rejects.toThrow('strategy_stop_pending_remote');
    expect(runtime.getStrategy(record.id).status).toBe('STOP_PENDING_REMOTE');
    expect(engine.listActiveStrategyIds()).toEqual([record.id]);

    gateway.holdCancellations = false;
    await engine.tick();
    expect(runtime.getStrategy(record.id).status).toBe('STOPPED');
    expect(engine.listActiveStrategyIds()).toEqual([]);
  });

  it('runs an ADR premium bot through a ratio-hedged entry and take-profit cycle', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Fair ADR value = 1700 ÷ 10 = 170. SKHY bid 229.9 → executable premium ≈ 35.24% ≥ 35%.
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    expect(record.id.startsWith('PREM-')).toBe(true);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [adrLeg, hedgeLeg] = gateway.createdOrders;
    // The hedge leg buys per-order ÷ ratio of the local listing (10 ADRs per Korean share).
    expect(adrLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(hedgeLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', type: 'MARKET', qty: '0.01' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
    expect(runtime.getStrategy(record.id).progress).toBe(100);
    const entryLogs = runtime.strategyLogs(record.id);
    expect(entryLogs.filter((log) => log.event === 'Position open Executed')).toHaveLength(1);
    expect(entryLogs.some((log) => log.event === 'Left leg filled' || log.event === 'Right leg filled')).toBe(false);

    // At max position with the premium still above take profit, nothing further fires.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Premium collapses: SKHY ask 210 → exit premium = 210/170 − 1 ≈ 23.5% ≤ 24%.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHY_USDT')).toMatchObject({ side: 'BUY', qty: '0.1', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHYNIX_USDT')).toMatchObject({ side: 'SELL', qty: '0.01', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210.0');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    ingestFill(runtime, 'remote-3', 'GATE_FUTURE_SKHY_USDT', 'BUY', '0.1', '210.0', '1.5');
    ingestFill(runtime, 'remote-4', 'GATE_FUTURE_SKHYNIX_USDT', 'SELL', '0.01', '1700', '0.5');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('COMPLETED');
    expect(runtime.getStrategy(record.id).realizedPnl).toBe('2');
    expect(runtime.listStrategies().find((strategy) => strategy.id === record.id)?.realizedPnl).toBe('2');
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
    const exitLogs = runtime.strategyLogs(record.id);
    expect(exitLogs.filter((log) => log.event === 'Take-profit Executed')).toHaveLength(1);
    expect(exitLogs.filter((log) => log.event === 'Strategy completed')).toHaveLength(1);
    expect(exitLogs.some((log) => log.event === 'Left leg filled' || log.event === 'Right leg filled')).toBe(false);
  });

  it('reduces existing premium positions in per-order clips and stops without a take-profit cycle', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'LONG', '0.2'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'SHORT', '0.02'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
    });

    expect(gateway.leverageQueries).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    for (let clip = 0; clip < 2; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      const [left, right] = gateway.createdOrders.slice(clip * 2, clip * 2 + 2);
      expect(left).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', qty: '0.1', reduce_only: 'true' });
      expect(right).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', qty: '0.01', reduce_only: 'true' });
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ progress: 100, openPosition: '0' });
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Reduce-only triggered' }),
      expect.objectContaining({ event: 'Reduce-only Executed' }),
      expect.objectContaining({ event: 'Strategy completed', condition: 'Reduce-only target 0.2 SKHY' }),
    ]));
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(4);
  });

  it('rejects reduce-only premium strategies that do not fit the current positions', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'LONG', '0.1'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'SHORT', '0.01'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'reduce_only_position_unavailable', statusCode: 409 });
    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects stale or transport-delayed premium legs but accepts independently timed fresh quotes', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const currentTimestamp = new Date(now).toISOString();
    markets.set('GATE_FUTURE_SKHY_USDT', '144.9', '145', currentTimestamp);
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1139', '1140', currentTimestamp);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      entryPremiumPct: '28', takeProfitPremiumPct: '30', maxPosition: '1', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '1', '145');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '1140');
    await entryTick;

    // Fresh-looking objects are still unusable while the upstream feed itself is stale.
    markets.setConnectionState('stale');
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', new Date(now).toISOString());
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
    markets.setConnectionState('healthy');

    now += 5_000;
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    // A fresh-looking source timestamp is unusable when that frame took over three seconds to
    // reach us. The pair must not manufacture a take-profit signal from delayed transport.
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8',
      new Date(now - 4_000).toISOString(), new Date(now).toISOString());
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // A coherent pair that is minutes old is also unusable.
    const staleTimestamp = new Date(now - 60_000).toISOString();
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', staleTimestamp);
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', staleTimestamp);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Independently timed quotes are valid when each one is fresh and arrived promptly. The first
    // qualifying signal executes immediately even though their Gate source times differ by 6s.
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    const independentlyTimed = new Date(now - 6_000).toISOString();
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', independentlyTimed, independentlyTimed);
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-3', 'FILLED', '1', '143.78');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '1083.8');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
  });

  it('latches take profit after a partial opening, closes all filled exposure, and never re-enters', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.3', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    for (let clip = 0; clip < 2; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }
    expect(runtime.getStrategy(record.id).openPosition).toBe('0.2');
    expect(runtime.getStrategy(record.id).progress).toBeCloseTo(66.6667, 3);

    // Take profit arrives before the configured 0.3 maximum was reached.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 6);
    ackOrder(runtime, 'remote-5', 'FILLED', '0.1', '210');
    ackOrder(runtime, 'remote-6', 'FILLED', '0.01', '1700');

    // Even if the premium immediately moves back to the entry region, the latched exit must
    // reduce the remaining partial position instead of opening another clip.
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    await waitFor(() => gateway.createdOrders.length === 8);
    const residualCloses = gateway.createdOrders.slice(6);
    expect(residualCloses).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', qty: '0.1', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-7', 'FILLED', '0.1', '230');
    ackOrder(runtime, 'remote-8', 'FILLED', '0.01', '1700');
    await exitTick;

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ openPosition: '0', progress: 100 });
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(8);
  });

  it('caps every take-profit follow-up at the per-order quantity instead of closing the full residual', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.4', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    for (let clip = 0; clip < 4; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }
    expect(runtime.getStrategy(record.id).openPosition).toBe('0.4');

    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 10);
    ackOrder(runtime, 'remote-9', 'FILLED', '0.1', '210');
    ackOrder(runtime, 'remote-10', 'FILLED', '0.01', '1700');

    for (let residualClip = 0; residualClip < 3; residualClip += 1) {
      const expectedCount = 12 + residualClip * 2;
      await waitFor(() => gateway.createdOrders.length === expectedCount);
      const [left, right] = gateway.createdOrders.slice(expectedCount - 2, expectedCount);
      expect(left).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', qty: '0.1', reduce_only: 'true' });
      expect(right).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true' });
      ackOrder(runtime, `remote-${expectedCount - 1}`, 'FILLED', '0.1', '210');
      ackOrder(runtime, `remote-${expectedCount}`, 'FILLED', '0.01', '1700');
    }
    await exitTick;

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ progress: 100, openPosition: '0' });
    expect(gateway.createdOrders).toHaveLength(16);
  });

  it('closes the surviving leg after a take-profit leg fails instead of reopening the flat leg', async () => {
    let now = Date.now();
    const { engine, runtime, database, gateway, markets } = await createHarness({ now: () => now });
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;

    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210');
    await exitTick;
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

    // The exit phase is recovered from durable reduce-only order history after a restart.
    await engine.stop();
    now += 5_000;
    const rearmedSession = new TradingSession();
    rearmedSession.set('live');
    const resumed = new StrategyEngine(database, rearmedSession, runtime, markets, {
      tickIntervalMs: 20, orderTimeoutMs: 400, repairCooldownMs: 0, now: () => now,
    });
    resumed.start();
    const cleanupTick = resumed.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    await cleanupTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(gateway.createdOrders.filter((order) => (
      order.symbol === 'GATE_FUTURE_SKHY_USDT' && order.side === 'SELL'
    ))).toHaveLength(1);
    await resumed.stop();
  });

  it('applies both leverage settings only after the full premium capacity passes margin preflight', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '5', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.config).toMatchObject({ leftLeverage: '5', rightLeverage: '10' });
    expect(gateway.leverageUpdates).toEqual([
      { symbol: 'GATE_FUTURE_SKHY_USDT', leverage: '5' },
      { symbol: 'BINANCE_FUTURE_SKHYNIX_USDT', leverage: '10' },
    ]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy started', result: expect.stringContaining('reserved margin') }),
    ]));
  });

  it('does not reapply numerically equivalent leverage settings during premium preflight', async () => {
    const { engine, gateway, markets } = await createHarness();
    gateway.leverages = {
      GATE_FUTURE_SKHY_USDT: '12.0',
      GATE_FUTURE_SKHYNIX_USDT: '15',
    };
    markets.set('GATE_FUTURE_SKHY_USDT', '155.7', '155.8');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.2', '1180.3');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '12', rightLeverage: '15', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '10', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageQueries).toEqual([
      ['GATE_FUTURE_SKHY_USDT'],
      ['GATE_FUTURE_SKHYNIX_USDT'],
    ]);
    expect(gateway.leverageUpdates).toHaveLength(0);
  });

  it('rejects new premium grid strategies without persisting or ordering', async () => {
    const { engine, runtime, gateway } = await createHarness();

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', grid: true, gridStepPct: '1', gridLevels: 5,
      perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'premium_grid_mode_removed', statusCode: 400 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects a premium strategy before persistence or leverage changes when planned margin is insufficient', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '30';
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '5', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects a strategy whose projected position exceeds the tier allowed by selected leverage', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.riskLimits.GATE_FUTURE_SKHY_USDT = [
      { tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '100', quick_cal_amount: '0', leverage_max: '20', maintenance_rate: '0.01' },
      { tier: '2', min_risk_limit_value: '100', max_risk_limit_value: '500', quick_cal_amount: '0', leverage_max: '10', maintenance_rate: '0.02' },
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '20', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'strategy_position_exceeds_leverage_limit', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('allows a premium strategy whose maximum capacity only reduces same-venue opposite positions', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '0';
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'SHORT', '15'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'LONG', '1.95'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '156.1', '156.2');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.4', '1180.5');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      leftLeverage: '5', rightLeverage: '5', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '50', maxPosition: '15', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy started', result: expect.stringContaining('reserved margin 0 of 0') }),
    ]));
  });

  it('does not offset opposite positions held on another venue', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '10';
    gateway.positions = [
      futuresPosition('BINANCE_FUTURE_SKHY_USDT', 'SHORT', '15'),
      futuresPosition('BINANCE_FUTURE_SKHYNIX_USDT', 'LONG', '1.95'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '156.1', '156.2');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.4', '1180.5');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      leftLeverage: '5', rightLeverage: '5', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '50', maxPosition: '15', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
  });

  it('pauses immediately and sends no further clips when both legs report insufficient margin', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '3', rightLeverage: '3',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    gateway.failCreate('GATE_FUTURE_SKHY_USDT', 10);
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 10);

    await engine.tick();
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    const requestCount = gateway.createAttempts.length;
    await engine.tick();
    await engine.tick();

    expect(gateway.createAttempts).toHaveLength(requestCount);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy paused', result: expect.stringContaining('stopped retrying') }),
    ]));
  });

  it('updates a running ADR premium bot take profit and uses it on the next tick', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // 25% is above the original 24% exit, but below the newly edited 26% exit.
    markets.set('GATE_FUTURE_SKHY_USDT', '212.4', '212.5');
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    const updated = await engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: '26' });
    expect(updated.config.takeProfitPremiumPct).toBe('26');
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Take-profit updated', condition: '24% → 26%' }),
    ]));

    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '212.5');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    await exitTick;
  });

  it('rejects invalid take-profit edits for running ADR premium bots', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '200', '201');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    await expect(engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: '35' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
    await expect(engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: 'not-a-number' }))
      .rejects.toMatchObject({ name: 'ZodError' });
    expect(runtime.getStrategy(record.id).config.takeProfitPremiumPct).toBe('24');
  });

  it('rejects premium bots whose take profit is on the wrong side of entry', async () => {
    const { engine, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const base = {
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    } as const;
    await expect(engine.startStrategy({ ...base, takeProfitPremiumPct: '36' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
    await expect(engine.startStrategy({ ...base, leftSide: 'BUY', rightSide: 'SELL', entryPremiumPct: '-5', takeProfitPremiumPct: '-8' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_above_entry' });
  });

  it('repairs the hedge with a ratio-scaled order when the hedge leg fails to submit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    await firstTick;

    // 0.1 SKHY sold with no hedge: the repair buys 0.1 ÷ 10 = 0.01 SKHYNIX.
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', type: 'MARKET', qty: '0.01' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1705');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('sizes equal-notional hedges from execution prices and unwinds them proportionally', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10', hedgeMode: 'EQUAL_NOTIONAL',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [adrLeg, hedgeLeg] = gateway.createdOrders;
    expect(adrLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', qty: '0.1' });
    // Equal notional at execution prices: 0.1 × 229.9 ÷ 1700 ≈ 0.0135235 SKHYNIX — not 0.01.
    expect(hedgeLeg?.symbol).toBe('GATE_FUTURE_SKHYNIX_USDT');
    expect(Number(hedgeLeg?.qty)).toBeCloseTo(0.0135235, 6);
    const hedgeQty = hedgeLeg?.qty ?? '0';
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', hedgeQty, '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
    expect(runtime.getStrategy(record.id).progress).toBe(100);

    // A hedged equal-notional clip must not trigger phantom repairs as prices move.
    markets.set('GATE_FUTURE_SKHY_USDT', '232.9', '233.0');
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Premium converges; the exit unwinds the actually-held hedge shares, not per-order ÷ ratio.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHY_USDT')).toMatchObject({ side: 'BUY', qty: '0.1', reduce_only: 'true' });
    const hedgeExit = exits.find((order) => order.symbol === 'GATE_FUTURE_SKHYNIX_USDT');
    expect(hedgeExit?.side).toBe('SELL');
    expect(Number(hedgeExit?.qty)).toBeCloseTo(Number(hedgeQty), 12);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210.0');
    ackOrder(runtime, 'remote-4', 'FILLED', hedgeExit?.qty ?? '0', '1700');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('COMPLETED');
  });

  it('repairs a failed equal-notional hedge with the clip-intended quantity', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10', hedgeMode: 'EQUAL_NOTIONAL',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    await firstTick;

    // Even though prices moved after the clip, the repair restores the clip's own intended
    // hedge (0.1 × 229.9 ÷ 1700), recovered from the failed order's requested quantity.
    markets.set('GATE_FUTURE_SKHY_USDT', '239.9', '240.0');
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const repair = gateway.createdOrders[1];
    expect(repair?.symbol).toBe('GATE_FUTURE_SKHYNIX_USDT');
    expect(repair?.side).toBe('BUY');
    expect(Number(repair?.qty)).toBeCloseTo(0.0135235, 6);
    ackOrder(runtime, 'remote-2', 'FILLED', repair?.qty ?? '0', '1705');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('rejects equal-notional hedging on non-premium strategies', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    await expect(engine.startStrategy({ ...takerTakerConfig, hedgeMode: 'EQUAL_NOTIONAL' })).rejects.toThrow();
  });

  it('keeps RUNNING strategies detached after restart until live activation reconciles them', async () => {
    const { engine, runtime, database, markets, gateway } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    await engine.stop();

    const rearmedSession = new TradingSession();
    const resumed = new StrategyEngine(database, rearmedSession, runtime, markets, { tickIntervalMs: 20, orderTimeoutMs: 400 });
    resumed.start();
    expect(resumed.listActiveStrategyIds()).toEqual([]);
    rearmedSession.set('live');
    await resumed.prepareForLiveActivation();
    resumed.activatePersistedStrategies();
    expect(resumed.listActiveStrategyIds()).toEqual([record.id]);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Strategy resumed')).toBe(true);
    const resumeTick = resumed.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await resumeTick;
    await resumed.stop();
  });

  it('reports every order that blocks live activation with its symbol, side, and reason', async () => {
    const { engine, runtime, gateway } = await createHarness();
    // Gate accepts the cancel requests but keeps reporting both orders open.
    gateway.holdCancellations = true;
    const first = await runtime.createOrder({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.1', price: '100000' });
    const second = await runtime.createOrder({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.2', price: '100100' });

    await expect(engine.prepareForLiveActivation()).rejects.toMatchObject({
      code: 'strategy_recovery_unresolved',
      statusCode: 409,
      details: {
        unresolvedOrders: expect.arrayContaining([
          expect.objectContaining({ id: first.id, remoteOrderId: 'remote-1', symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.1', state: 'OPEN', reason: 'cancel_not_confirmed:OPEN' }),
          expect.objectContaining({ id: second.id, remoteOrderId: 'remote-2', symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', quantity: '0.2', reason: 'cancel_not_confirmed:OPEN' }),
        ]),
      },
    });

    // Once Gate honours the cancellations the very same activation goes through.
    gateway.holdCancellations = false;
    await expect(engine.prepareForLiveActivation()).resolves.toBeUndefined();
    expect(runtime.getOrder(first.id).state).toBe('CANCELLED');
    expect(runtime.getOrder(second.id).state).toBe('CANCELLED');
  });

  it('prevents persisted strategies from resuming after an account credential change', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig, {
      profileId: 'account-primary',
      label: 'Primary Trading',
    });

    expect(record).toMatchObject({
      accountProfileId: 'account-primary',
      accountLabel: 'Primary Trading',
    });
    expect(engine.runningStrategiesForCredentialProfile('account-secondary')).toEqual([]);
    expect(engine.runningStrategiesForCredentialProfile('account-primary')).toEqual([
      expect.objectContaining({ id: record.id }),
    ]);
    expect(engine.pauseRunningStrategiesForCredentialChange('account-secondary')).toBe(0);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

    expect(engine.pauseRunningStrategiesForCredentialChange('account-primary')).toBe(1);
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    expect(engine.listActiveStrategyIds()).toEqual([]);
    engine.activatePersistedStrategies('account-primary');
    expect(engine.listActiveStrategyIds()).toEqual([]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy paused', condition: 'Account credentials changed' }),
    ]));
  });
});
