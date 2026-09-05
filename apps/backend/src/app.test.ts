import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocketDefault from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { PublicMarketDataError, type FundingStatVenue, type PublicMarketDataGateway, type VenueContractSize, type VenueFundingStat } from '@gate-crossex/public-data';
import type { CrossExTransferRequest, FundingOverviewResponse, PublicMarketSnapshot } from '@gate-crossex/shared-types';
import type { Candle, CandleInterval } from '@gate-crossex/shared-types';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { DEFAULT_CREDENTIAL_PROFILE, EnvFileCredentialVault, MemoryCredentialVault, type CredentialVault, type GateCredentials } from './credential-vault.js';
import { GateApiError, type CrossExOrderRequest, type GateCrossExAccount, type GateCrossExOrder, type GateCrossExPortfolio, type GateCrossExRiskLimit, type GateCrossExSymbol, type GateFeeRate, type GateOrderActionResponse, type GateSpotAccount, type GateTransferCoin, type GateTransferRecord, type GateAccountBookRecord, type GateTransferResponse, type TradingCrossExGateway } from './crossex-client.js';
import { openDatabase } from './database.js';
import { CrossExMarketHub } from './market-hub.js';
import { TradingSession } from './trading-session.js';

const accountFixture: GateCrossExAccount = {
  available_margin: '1200',
  margin_balance: '1500',
  initial_margin: '300',
  maintenance_margin: '100',
  initial_margin_rate: '5',
  maintenance_margin_rate: '15',
  position_mode: 'SINGLE',
  account_mode: 'CROSS_EXCHANGE',
  exchange_type: 'CROSSEX',
  update_time: '1783689000000',
  assets: [
    { coin: 'USDT', exchange_type: 'BINANCE', balance: '1000', upnl: '20', equity: '1020', futures_initial_margin: '200', futures_maintenance_margin: '50', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0', available_balance: '800', liability: '0' },
    { coin: 'USDT', exchange_type: 'GATE', balance: '480', upnl: '0', equity: '480', futures_initial_margin: '100', futures_maintenance_margin: '50', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0', available_balance: '380', liability: '0' },
  ],
};

const portfolioFixture: GateCrossExPortfolio = {
  account: accountFixture,
  positions: [{
    position_id: 'position-1', symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG',
    initial_margin: '200', maintenance_margin: '50', position_qty: '0.01', position_value: '640',
    upnl: '20', upnl_rate: '0.03', entry_price: '62000', mark_price: '64000', leverage: '3',
    max_leverage: '20', risk_limit: '1', fee: '0.5', funding_fee: '1.2', funding_time: '1783728000000',
    create_time: '1783600000000', update_time: '1783689000000', closed_pnl: '4',
  }],
  adlRanks: [{
    user_id: 'account-user', symbol: 'BINANCE_FUTURE_BTC_USDT',
    crossex_adl_rank: '4', exchange_adl_rank: '3',
  }],
  marginPositions: [{
    position_id: 'margin-1', symbol: 'GATE_MARGIN_ETH_USDT', position_side: 'LONG', initial_margin: '100',
    maintenance_margin: '20', asset_qty: '1', asset_coin: 'ETH', position_value: '3200', liability: '1000',
    liability_coin: 'USDT', interest: '0.2', max_position_qty: '5', entry_price: '3100', index_price: '3200',
    upnl: '100', upnl_rate: '0.03', leverage: '2', max_leverage: '5',
    create_time: '1783600000000', update_time: '1783689000000',
  }],
  openOrders: [{
    order_id: 'order-1', client_order_id: 'client-1', state: 'OPEN', symbol: 'OKX_FUTURE_BTC_USDT',
    side: 'SELL', type: 'LIMIT', attribute: 'COMMON', exchange_type: 'OKX', business_type: 'FUTURE',
    qty: '0.01', quote_qty: '0', price: '65000', time_in_force: 'GTC', executed_qty: '0',
    executed_amount: '0', executed_avg_price: '0', fee_coin: 'USDT', fee: '0', reduce_only: 'false',
    leverage: '3', reason: '', last_executed_qty: '0', last_executed_price: '0',
    last_executed_amount: '0', position_side: 'NONE', create_time: '1783688000000', update_time: '1783688000000',
  }],
  recentTrades: [{
    transaction_id: 'fill-1', order_id: 'order-0', text: 'client-0', symbol: 'BINANCE_FUTURE_BTC_USDT',
    exchange_type: 'BINANCE', business_type: 'FUTURE', side: 'BUY', qty: '0.01', price: '62000',
    fee: '0.31', fee_coin: 'USDT', fee_rate: '0.0005', match_role: 'TAKER', rpnl: '0',
    position_mode: 'BOTH', position_side: 'LONG', create_time: '1783600000000',
  }],
};

class FakeCrossExGateway implements TradingCrossExGateway {
  readonly receivedCredentials: GateCredentials[] = [];
  readonly createdOrders: CrossExOrderRequest[] = [];
  readonly createdOrderCredentials: GateCredentials[] = [];
  readonly cancelledOrders: string[] = [];
  readonly leverageUpdates: Array<{ symbol: string; leverage: string }> = [];
  readonly createdTransfers: CrossExTransferRequest[] = [];
  readonly accountBookQueries: Array<{ coin?: string; limit: number; statementType?: string }> = [];
  symbolQueryCount = 0;
  riskQueryCount = 0;
  feeQueryCount = 0;
  positionsQueryCount = 0;
  portfolioQueryCount = 0;
  transferCoinQueryCount = 0;
  failSymbols = false;
  failPortfolio = false;
  /** When set, cancel requests are accepted but the remote order keeps reporting OPEN. */
  holdCancellations = false;
  private readonly remoteOrders = new Map<string, { request: CrossExOrderRequest; state: string }>();
  private portfolioBlock: Promise<void> | null = null;
  private positionsBlock: Promise<void> | null = null;
  private feeBlock: Promise<void> | null = null;

  async queryAccount(credentials: GateCredentials): Promise<GateCrossExAccount> {
    this.receivedCredentials.push({ ...credentials });
    return accountFixture;
  }

  async querySpotAccounts(credentials: GateCredentials): Promise<GateSpotAccount[]> {
    this.receivedCredentials.push({ ...credentials });
    return [
      { currency: 'USDT', available: '250.125', locked: '10' },
      { currency: 'USDC', available: '42.50000001', locked: '0' },
    ];
  }

  async queryPortfolio(credentials: GateCredentials): Promise<GateCrossExPortfolio> {
    this.receivedCredentials.push({ ...credentials });
    this.portfolioQueryCount += 1;
    if (this.portfolioBlock) {
      const block = this.portfolioBlock;
      this.portfolioBlock = null;
      await block;
    }
    if (this.failPortfolio) throw new GateApiError(0, 'NETWORK_ERROR');
    return portfolioFixture;
  }

  blockNextPortfolio(): () => void {
    let release!: () => void;
    this.portfolioBlock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    return release;
  }

  async queryPositions(credentials: GateCredentials): Promise<GateCrossExPortfolio['positions']> {
    this.receivedCredentials.push({ ...credentials });
    this.positionsQueryCount += 1;
    if (this.positionsBlock) {
      const block = this.positionsBlock;
      this.positionsBlock = null;
      await block;
    }
    if (this.failPortfolio) throw new GateApiError(0, 'NETWORK_ERROR');
    return portfolioFixture.positions;
  }

  blockNextPositions(): () => void {
    let release!: () => void;
    this.positionsBlock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    return release;
  }


  /** Additional catalog rows for market-catalog tests; empty so existing fixtures see one item. */
  extraSymbols: GateCrossExSymbol[] = [];

  async querySymbols(): Promise<GateCrossExSymbol[]> {
    this.symbolQueryCount += 1;
    if (this.failSymbols) throw new GateApiError(0, 'NETWORK_ERROR');
    return [{
      symbol: 'BINANCE_FUTURE_BTC_USDT', exchange_type: 'BINANCE', business_type: 'FUTURE', state: 'live',
      min_size: '0.001', min_notional: '50', lot_size: '0.001', tick_size: '0.10',
      max_num_orders: '100', max_market_size: '120', max_limit_size: '1000', contract_size: null,
      liquidation_fee: '0.012500', default_leverage: '5', delist_time: '0',
    }, ...this.extraSymbols];
  }

  async queryRiskLimits(symbols: string[]): Promise<GateCrossExRiskLimit[]> {
    this.riskQueryCount += 1;
    return symbols.map((symbol) => ({
      symbol,
      tiers: [{
        min_risk_limit_value: '0', max_risk_limit_value: '3000000', quick_cal_amount: '0',
        leverage_max: '20', maintenance_rate: '0.0065', tier: '1',
      }],
    }));
  }

  async createOrder(credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    this.receivedCredentials.push({ ...credentials });
    this.createdOrderCredentials.push({ ...credentials });
    this.createdOrders.push({ ...order });
    const orderId = `live-${this.createdOrders.length}`;
    this.remoteOrders.set(orderId, { request: { ...order }, state: 'OPEN' });
    return { order_id: orderId, text: order.text ?? '' };
  }

  async cancelOrder(credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse> {
    this.receivedCredentials.push({ ...credentials });
    this.cancelledOrders.push(orderId);
    const existing = this.remoteOrders.get(orderId);
    if (existing && !this.holdCancellations) existing.state = 'CANCELLED';
    return { order_id: orderId, text: '' };
  }

  async queryOrder(_credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder> {
    const remote = this.remoteOrders.get(orderId);
    if (!remote) throw new GateApiError(404, 'ORDER_NOT_FOUND');
    return {
      ...portfolioFixture.openOrders[0],
      order_id: orderId,
      client_order_id: remote.request.text ?? '',
      state: remote.state,
      symbol: remote.request.symbol,
      side: remote.request.side,
      type: remote.request.type,
      qty: remote.request.qty ?? '0',
      quote_qty: remote.request.quote_qty ?? '0',
      price: remote.request.price ?? '0',
      time_in_force: remote.request.time_in_force,
      reduce_only: remote.request.reduce_only ?? 'false',
      update_time: String(Date.now()),
    };
  }

  async queryLeverages(credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>> {
    this.receivedCredentials.push({ ...credentials });
    return Object.fromEntries(symbols.map((symbol) => [symbol, '5']));
  }

  async setLeverage(credentials: GateCredentials, symbol: string, leverage: string) {
    this.receivedCredentials.push({ ...credentials });
    this.leverageUpdates.push({ symbol, leverage });
    return { symbol, leverage };
  }

  async queryFeeRates(credentials: GateCredentials): Promise<GateFeeRate[]> {
    this.receivedCredentials.push({ ...credentials });
    this.feeQueryCount += 1;
    if (this.feeBlock) {
      const block = this.feeBlock;
      this.feeBlock = null;
      await block;
    }
    const accountRate = credentials.apiKey.includes('secondary') ? '0.00099' : '0.00006';
    return [
      { exchange_type: 'BINANCE', spot_maker_fee: '0.0001', spot_taker_fee: '0.00025', future_maker_fee: accountRate, future_taker_fee: '0.00022', special_fee_list: [{ symbol: 'BINANCE_FUTURE_BTC_USDT', maker_fee_rate: '0.00001', taker_fee_rate: '0.00002' }] },
      { exchange_type: 'GATE', spot_maker_fee: '0.0001', spot_taker_fee: '0.00025', future_maker_fee: '0.00005', future_taker_fee: '0.0002' },
    ];
  }

  blockNextFeeRates(): () => void {
    let release!: () => void;
    this.feeBlock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    return release;
  }

  async queryTransferCoins(): Promise<GateTransferCoin[]> {
    this.transferCoinQueryCount += 1;
    return [
      { coin: 'BTC', min_trans_amount: '0.0001', est_fee: '0.00001', precision: 8, is_disabled: 0 },
      { coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: 0 },
      { coin: 'USDT', min_trans_amount: '0.00000001', est_fee: '0', precision: 8, is_disabled: 0 },
    ];
  }

  async createTransfer(credentials: GateCredentials, transfer: CrossExTransferRequest): Promise<GateTransferResponse> {
    this.receivedCredentials.push({ ...credentials });
    this.createdTransfers.push({ ...transfer });
    return { tx_id: `transfer-${this.createdTransfers.length}`, text: transfer.text ?? `transfer-${this.createdTransfers.length}` };
  }

  async queryTransfers(credentials: GateCredentials): Promise<GateTransferRecord[]> {
    this.receivedCredentials.push({ ...credentials });
    return [{
      id: 'transfer-1', text: 'portfolio_1', from_account_type: 'SPOT', to_account_type: 'CROSSEX',
      coin: 'USDT', amount: '250', actual_receive: '250', status: 'SUCCESS', fail_reason: null,
      create_time: 1783689000000, update_time: 1783689001000,
    }];
  }

  async queryAccountBook(
    credentials: GateCredentials,
    query: { coin?: string; limit: number; statementType?: string },
  ): Promise<GateAccountBookRecord[]> {
    this.receivedCredentials.push({ ...credentials });
    this.accountBookQueries.push({ ...query });
    if (query.statementType === 'FUNDING_FEE') return [{
      id: 'funding-1', business_id: 'settlement-1', statement_type: 'FUNDING_FEE', exchange_type: 'BINANCE',
      coin: 'USDT', symbol: 'BINANCE_FUTURE_BTC_USDT', change: '-0.002', balance: '729.998',
      create_time: '1783689002000',
    }];
    return [{
      id: 'ledger-1', business_id: 'transfer-1', statement_type: 'TRANSFER_IN', exchange_type: 'GATE',
      coin: 'USDT', symbol: null, change: '250', balance: '730', create_time: '1783689001000',
    }];
  }
}

class FakePublicMarketGateway implements PublicMarketDataGateway {
  queryCount = 0;
  candleQueryCount = 0;
  contractSizeQueryCount = 0;
  fundingStatsQueryCount = 0;
  fundingHistoryQueryCount = 0;
  lastCandleBefore: number | undefined;
  fail = false;
  failContractSizes = false;
  failFundingStats = false;
  private candleBlock: Promise<void> | null = null;

  async queryVenueFundingStats(venue: FundingStatVenue): Promise<VenueFundingStat[]> {
    this.fundingStatsQueryCount += 1;
    if (this.failFundingStats) throw new PublicMarketDataError('NETWORK_ERROR');
    if (venue === 'BINANCE') return [{
      venue, base: 'BTC', quote: 'USDT', fundingRate: '0.0001', fundingIntervalHours: 8, fundingRate8h: '0.0001', nextFundingAt: '2026-07-11T08:00:00.000Z',
      openInterestValue: null, lastPrice: '50010', change24h: '-0.01',
    }];
    if (venue === 'GATE') return [{
      venue, base: 'BTC', quote: 'USDT', fundingRate: '0.00001625', fundingIntervalHours: 1, fundingRate8h: '0.00013', nextFundingAt: null,
      openInterestValue: '2500000', lastPrice: '50000', change24h: '0.0125',
    }];
    return [];
  }

  async queryFundingHistory(): Promise<Array<{ timestamp: number; rate: string }>> {
    this.fundingHistoryQueryCount += 1;
    return [
      { timestamp: Date.now() - (6 * 24 * 60 * 60_000), rate: '0.0002' },
      { timestamp: Date.now() - (12 * 60 * 60_000), rate: '-0.00003' },
    ];
  }

  /** Stall the next candle fetch until the returned release runs — proves a route did not await it. */
  blockNextCandles(): () => void {
    let release!: () => void;
    this.candleBlock = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    return release;
  }

  async queryContractSizes(venue: 'GATE' | 'OKX'): Promise<VenueContractSize[]> {
    this.contractSizeQueryCount += 1;
    if (this.failContractSizes) throw new PublicMarketDataError('NETWORK_ERROR');
    return venue === 'GATE'
      ? [{ base: 'BTC', quote: 'USDT', multiplier: '0.0001' }]
      : [{ base: 'BTC', quote: 'USDT', multiplier: '0.01' }];
  }

  async queryCandles(_symbol: string, interval: CandleInterval, _limit: number, before?: number): Promise<Candle[]> {
    this.candleQueryCount += 1;
    this.lastCandleBefore = before;
    if (this.candleBlock) {
      const block = this.candleBlock;
      this.candleBlock = null;
      await block;
    }
    if (this.fail) throw new PublicMarketDataError('NETWORK_ERROR');
    const intervalMs = interval === '1m' ? 60_000 : 3_600_000;
    // Backfilled history must sit BEFORE the live kline pushes tests emit (t = 1_783_689_000_000):
    // like production, live candles extend the backfill, never precede it.
    const base = before === undefined ? 1_783_688_880_000 : before - intervalMs;
    return [
      { startTime: base - intervalMs, open: '63940.0', high: '63951.0', low: '63939.5', close: '63950.1', volume: '312.5', closed: true },
      { startTime: base, open: '63950.1', high: '63960.0', low: '63944.0', close: '63958.2', volume: '281.0', closed: true },
    ];
  }

  async querySnapshot(symbol: string): Promise<PublicMarketSnapshot> {
    this.queryCount += 1;
    if (this.fail) throw new PublicMarketDataError('NETWORK_ERROR');
    return {
      symbol, venue: 'BINANCE', product: 'FUTURE', bidPrice: '63962.00', askPrice: '63962.10',
      lastPrice: null, markPrice: '63952.97', indexPrice: '63967.51', fundingRate: '0.00010000',
      predictedFundingRate: null, nextFundingAt: '2026-07-11T00:00:00.000Z',
      sourceTimestamp: '2026-07-10T17:57:57.021Z', fetchedAt: new Date().toISOString(),
      source: 'binance_futures_public_rest',
    };
  }
}

interface TestContext {
  app: FastifyInstance;
  database: Database.Database;
  vault: CredentialVault;
  gateway: FakeCrossExGateway;
  publicMarketGateway: FakePublicMarketGateway;
  tradingSession: TradingSession;
  directory: string;
}

const resources: TestContext[] = [];

async function createTestApp(options: {
  liveTradingEnabled?: boolean;
  marketHub?: CrossExMarketHub;
  startMarketStream?: boolean;
  directory?: string;
  borosStrategyFetcher?: () => Promise<unknown>;
  borosMarketFeeFetcher?: (marketIds: number[]) => Promise<unknown>;
  strategyEngineOptions?: { orderTimeoutMs?: number };
} = {}): Promise<TestContext> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'gate-crossex-app-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault = new MemoryCredentialVault();
  const gateway = new FakeCrossExGateway();
  const tradingSession = new TradingSession();
  if (options.liveTradingEnabled) {
    tradingSession.set('live');
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'test-key', apiSecret: 'test-secret' });
  }
  const publicMarketGateway = new FakePublicMarketGateway();
  const app = await buildApp({
    config,
    database,
    credentialVault: vault,
    crossExGateway: gateway,
    publicMarketGateway,
    tradingSession,
    marketHub: options.marketHub,
    startMarketStream: options.startMarketStream,
    borosStrategyFetcher: options.borosStrategyFetcher,
    borosMarketFeeFetcher: options.borosMarketFeeFetcher,
    strategyEngineOptions: options.strategyEngineOptions,
    logger: false,
  });
  const context = { app, database, vault, gateway, publicMarketGateway, tradingSession, directory };
  resources.push(context);
  return context;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

const SECONDARY_PROFILE_ID = 'gate-crossex-account-11111111-1111-4111-8111-111111111111';

async function addSecondaryProfile(context: Pick<TestContext, 'database' | 'vault'>): Promise<void> {
  await context.vault.set(SECONDARY_PROFILE_ID, {
    apiKey: 'secondary-api-key',
    apiSecret: 'secondary-api-secret',
  });
  context.database.prepare(`INSERT INTO credential_metadata
    (id, label, provider, created_at, last_verified_at)
    VALUES (?, 'Secondary account', 'memory_test_only', '2026-08-14T08:00:00.000Z', '2026-08-14T08:00:00.000Z')`).run(SECONDARY_PROFILE_ID);
}

function catalogSymbol(symbol: string, venue: string): GateCrossExSymbol {
  return {
    symbol, exchange_type: venue, business_type: 'FUTURE', state: 'live',
    min_size: '0.001', min_notional: '5', lot_size: '0.001', tick_size: '0.01',
    max_num_orders: '100', max_market_size: '120', max_limit_size: '1000', contract_size: null,
    liquidation_fee: '0.0125', default_leverage: '3', delist_time: '0',
  };
}

function borosStrategyFixture() {
  const longMarket = {
    marketId: 185,
    address: '0x6bb121533f78d8d0c8a847b0ab399e0399966563',
    tokenId: 2,
    name: 'ETHUSDT',
    assetSymbol: 'ETH',
    maturity: 1790294400,
    state: 'Normal',
    impliedApr: 0.0225,
    maxLeverage: 2.1,
    maxPerpLeverage: 100,
    ammId: 0,
    platformName: 'OKX',
  };
  return {
    strategies: [{
      id: 'ETH-2-1790294400-OKX-Hyperliquid',
      longMarket,
      shortMarket: {
        ...longMarket,
        marketId: 102,
        address: '0xd035309b604d6e252d29ce1d61e9a1e0a0553918',
        name: 'ETHUSDC',
        impliedApr: 0.0628,
        platformName: 'Hyperliquid',
      },
      daysToMaturity: 50,
      impliedAprSpread: 0.0403,
      maxPerpLeverage: 10,
      aprTimesMaxLeverage: 0.1487,
    }],
    totalCount: 1,
  };
}

function borosMarketFeesFixture() {
  return {
    results: [185, 102].map((marketId) => ({
      marketId,
      imData: { marginFloor: 0.06 },
      config: { takerFee: '500000000000000', kIM: '476190476190476190', tThresh: 864000 },
      extConfig: { settleFeeRate: '1000000000000000' },
      data: { timeToMaturity: 4_204_800 },
    })),
  };
}

function csrfTokenFrom(html: string): string {
  const match = html.match(/name="csrfToken" value="([^"]+)"/);
  if (!match?.[1]) throw new Error('CSRF token missing from secure form');
  return match[1];
}

afterEach(async () => {
  const activeResources = resources.splice(0);
  // Restart tests share one data directory across two app instances. Close every SQLite
  // handle before removing that directory because Windows cannot unlink an open database.
  for (const resource of activeResources) {
    await resource.app.close();
    if (resource.database.open) resource.database.close();
  }
  for (const directory of new Set(activeResources.map((resource) => resource.directory))) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('local backend', () => {
  it('reports live-only mode, migration state, and script-free credential handling', async () => {
    const { app } = await createTestApp();
    const health = await app.inject({ method: 'GET', url: '/health', headers: { host: '127.0.0.1:17840' } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, environment: 'live', database: 'ok' });

    const discovery = await app.inject({
      method: 'GET',
      url: '/api/system/discovery',
      headers: { host: 'localhost:17840' },
    });
    expect(discovery.json()).toMatchObject({
      authenticatedTradingEnabled: false,
      tradingMode: 'unset',
      mode: 'live',
      database: { migrationCount: 20, currentMigration: '0020_strategy_account_backfill.sql' },
      security: {
        credentialStorage: 'memory_test_only',
        credentialEntryPath: '/secure/credentials',
        browserJavaScriptHandlesSecrets: false,
      },
    });
  });

  it('proxies, validates, and briefly caches public Boros strategies', async () => {
    const borosStrategyFetcher = vi.fn(async () => borosStrategyFixture());
    const borosMarketFeeFetcher = vi.fn(async () => borosMarketFeesFixture());
    const { app } = await createTestApp({ borosStrategyFetcher, borosMarketFeeFetcher });
    const request = { method: 'GET' as const, url: '/api/boros/strategies', headers: { host: '127.0.0.1:17840' } };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      strategies: [{
        id: 'ETH-2-1790294400-OKX-Hyperliquid',
        longMarket: { platformName: 'OKX', takerFeeRate: 0.0005, settleFeeRate: 0.001, initialMarginFactor: 0.47619047619047616, marginRateFloor: 0.06, marginTimeFloorSeconds: 864000, timeToMaturitySeconds: 4204800 },
        shortMarket: { platformName: 'Hyperliquid', takerFeeRate: 0.0005, settleFeeRate: 0.001, initialMarginFactor: 0.47619047619047616, marginRateFloor: 0.06, marginTimeFloorSeconds: 864000, timeToMaturitySeconds: 4204800 },
      }],
      totalCount: 1,
      cacheStatus: 'fresh',
      source: 'boros_open_api',
    });
    expect(first.json().fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second.json().fetchedAt).toBe(first.json().fetchedAt);
    expect(borosStrategyFetcher).toHaveBeenCalledTimes(1);
    expect(borosMarketFeeFetcher).toHaveBeenCalledTimes(1);
    expect(borosMarketFeeFetcher).toHaveBeenCalledWith([185, 102]);
  });

  it('does not pass malformed Boros data through the local trust boundary', async () => {
    const { app } = await createTestApp({ borosStrategyFetcher: async () => ({ strategies: [{ id: 'bad' }], totalCount: 1 }) });
    const response = await app.inject({
      method: 'GET', url: '/api/boros/strategies', headers: { host: '127.0.0.1:17840' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'boros_strategies_unavailable' });
  });

  it('keeps live order submission locked unless explicitly enabled', async () => {
    const { app } = await createTestApp();
    const headers = { host: '127.0.0.1:17840', 'x-gct-trading-intent': 'place-order' };
    const order = await app.inject({ method: 'POST', url: '/api/trading/orders', headers, payload: {
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', timeInForce: 'IOC', quantity: '0.01', reduceOnly: false,
    } });
    expect(order.statusCode).toBe(403);
    expect(order.json()).toEqual({ error: 'live_trading_locked' });

    const snapshot = await app.inject({ method: 'GET', url: '/api/trading/snapshot', headers: { host: '127.0.0.1:17840' } });
    expect(snapshot.json()).toEqual({ mode: 'live', orders: [], positions: [], fills: [], balances: [] });
  });

  it('refreshes only open positions when explicit read intent is present', async () => {
    const { app, database, gateway, vault } = await createTestApp();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'positions-key', apiSecret: 'positions-secret' });
    const host = { host: '127.0.0.1:17840' };

    const missingIntent = await app.inject({
      method: 'GET', url: '/api/crossex/positions-snapshot', headers: host,
    });
    expect(missingIntent.statusCode).toBe(403);
    expect(gateway.receivedCredentials).toEqual([]);

    const refreshed = await app.inject({
      method: 'GET',
      url: '/api/crossex/positions-snapshot',
      headers: { ...host, 'x-gct-read-intent': 'positions-snapshot' },
    });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      mode: 'live',
      positions: [{
        position_id: 'position-1',
        symbol: 'BINANCE_FUTURE_BTC_USDT',
        quantity: '0.01',
        mark_price: '64000',
        funding_fee: '1.2',
      }],
    });
    expect(gateway.receivedCredentials).toEqual([{ apiKey: 'positions-key', apiSecret: 'positions-secret' }]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM portfolio_snapshots').get()).toEqual({ count: 0 });
  });

  it('starts unset and only unlocks live trading after an explicit disclaimer acknowledgement', async () => {
    const { app, vault, gateway } = await createTestApp();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'test-key', apiSecret: 'test-secret' });
    const host = { host: '127.0.0.1:17840' };
    const intent = { ...host, 'x-gct-trading-intent': 'set-trading-mode' };

    expect((await app.inject({ method: 'GET', url: '/api/trading-mode', headers: host })).json()).toEqual({ mode: 'unset' });

    // The mode endpoint requires the same trading-intent header discipline as order routes.
    const noIntent = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: host, payload: { mode: 'readonly', acceptDisclaimer: true } });
    expect(noIntent.statusCode).toBe(403);
    expect(noIntent.json()).toEqual({ error: 'missing_trading_intent' });

    // Leaving 'unset' — even toward readonly — needs the disclaimer acknowledgement.
    const silent = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'readonly' } });
    expect(silent.statusCode).toBe(400);
    expect(silent.json()).toEqual({ error: 'disclaimer_not_accepted' });

    const readonly = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'readonly', acceptDisclaimer: true } });
    expect(readonly.statusCode).toBe(200);
    expect(readonly.json()).toEqual({ mode: 'readonly' });

    // readonly → live is an arming action and needs a fresh acknowledgement.
    const armWithout = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'live' } });
    expect(armWithout.statusCode).toBe(400);
    expect(armWithout.json()).toEqual({ error: 'disclaimer_not_accepted' });

    const locked = await app.inject({ method: 'POST', url: '/api/trading/orders', headers: { ...host, 'x-gct-trading-intent': 'place-order' }, payload: {
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', timeInForce: 'IOC', quantity: '0.01', reduceOnly: false,
    } });
    expect(locked.statusCode).toBe(403);
    expect(locked.json()).toEqual({ error: 'live_trading_locked' });

    const armed = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'live', acceptDisclaimer: true } });
    expect(armed.statusCode).toBe(200);
    expect(armed.json()).toEqual({ mode: 'live' });
    expect((await app.inject({ method: 'GET', url: '/api/system/discovery', headers: host })).json()).toMatchObject({
      authenticatedTradingEnabled: true,
      tradingMode: 'live',
    });

    const order = await app.inject({ method: 'POST', url: '/api/trading/orders', headers: { ...host, 'x-gct-trading-intent': 'place-order' }, payload: {
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.001', price: '1', reduceOnly: false,
    } });
    expect(order.statusCode).toBe(200);

    // Dropping back to readonly is the safety action and must never require re-acknowledgement.
    const lockedAgain = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'readonly' } });
    expect(lockedAgain.statusCode).toBe(200);
    expect(lockedAgain.json()).toEqual({ mode: 'readonly' });
    expect(gateway.cancelledOrders).toEqual(['live-1']);
    const afterLock = await app.inject({ method: 'GET', url: '/api/trading/snapshot', headers: host });
    expect(afterLock.json().orders).toEqual([expect.objectContaining({ remoteOrderId: 'live-1', state: 'CANCELLED' })]);
  });

  it('explains which open orders block live activation and clears the block once Gate confirms them', async () => {
    const { app, vault, gateway, database } = await createTestApp({ strategyEngineOptions: { orderTimeoutMs: 100 } });
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'test-key', apiSecret: 'test-secret' });
    const host = { host: '127.0.0.1:17840' };
    const intent = { ...host, 'x-gct-trading-intent': 'set-trading-mode' };
    const armed = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'live', acceptDisclaimer: true } });
    expect(armed.statusCode).toBe(200);
    const placed = await app.inject({ method: 'POST', url: '/api/trading/orders', headers: { ...host, 'x-gct-trading-intent': 'place-order' }, payload: {
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.001', price: '1', reduceOnly: false,
    } });
    expect(placed.statusCode).toBe(200);
    const orderId = placed.json().id as string;

    // Gate accepts the cancel request but keeps reporting the order open (a venue-side hang).
    gateway.holdCancellations = true;
    const locked = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'readonly' } });
    expect(locked.statusCode).toBe(202);
    expect(locked.json()).toMatchObject({
      mode: 'readonly',
      warning: 'readonly_quiesce_incomplete',
      unresolvedOrderIds: [orderId],
      unresolvedOrders: [expect.objectContaining({ id: orderId, reason: 'cancel_not_confirmed:OPEN' })],
    });

    const blocked = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'live', acceptDisclaimer: true } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'strategy_recovery_unresolved',
      label: orderId,
      unresolvedOrders: [{
        id: orderId, remoteOrderId: 'live-1', clientOrderId: expect.stringMatching(/^gct-/), symbol: 'BINANCE_FUTURE_BTC_USDT',
        venue: 'BINANCE', side: 'BUY', quantity: '0.001', executedQuantity: '0', price: '1', state: 'OPEN', strategyId: null,
        reason: 'cancel_not_confirmed:OPEN',
      }],
    });
    expect((await app.inject({ method: 'GET', url: '/api/trading-mode', headers: host })).json()).toEqual({ mode: 'readonly' });
    const audit = database.prepare("SELECT payload_json FROM audit_events WHERE type = 'live_mode_activation_blocked'").all() as Array<{ payload_json: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.payload_json ?? '{}')).toMatchObject({ unresolvedOrders: [expect.objectContaining({ id: orderId, reason: 'cancel_not_confirmed:OPEN' })] });

    // Once Gate honours the cancellation the same request arms live mode.
    gateway.holdCancellations = false;
    const rearmed = await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'live', acceptDisclaimer: true } });
    expect(rearmed.statusCode).toBe(200);
    expect(rearmed.json()).toEqual({ mode: 'live' });
    const snapshot = await app.inject({ method: 'GET', url: '/api/trading/snapshot', headers: host });
    expect(snapshot.json().orders).toEqual([expect.objectContaining({ id: orderId, state: 'CANCELLED' })]);
  });

  it('records every trading-mode change in the audit log', async () => {
    const { app, database, vault } = await createTestApp();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'audit-key', apiSecret: 'audit-secret' });
    const intent = { host: '127.0.0.1:17840', 'x-gct-trading-intent': 'set-trading-mode' };
    await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'live', acceptDisclaimer: true } });
    await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'readonly' } });
    // A repeated no-op selection must not spam the audit trail.
    await app.inject({ method: 'POST', url: '/api/trading-mode', headers: intent, payload: { mode: 'readonly' } });
    const rows = database.prepare("SELECT payload_json FROM audit_events WHERE type = 'trading_mode_changed' ORDER BY created_at, rowid").all() as Array<{ payload_json: string }>;
    expect(rows.map((row) => JSON.parse(row.payload_json))).toEqual([
      { from: 'unset', to: 'live', disclaimerAccepted: true, unresolvedOrderCount: 0 },
      { from: 'live', to: 'readonly', disclaimerAccepted: false, unresolvedOrderCount: 0 },
    ]);
  });

  it('stores user preferences in SQLite and merges partial updates', async () => {
    const { app, database } = await createTestApp();
    const host = { host: '127.0.0.1:17840' };

    const empty = await app.inject({ method: 'GET', url: '/api/preferences', headers: host });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ preferences: {} });

    const first = await app.inject({ method: 'PUT', url: '/api/preferences', headers: host, payload: { language: 'zh', theme: 'light' } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ preferences: { language: 'zh', theme: 'light' } });

    // A later save of one key must not clobber the others.
    const second = await app.inject({ method: 'PUT', url: '/api/preferences', headers: host, payload: { favorites: ['GATE_FUTURE_BTC_USDT'], confirmOrders: false } });
    expect(second.json()).toEqual({ preferences: { language: 'zh', theme: 'light', favorites: ['GATE_FUTURE_BTC_USDT'], confirmOrders: false } });

    const rows = database.prepare('SELECT key, value_json FROM user_preferences ORDER BY key').all();
    expect(rows).toEqual([
      { key: 'confirmOrders', value_json: 'false' },
      { key: 'favorites', value_json: '["GATE_FUTURE_BTC_USDT"]' },
      { key: 'language', value_json: '"zh"' },
      { key: 'theme', value_json: '"light"' },
    ]);
  });

  it('rejects unknown preference keys and skips unreadable stored rows', async () => {
    const { app, database } = await createTestApp();
    const host = { host: '127.0.0.1:17840' };

    const unknownKey = await app.inject({ method: 'PUT', url: '/api/preferences', headers: host, payload: { fontSize: 14 } });
    expect(unknownKey.statusCode).toBe(400);
    expect(unknownKey.json()).toEqual({ error: 'invalid_preferences' });

    const badValue = await app.inject({ method: 'PUT', url: '/api/preferences', headers: host, payload: { theme: 'solarized' } });
    expect(badValue.statusCode).toBe(400);

    database.prepare(`INSERT INTO user_preferences (key, value_json, updated_at) VALUES
      ('theme', 'not-json', '2026-01-01T00:00:00.000Z'),
      ('legacy_key', '1', '2026-01-01T00:00:00.000Z')`).run();
    const survivors = await app.inject({ method: 'GET', url: '/api/preferences', headers: host });
    expect(survivors.json()).toEqual({ preferences: {} });
  });

  it('routes enabled orders and cancellations through the live gateway', async () => {
    const { app, gateway } = await createTestApp({ liveTradingEnabled: true });
    const order = await app.inject({ method: 'POST', url: '/api/trading/orders', headers: {
      host: '127.0.0.1:17840', 'x-gct-trading-intent': 'place-order',
    }, payload: {
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.001', price: '1', reduceOnly: false,
    } });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ remoteOrderId: 'live-1', state: 'NEW', executedQuantity: '0' });
    expect(order.json()).not.toHaveProperty('environment');
    expect(gateway.createdOrders).toEqual([expect.objectContaining({ symbol: 'BINANCE_FUTURE_BTC_USDT', qty: '0.001' })]);

    const cancelled = await app.inject({ method: 'DELETE', url: `/api/trading/orders/${order.json().id}`, headers: {
      host: '127.0.0.1:17840', 'x-gct-trading-intent': 'cancel-order',
    } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: 'PENDING_CANCEL' });
    expect(gateway.cancelledOrders).toEqual(['live-1']);
  });

  it('reads leverage in locked mode and only updates it with explicit live intent', async () => {
    const { app, gateway, vault, tradingSession, database } = await createTestApp();
    const host = { host: '127.0.0.1:17840' };
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'leverage-key', apiSecret: 'leverage-secret' });

    const missingReadIntent = await app.inject({ method: 'GET', url: `/api/trading/leverage/${symbol}`, headers: host });
    expect(missingReadIntent.statusCode).toBe(403);
    const current = await app.inject({ method: 'GET', url: `/api/trading/leverage/${symbol}`, headers: { ...host, 'x-gct-read-intent': 'leverage' } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({ symbol, leverage: '5' });

    const locked = await app.inject({ method: 'POST', url: `/api/trading/leverage/${symbol}`, headers: { ...host, 'x-gct-trading-intent': 'set-leverage' }, payload: { leverage: '10' } });
    expect(locked.statusCode).toBe(403);
    expect(locked.json()).toEqual({ error: 'live_trading_locked' });

    tradingSession.set('live');
    const updated = await app.inject({ method: 'POST', url: `/api/trading/leverage/${symbol}`, headers: { ...host, 'x-gct-trading-intent': 'set-leverage' }, payload: { leverage: '10' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ symbol, leverage: '10' });
    expect(gateway.leverageUpdates).toEqual([{ symbol, leverage: '10' }]);
    const audit = database.prepare("SELECT payload_json FROM audit_events WHERE type = 'leverage_changed'").get() as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toEqual({ symbol, leverage: '10' });
  });

  it('keeps live multi-leg strategies locked without the explicit enablement flag', async () => {
    const { app } = await createTestApp();
    const start = await app.inject({ method: 'POST', url: '/api/strategies', headers: {
      host: '127.0.0.1:17840', 'x-gct-trading-intent': 'start-strategy',
    }, payload: {
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '100', takeProfitBps: '0.5', maxPosition: '1', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    } });
    expect(start.statusCode).toBe(403);
    expect(start.json()).toEqual({ error: 'live_trading_locked' });
    const strategies = await app.inject({ method: 'GET', url: '/api/strategies', headers: { host: '127.0.0.1:17840' } });
    expect(strategies.json()).toEqual({ strategies: [] });
  });

  it('persists a paired strategy with a negative opening cost, lists it, and stops it', async () => {
    const marketHub = new CrossExMarketHub('ws://127.0.0.1:1');
    marketHub.market = (symbol: string) => ({
      symbol, venue: symbol.split('_')[0] as 'BINANCE' | 'OKX', asset: 'BTC',
      lastPrice: '64000', bidPrice: '63999', bidSize: '10', askPrice: '64001', askSize: '10',
      open24h: '63000', high24h: '65000', low24h: '62000', volume24h: '100',
      quoteVolume24h: '6400000', fundingRate: '0.0001',
      nextFundingAt: new Date(Date.now() + 3_600_000).toISOString(), openInterest: '100',
      openInterestValue: '6400000', receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), source: 'gate_crossex_websocket',
    });
    const { app, gateway } = await createTestApp({ liveTradingEnabled: true, marketHub });
    gateway.extraSymbols.push({
      symbol: 'OKX_FUTURE_BTC_USDT', exchange_type: 'OKX', business_type: 'FUTURE', state: 'live',
      min_size: '0.001', min_notional: '50', lot_size: '0.001', tick_size: '0.10',
      max_num_orders: '100', max_market_size: '120', max_limit_size: '1000', contract_size: null,
      liquidation_fee: '0.012500', default_leverage: '5', delist_time: '0',
    });
    const start = await app.inject({ method: 'POST', url: '/api/strategies', headers: {
      host: '127.0.0.1:17840', 'x-gct-trading-intent': 'start-strategy',
    }, payload: {
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '-5', totalAmount: '0.1', perOrderQuantity: '0.1', leftLeverage: '20', rightLeverage: '20', reduceOnly: false,
      executionMethod: 'MAKER_TAKER', makerLeg: 'left',
    } });
    expect(start.statusCode).toBe(200);
    const started = start.json();
    expect(started).toMatchObject({
      kind: 'position', status: 'RUNNING', progress: 0, filledQuantity: '0',
      accountProfileId: DEFAULT_CREDENTIAL_PROFILE, accountLabel: 'Gate CrossEx',
      config: { entryBps: '-5' },
    });
    expect(started.id).toMatch(/^PAIR-[A-Z0-9]{8}$/);

    const strategies = await app.inject({ method: 'GET', url: '/api/strategies', headers: { host: '127.0.0.1:17840' } });
    expect(strategies.json().strategies).toHaveLength(1);

    const logs = await app.inject({ method: 'GET', url: `/api/strategies/${started.id}/logs`, headers: { host: '127.0.0.1:17840' } });
    expect(logs.json().logs.some((log: { event: string }) => log.event === 'Strategy started')).toBe(true);

    const stop = await app.inject({ method: 'POST', url: `/api/strategies/${started.id}/stop`, headers: {
      host: '127.0.0.1:17840', 'x-gct-trading-intent': 'stop-strategy',
    } });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ status: 'STOPPED' });
  });

  it('resumes a paused strategy only with explicit live-trading intent', async () => {
    const marketHub = new CrossExMarketHub('ws://127.0.0.1:1');
    marketHub.market = (symbol: string) => ({
      symbol, venue: symbol.split('_')[0] as 'BINANCE' | 'OKX', asset: 'BTC',
      lastPrice: '64000', bidPrice: '63999', bidSize: '10', askPrice: '64001', askSize: '10',
      open24h: '63000', high24h: '65000', low24h: '62000', volume24h: '100',
      quoteVolume24h: '6400000', fundingRate: '0.0001',
      nextFundingAt: new Date(Date.now() + 3_600_000).toISOString(), openInterest: '100',
      openInterestValue: '6400000', receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), source: 'gate_crossex_websocket',
    });
    const { app, database, gateway } = await createTestApp({ liveTradingEnabled: true, marketHub });
    gateway.extraSymbols.push(catalogSymbol('OKX_FUTURE_BTC_USDT', 'OKX'));
    const host = { host: '127.0.0.1:17840' };
    expect((await app.inject({ method: 'GET', url: '/api/crossex/instruments', headers: host })).statusCode).toBe(200);

    const id = 'PAIR-RESUME01';
    const now = new Date().toISOString();
    const config = {
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.01',
      perOrderQuantity: '0.01', leftLeverage: '5', rightLeverage: '5', reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    };
    database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress,
      filled_quantity, filled_left, filled_right, open_position, credential_profile_id,
      credential_profile_label, created_at, updated_at, stopped_at)
      VALUES (?, 'position', 'live', 'PAUSED', ?, 0, '0', '0', '0', '0', ?, 'Gate CrossEx', ?, ?, NULL)`)
      .run(id, JSON.stringify(config), DEFAULT_CREDENTIAL_PROFILE, now, now);

    const missingIntent = await app.inject({ method: 'POST', url: `/api/strategies/${id}/resume`, headers: host });
    expect(missingIntent.statusCode).toBe(403);
    expect(missingIntent.json()).toEqual({ error: 'missing_trading_intent' });

    const resumed = await app.inject({
      method: 'POST', url: `/api/strategies/${id}/resume`,
      headers: { ...host, 'x-gct-trading-intent': 'resume-strategy' },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ id, status: 'RUNNING' });
    const logs = await app.inject({ method: 'GET', url: `/api/strategies/${id}/logs`, headers: host });
    expect(logs.json().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy resumed', condition: 'Manual resume' }),
    ]));

    const duplicate = await app.inject({
      method: 'POST', url: `/api/strategies/${id}/resume`,
      headers: { ...host, 'x-gct-trading-intent': 'resume-strategy' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'strategy_not_paused' });
  });

  it('updates a running ADR premium bot take profit through the API', async () => {
    const marketHub = new CrossExMarketHub('ws://127.0.0.1:1');
    const originalMarket = marketHub.market.bind(marketHub);
    marketHub.market = (symbol: string) => {
      const asset = symbol.includes('_SKHYNIX_') ? 'SKHYNIX' : symbol.includes('_SKHY_') ? 'SKHY' : null;
      if (!asset) return originalMarket(symbol);
      const price = asset === 'SKHY' ? '230' : '1700';
      return {
        symbol, venue: 'GATE', asset, lastPrice: price, bidPrice: price, bidSize: '10',
        askPrice: price, askSize: '10', open24h: price, high24h: price, low24h: price,
        volume24h: '100', quoteVolume24h: '10000', fundingRate: '0',
        nextFundingAt: new Date(Date.now() + 3_600_000).toISOString(), openInterest: '100',
        openInterestValue: '10000', receivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), source: 'gate_crossex_websocket',
      };
    };
    const { app, gateway } = await createTestApp({ liveTradingEnabled: true, marketHub });
    const host = { host: '127.0.0.1:17840' };
    gateway.extraSymbols = [
      catalogSymbol('GATE_FUTURE_SKHY_USDT', 'GATE'),
      catalogSymbol('GATE_FUTURE_SKHYNIX_USDT', 'GATE'),
    ];
    expect((await app.inject({ method: 'GET', url: '/api/crossex/instruments', headers: host })).statusCode).toBe(200);

    const start = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { ...host, 'x-gct-trading-intent': 'start-strategy' },
      payload: {
        kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
        leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
        leftLeverage: '3', rightLeverage: '3',
        entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '1',
        perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
      },
    });
    expect(start.statusCode).toBe(200);
    const id = start.json().id as string;
    const url = `/api/strategies/${id}/take-profit`;

    const missingIntent = await app.inject({
      method: 'PATCH', url, headers: host, payload: { takeProfitPremiumPct: '26' },
    });
    expect(missingIntent.statusCode).toBe(403);
    expect(missingIntent.json()).toEqual({ error: 'missing_trading_intent' });

    const updated = await app.inject({
      method: 'PATCH',
      url,
      headers: { ...host, 'x-gct-trading-intent': 'update-strategy-take-profit' },
      payload: { takeProfitPremiumPct: '26' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id, status: 'RUNNING', config: { takeProfitPremiumPct: '26' } });

    const invalid = await app.inject({
      method: 'PATCH',
      url,
      headers: { ...host, 'x-gct-trading-intent': 'update-strategy-take-profit' },
      payload: { takeProfitPremiumPct: '36' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'take_profit_must_be_below_entry' });

    const logs = await app.inject({ method: 'GET', url: `/api/strategies/${id}/logs`, headers: host });
    expect(logs.json().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Take-profit updated', condition: '24% → 26%' }),
    ]));
  });

  it('serves logs and accepts stop requests for PREM strategy ids', async () => {
    const { app, database } = await createTestApp({ liveTradingEnabled: true });
    const id = 'PREM-ABC12345';
    const now = new Date().toISOString();
    const config = {
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '33', takeProfitPremiumPct: '32.5', maxPosition: '5',
      perOrderQuantity: '1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    };
    database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress,
      filled_quantity, filled_left, filled_right, open_position, created_at, updated_at, stopped_at)
      VALUES (?, 'premium', 'live', 'RUNNING', ?, 100, '5', '5', '5', '5', ?, ?, NULL)`)
      .run(id, JSON.stringify(config), now, now);
    database.prepare(`INSERT INTO execution_strategy_logs
      (id, strategy_id, level, event, condition_text, quantity, result_text, created_at)
      VALUES ('log-premium', ?, 'info', 'Right leg filled', 'Premium 33.1% ≥ 33%', '0.1/0.1', 'Filled', ?)`)
      .run(id, now);

    const logs = await app.inject({ method: 'GET', url: `/api/strategies/${id}/logs`, headers: { host: '127.0.0.1:17840' } });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs).toEqual([expect.objectContaining({ event: 'Right leg filled' })]);

    const stop = await app.inject({ method: 'POST', url: `/api/strategies/${id}/stop`, headers: {
      host: '127.0.0.1:17840', 'x-gct-trading-intent': 'stop-strategy',
    } });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ id, status: 'STOPPED' });
  });

  it('serves logs and accepts stop requests for CLOSE strategy ids', async () => {
    const { app, database } = await createTestApp({ liveTradingEnabled: true });
    const id = 'CLOSE-ABC12345';
    const now = new Date().toISOString();
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    const config = {
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'BINANCE',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.05',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 2,
        intervalSeconds: 30,
        targets: [{ symbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' }],
      },
    };
    database.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress,
      filled_quantity, filled_left, filled_right, open_position, created_at, updated_at, stopped_at)
      VALUES (?, 'position', 'live', 'RUNNING', ?, 0, '0', '0', '0', '0', ?, ?, NULL)`)
      .run(id, JSON.stringify(config), now, now);
    database.prepare(`INSERT INTO execution_strategy_logs
      (id, strategy_id, level, event, condition_text, quantity, result_text, created_at)
      VALUES ('log-close', ?, 'info', 'Close strategy started', '2 slices', '0.1', 'Monitoring', ?)`)
      .run(id, now);

    const host = { host: '127.0.0.1:17840' };
    const logs = await app.inject({ method: 'GET', url: `/api/strategies/${id}/logs`, headers: host });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs).toEqual([expect.objectContaining({ event: 'Close strategy started' })]);

    const stop = await app.inject({ method: 'POST', url: `/api/strategies/${id}/stop`, headers: {
      ...host, 'x-gct-trading-intent': 'stop-strategy',
    } });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ id, status: 'STOPPED' });
  });

  it('serves merged candle series with venue backfill and validates parameters', async () => {
    const { app, publicMarketGateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    const first = await app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=1m', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      symbol: 'GATE_FUTURE_BTC_USDT', interval: '1m',
      source: 'venue_public_rest_and_crossex_websocket', building: true,
    });
    expect(first.json().candles).toHaveLength(2);

    const second = await app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=1m', headers });
    expect(second.statusCode).toBe(200);
    expect(publicMarketGateway.candleQueryCount).toBe(1);

    for (const symbol of [
      'BYBIT_FUTURE_BTC_USDT',
      'KRAKEN_FUTURE_BTC_USD',
      'HYPERLIQUID_FUTURE_BTC_USDC',
      'DERIBIT_FUTURE_BTC_USDC',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/api/markets/${symbol}/candles?interval=1m`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ symbol, source: 'venue_public_rest_and_crossex_websocket' });
      expect(response.json().candles).toHaveLength(2);
    }
    expect(publicMarketGateway.candleQueryCount).toBe(5);

    const history = await app.inject({
      method: 'GET',
      url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=1m&before=1783688820000&limit=30',
      headers,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ hasMore: false, building: false });
    expect((history.json().candles as Candle[]).every((candle) => candle.startTime < 1_783_688_820_000)).toBe(true);
    expect(publicMarketGateway.lastCandleBefore).toBe(1_783_688_820_000);

    const unknown = await app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_ZZZZ_USDT/candles?interval=1m', headers });
    expect(unknown.statusCode).toBe(404);
    const invalid = await app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=7w', headers });
    expect(invalid.statusCode).toBe(400);
  });

  it('keeps serving the candle route when the venue backfill fails, without an unhandled rejection', async () => {
    const { app, publicMarketGateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    publicMarketGateway.fail = true;
    const failed = await app.inject({ method: 'GET', url: '/api/markets/BINANCE_FUTURE_BTC_USDT/candles?interval=1m', headers });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', source: 'crossex_websocket_only' });
    // Give a rejected orphan promise (the pre-fix failure mode) the chance to surface as an
    // unhandled rejection, which vitest would report as a test error.
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    publicMarketGateway.fail = false;
    const recovered = await app.inject({ method: 'GET', url: '/api/markets/BINANCE_FUTURE_BTC_USDT/candles?interval=1m', headers });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ source: 'venue_public_rest_and_crossex_websocket' });
    expect(publicMarketGateway.candleQueryCount).toBe(2);
  });

  it('maps venue-native feed sizes to base units, caches specs, and degrades per venue', async () => {
    const { app, publicMarketGateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    const first = await app.inject({ method: 'GET', url: '/api/markets/size-units', headers });
    expect(first.statusCode).toBe(200);
    const units = first.json().units as Record<string, string>;
    expect(units.GATE_FUTURE_BTC_USDT).toBe('0.0001');
    expect(units.OKX_FUTURE_BTC_USDT).toBe('0.01');
    expect(units.BINANCE_FUTURE_BTC_USDT).toBe('1');
    expect(units.KRAKEN_FUTURE_BTC_USD).toBe('1');
    // Assets the venue spec response does not cover stay unmapped rather than guessed.
    expect(units.GATE_FUTURE_ETH_USDT).toBeUndefined();
    expect(publicMarketGateway.contractSizeQueryCount).toBe(2);

    await app.inject({ method: 'GET', url: '/api/markets/size-units', headers });
    expect(publicMarketGateway.contractSizeQueryCount).toBe(2);

    const failing = await createTestApp();
    failing.publicMarketGateway.failContractSizes = true;
    const degraded = await failing.app.inject({ method: 'GET', url: '/api/markets/size-units', headers: { host: '127.0.0.1:17840' } });
    const degradedUnits = degraded.json().units as Record<string, string>;
    expect(degradedUnits.BINANCE_FUTURE_BTC_USDT).toBe('1');
    expect(degradedUnits.GATE_FUTURE_BTC_USDT).toBeUndefined();

    // A failed venue fetch is not cached as complete; the next request retries and recovers.
    failing.publicMarketGateway.failContractSizes = false;
    const recovered = await failing.app.inject({ method: 'GET', url: '/api/markets/size-units', headers: { host: '127.0.0.1:17840' } });
    expect((recovered.json().units as Record<string, string>).GATE_FUTURE_BTC_USDT).toBe('0.0001');
  });

  it('relays book, trade, and kline messages only for each stream client’s watched market', async () => {
    const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolvePromise) => upstream.once('listening', resolvePromise));
    const address = upstream.address();
    if (typeof address === 'string' || !address) throw new Error('missing upstream address');
    const upstreamSocketPromise = new Promise<WebSocketDefault>((resolvePromise) => upstream.once('connection', resolvePromise));
    const upstreamRequests: Array<{ event: string; channel: string; payload?: string[] }> = [];
    const marketHub = new CrossExMarketHub(`ws://127.0.0.1:${address.port}`);
    marketHub.start();
    const { app } = await createTestApp({ marketHub });
    try {
      const upstreamSocket = await upstreamSocketPromise;
      upstreamSocket.on('message', (data: { toString(): string }) => {
        upstreamRequests.push(JSON.parse(data.toString()) as { event: string; channel: string; payload?: string[] });
      });

      // injectWS emits a raw upgrade event, which bypasses inject()'s implicit ready().
      await app.ready();
      // The plugin types the injected socket as a DOM WebSocket; at runtime it is a ws client.
      const clientA = await app.injectWS('/ws/stream', { headers: { host: '127.0.0.1:17840' } }) as unknown as WebSocketDefault;
      const clientB = await app.injectWS('/ws/stream', { headers: { host: '127.0.0.1:17840' } }) as unknown as WebSocketDefault;
      const clientC = await app.injectWS('/ws/stream', { headers: { host: '127.0.0.1:17840' } }) as unknown as WebSocketDefault;
      type StreamTestMessage = { type: string; payload: {
        symbol?: string;
        markets?: Array<{ symbol: string }>;
        trades?: Array<{ id: string }>;
        candle?: { close: string };
      } };
      const messagesA: StreamTestMessage[] = [];
      const messagesB: StreamTestMessage[] = [];
      const messagesC: StreamTestMessage[] = [];
      clientA.on('message', (data: { toString(): string }) => messagesA.push(JSON.parse(data.toString()) as StreamTestMessage));
      clientB.on('message', (data: { toString(): string }) => messagesB.push(JSON.parse(data.toString()) as StreamTestMessage));
      clientC.on('message', (data: { toString(): string }) => messagesC.push(JSON.parse(data.toString()) as StreamTestMessage));
      clientA.send(JSON.stringify({ type: 'watch.quotes', symbols: ['GATE_FUTURE_BTC_USDT'] }));
      clientB.send(JSON.stringify({ type: 'watch.quotes', symbols: ['GATE_FUTURE_ETH_USDT'] }));
      clientA.send(JSON.stringify({ type: 'watch.market', symbol: 'GATE_FUTURE_BTC_USDT', interval: '1m' }));
      clientB.send(JSON.stringify({ type: 'watch.market', symbol: 'GATE_FUTURE_ETH_USDT', interval: '1m' }));
      clientC.send(JSON.stringify({ type: 'watch.klines', watches: [
        { symbol: 'GATE_FUTURE_BTC_USDT', interval: '1m' },
        { symbol: 'GATE_FUTURE_ETH_USDT', interval: '1m' },
      ] }));
      await waitFor(() => ['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_ETH_USDT'].every((symbol) =>
        upstreamRequests.some((request) => request.event === 'subscribe' && request.channel === 'order_book_update' && request.payload?.includes(symbol))));
      await waitFor(() => new Set(messagesC
        .filter((message) => message.type === 'kline.snapshot')
        .map((message) => message.payload.symbol)).size === 2);
      // Quote-only registration expands client A's market scope without replacing its detailed BTC watch.
      clientA.send(JSON.stringify({ type: 'watch.quotes', symbols: ['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_SOL_USDT'] }));

      // One upstream feed interleaves both watched symbols; each client must only see its own.
      for (const [symbol, price] of [['GATE_FUTURE_BTC_USDT', '118500'], ['GATE_FUTURE_ETH_USDT', '3900']] as const) {
        upstreamSocket.send(JSON.stringify({ channel: 'order_book_update', event: 'update', result: {
          snapshot: true, ts: 1783689000000, s: symbol, a: [[price, '2']], b: [[String(Number(price) - 1), '3']],
        } }));
        for (const revision of [0, 1]) {
          const updatedPrice = String(Number(price) + revision);
          upstreamSocket.send(JSON.stringify({ channel: 'trade', event: 'update', result: {
            s: symbol, i: `trade-${symbol}-${revision}`, p: updatedPrice, q: '1', S: 'BUY', ts: 1783689000000 + revision,
          } }));
          upstreamSocket.send(JSON.stringify({ channel: 'kline_1m', event: 'update', result: {
            s: symbol, o: price, h: updatedPrice, l: price, c: updatedPrice, v: String(5 + revision),
            t: 1783689000000, T: 1783689060000, x: false,
          } }));
        }
      }
      // Ticker batches are route-scoped independently from the single detailed market watch.
      for (const [symbol, price] of [
        ['GATE_FUTURE_BTC_USDT', '118500'],
        ['GATE_FUTURE_ETH_USDT', '3900'],
        ['GATE_FUTURE_SOL_USDT', '190'],
      ] as const) {
        upstreamSocket.send(JSON.stringify({ channel: 'ticker', event: 'update', result: {
          s: symbol, lp: price, bp: String(Number(price) - 0.1), bs: '10', ap: String(Number(price) + 0.1),
          as: '12', o: price, h: price, l: price, v: '1000', q: '190000', ts: 1783689000000,
        } }));
      }

      const scoped = ['orderbook.update', 'trade.batch', 'kline.update'];
      const scopedSymbols = (messages: Array<{ type: string; payload: { symbol?: string } }>) =>
        messages.filter((message) => scoped.includes(message.type)).map((message) => message.payload.symbol);
      const batchSymbols = (messages: StreamTestMessage[]) => messages
        .filter((message) => message.type === 'market.batch')
        .flatMap((message) => message.payload.markets ?? [])
        .map((market) => market.symbol);
      await waitFor(() => scopedSymbols(messagesA).length >= 3 && scopedSymbols(messagesB).length >= 3
        && scopedSymbols(messagesC).length >= 2
        && batchSymbols(messagesA).length >= 2 && batchSymbols(messagesB).length >= 1);
      expect(new Set(scopedSymbols(messagesA))).toEqual(new Set(['GATE_FUTURE_BTC_USDT']));
      expect(new Set(scopedSymbols(messagesB))).toEqual(new Set(['GATE_FUTURE_ETH_USDT']));
      expect(new Set(batchSymbols(messagesA))).toEqual(new Set(['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_SOL_USDT']));
      expect(new Set(batchSymbols(messagesB))).toEqual(new Set(['GATE_FUTURE_ETH_USDT']));
      expect(new Set(scopedSymbols(messagesC))).toEqual(new Set(['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_ETH_USDT']));
      expect(messagesC.some((message) => message.type === 'orderbook.update' || message.type === 'trade.batch')).toBe(false);
      expect(batchSymbols(messagesC)).toEqual([]);
      expect(messagesA.find((message) => message.type === 'trade.batch')?.payload.trades).toHaveLength(2);
      expect(messagesB.find((message) => message.type === 'trade.batch')?.payload.trades).toHaveLength(2);
      expect(messagesA.filter((message) => message.type === 'kline.update')).toHaveLength(1);
      expect(messagesB.filter((message) => message.type === 'kline.update')).toHaveLength(1);
      expect(messagesA.find((message) => message.type === 'kline.update')?.payload.candle?.close).toBe('118501');
      expect(messagesB.find((message) => message.type === 'kline.update')?.payload.candle?.close).toBe('3901');
      expect(upstreamRequests.some((request) => ['order_book_update', 'trade', 'kline_1m'].includes(request.channel)
        && request.payload?.includes('GATE_FUTURE_SOL_USDT'))).toBe(false);
      expect(upstreamRequests.some((request) => request.event === 'unsubscribe'
        && request.channel === 'order_book_update' && request.payload?.includes('GATE_FUTURE_BTC_USDT'))).toBe(false);
      clientA.close();
      clientB.close();
      clientC.close();
    } finally {
      // The server close callback waits for every socket to drain, so disconnect the hub first.
      marketHub.stop();
      for (const client of upstream.clients) client.terminate();
      await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
    }
  }, 10_000);

  it('serves cached per-venue fee rates behind an explicit read intent', async () => {
    const { app, gateway, vault } = await createTestApp();
    const missingIntent = await app.inject({ method: 'GET', url: '/api/crossex/fees', headers: { host: '127.0.0.1:17840' } });
    expect(missingIntent.statusCode).toBe(403);
    const noCredentials = await app.inject({ method: 'GET', url: '/api/crossex/fees', headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'fee-rates' } });
    expect(noCredentials.statusCode).toBe(409);

    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'fee-key', apiSecret: 'fee-secret' });
    const [first, concurrent] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/crossex/fees', headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'fee-rates' } }),
      app.inject({ method: 'GET', url: '/api/crossex/fees', headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'fee-rates' } }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(concurrent.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ cacheStatus: 'fresh', fees: [
      { venue: 'BINANCE', futureTakerFee: '0.00022', specialFees: [{ symbol: 'BINANCE_FUTURE_BTC_USDT', makerFee: '0.00001', takerFee: '0.00002' }] },
      { venue: 'GATE', futureMakerFee: '0.00005' },
    ] });
    const second = await app.inject({ method: 'GET', url: '/api/crossex/fees', headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'fee-rates' } });
    expect(second.statusCode).toBe(200);
    expect(gateway.feeQueryCount).toBe(1);
  });

  it('serves supported transfer currencies with documented limits and caches the public response', async () => {
    const { app, gateway } = await createTestApp();
    const first = await app.inject({
      method: 'GET', url: '/api/crossex/transfer-coins', headers: { host: '127.0.0.1:17840' },
    });
    const second = await app.inject({
      method: 'GET', url: '/api/crossex/transfer-coins', headers: { host: '127.0.0.1:17840' },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ cacheStatus: 'fresh', items: [
      { coin: 'BTC', minimumAmount: '0.0001', estimatedFee: '0.00001', precision: 8, disabled: false },
      { coin: 'USDC', minimumAmount: '11', estimatedFee: '1', precision: 5, disabled: false },
      { coin: 'USDT', minimumAmount: '0.00000001', estimatedFee: '0', precision: 8, disabled: false },
    ] });
    expect(second.json()).toEqual(first.json());
    expect(gateway.transferCoinQueryCount).toBe(1);
  });

  it('returns exact available balances for every selectable transfer source', async () => {
    const { app } = await createTestApp({ liveTradingEnabled: true });
    const missingIntent = await app.inject({
      method: 'GET', url: '/api/crossex/transfer-balances', headers: { host: '127.0.0.1:17840' },
    });
    const response = await app.inject({
      method: 'GET', url: '/api/crossex/transfer-balances',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'transfer-balances' },
    });

    expect(missingIntent.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [
      { account: 'CROSSEX', coin: 'USDT', available: '1200' },
      { account: 'CROSSEX_BINANCE', coin: 'USDT', available: '800' },
      { account: 'CROSSEX_GATE', coin: 'USDT', available: '380' },
      { account: 'SPOT', coin: 'USDC', available: '42.50000001' },
      { account: 'SPOT', coin: 'USDT', available: '250.125' },
    ] });
  });

  it('loads transfer and account-book history only with credentials and explicit read intent', async () => {
    const { app, gateway } = await createTestApp({ liveTradingEnabled: true });
    const host = { host: '127.0.0.1:17840' };
    const missingIntent = await app.inject({ method: 'GET', url: '/api/crossex/portfolio-activity?limit=50', headers: host });
    const activity = await app.inject({
      method: 'GET',
      url: '/api/crossex/portfolio-activity?coin=USDT&limit=50',
      headers: { ...host, 'x-gct-read-intent': 'portfolio-activity' },
    });

    expect(missingIntent.statusCode).toBe(403);
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toMatchObject({
      transfers: [{ id: 'transfer-1', from: 'SPOT', to: 'CROSSEX', actualReceive: '250', status: 'SUCCESS' }],
      accountBook: [{ id: 'ledger-1', statementType: 'TRANSFER_IN', change: '250', symbol: null }],
      fundingFees: [{ id: 'funding-1', statementType: 'FUNDING_FEE', change: '-0.002', symbol: 'BINANCE_FUTURE_BTC_USDT' }],
    });
    expect(gateway.receivedCredentials).toHaveLength(3);
    expect(gateway.accountBookQueries).toEqual([
      { coin: 'USDT', limit: 50 },
      { coin: 'USDT', limit: 50, statementType: 'FUNDING_FEE' },
    ]);
  });

  it('keeps fund transfers locked behind live mode and records successful submissions', async () => {
    const lockedContext = await createTestApp();
    const host = { host: '127.0.0.1:17840' };
    const payload = { coin: 'USDT', amount: '250', from: 'SPOT', to: 'CROSSEX', text: 'portfolio_1' };
    const missingIntent = await lockedContext.app.inject({ method: 'POST', url: '/api/crossex/transfers', headers: host, payload });
    const locked = await lockedContext.app.inject({
      method: 'POST', url: '/api/crossex/transfers', headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' }, payload,
    });
    expect(missingIntent.statusCode).toBe(403);
    expect(locked.statusCode).toBe(403);
    expect(locked.json()).toEqual({ error: 'live_trading_locked' });

    const { app, gateway, database } = await createTestApp({ liveTradingEnabled: true });
    const invalidHyperliquidRoute = await app.inject({
      method: 'POST', url: '/api/crossex/transfers',
      headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' },
      payload: { coin: 'USDC', amount: '20', from: 'CROSSEX_DERIBIT', to: 'CROSSEX_HYPERLIQUID' },
    });
    const belowMinimum = await app.inject({
      method: 'POST', url: '/api/crossex/transfers',
      headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' },
      payload: { coin: 'USDC', amount: '10.99999', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' },
    });
    const excessPrecision = await app.inject({
      method: 'POST', url: '/api/crossex/transfers',
      headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' },
      payload: { coin: 'USDC', amount: '11.000001', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' },
    });
    const exceedsAvailable = await app.inject({
      method: 'POST', url: '/api/crossex/transfers',
      headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' },
      payload: { coin: 'USDT', amount: '250.126', from: 'SPOT', to: 'CROSSEX' },
    });
    const validUsdcPayload = { coin: 'USDC', amount: '20', from: 'SPOT', to: 'CROSSEX_DERIBIT', text: 'portfolio_usdc' } as const;
    const validUsdc = await app.inject({
      method: 'POST', url: '/api/crossex/transfers',
      headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' }, payload: validUsdcPayload,
    });
    const submitted = await app.inject({
      method: 'POST', url: '/api/crossex/transfers', headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' }, payload,
    });
    const submittedAlias = await app.inject({
      method: 'POST', url: '/api/crossex/transfers',
      headers: { ...host, 'x-gct-trading-intent': 'transfer-funds' },
      payload: { coin: 'USDT', amount: '1000', from: 'CROSSEX_DERIBIT', to: 'SPOT', text: 'portfolio_alias' },
    });

    expect(invalidHyperliquidRoute.statusCode).toBe(400);
    expect(invalidHyperliquidRoute.json()).toEqual({ error: 'invalid_transfer_route', label: 'HYPERLIQUID_USDC_SPOT_ONLY' });
    expect(belowMinimum.statusCode).toBe(400);
    expect(belowMinimum.json()).toEqual({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_BELOW_MINIMUM' });
    expect(excessPrecision.statusCode).toBe(400);
    expect(excessPrecision.json()).toEqual({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_PRECISION_EXCEEDED' });
    expect(exceedsAvailable.statusCode).toBe(400);
    expect(exceedsAvailable.json()).toEqual({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_EXCEEDS_AVAILABLE' });
    expect(validUsdc.statusCode).toBe(200);
    expect(validUsdc.json()).toEqual({ transactionId: 'transfer-1', text: 'portfolio_usdc' });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toEqual({ transactionId: 'transfer-2', text: 'portfolio_1' });
    expect(submittedAlias.statusCode).toBe(200);
    expect(submittedAlias.json()).toEqual({ transactionId: 'transfer-3', text: 'portfolio_alias' });
    expect(gateway.createdTransfers).toEqual([
      validUsdcPayload,
      payload,
      { coin: 'USDT', amount: '1000', from: 'CROSSEX', to: 'SPOT', text: 'portfolio_alias' },
    ]);
    const audits = database.prepare("SELECT payload_json FROM audit_events WHERE type = 'fund_transfer_submitted' ORDER BY rowid").all() as Array<{ payload_json: string }>;
    expect(audits.map((audit) => JSON.parse(audit.payload_json))).toEqual([
      expect.objectContaining({ transactionId: 'transfer-1', coin: 'USDC', amount: '20', from: 'SPOT', to: 'CROSSEX_DERIBIT' }),
      expect.objectContaining({ transactionId: 'transfer-2', coin: 'USDT', amount: '250' }),
      expect.objectContaining({ transactionId: 'transfer-3', coin: 'USDT', amount: '1000', from: 'CROSSEX', to: 'SPOT' }),
    ]);
  });

  it('rejects DNS-rebinding host headers and unexpected browser origins', async () => {
    const { app } = await createTestApp();
    const foreignHost = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'attacker.example' },
    });
    expect(foreignHost.statusCode).toBe(403);
    expect(foreignHost.json()).toEqual({ error: 'non_local_host_rejected' });

    const foreignOrigin = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:17840', origin: 'https://attacker.example' },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toEqual({ error: 'unexpected_origin_rejected' });

    // The user may browse the UI as localhost instead of 127.0.0.1 — same loopback trust domain.
    for (const origin of ['http://localhost:5173', 'http://[::1]:5173', 'http://127.0.0.1:5173']) {
      const loopback = await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost:17840', origin } });
      expect(loopback.statusCode).toBe(200);
    }

    // A local launcher may select a different free port after config was loaded. A request
    // submitted by a page on that exact origin is still same-origin and remains local-only.
    const sameOriginDifferentPort = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:19123', origin: 'http://127.0.0.1:19123' },
    });
    expect(sameOriginDifferentPort.statusCode).toBe(200);
  });

  it('serves a normalized public instrument catalog and caches the upstream response', async () => {
    const { app, gateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    const first = await app.inject({ method: 'GET', url: '/api/crossex/instruments', headers });
    const second = await app.inject({ method: 'GET', url: '/api/crossex/instruments', headers });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      source: 'gate_crossex_public_rest',
      cacheStatus: 'fresh',
      upstreamStatus: 'healthy',
      items: [{
        symbol: 'BINANCE_FUTURE_BTC_USDT', exchangeType: 'BINANCE', businessType: 'FUTURE',
        minSize: '0.001', minNotional: '50', contractSize: null, defaultLeverage: '5',
      }],
    });
    expect(second.json()).toEqual(first.json());
    expect(gateway.symbolQueryCount).toBe(1);
  });

  it('falls back to a persisted stale catalog when Gate is unavailable', async () => {
    const { app, database, gateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    expect((await app.inject({ method: 'GET', url: '/api/crossex/instruments', headers })).statusCode).toBe(200);
    database.prepare("UPDATE crossex_instruments SET fetched_at = '2020-01-01T00:00:00.000Z'").run();
    gateway.failSymbols = true;

    const stale = await app.inject({ method: 'GET', url: '/api/crossex/instruments', headers });

    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ cacheStatus: 'stale', upstreamStatus: 'unavailable' });
    expect(stale.json().items).toHaveLength(1);
  });

  it('serves a market catalog grouped by asset with venue-preferred quotes', async () => {
    const { app, gateway } = await createTestApp();
    gateway.extraSymbols = [
      catalogSymbol('GATE_FUTURE_BTC_USDT', 'GATE'),
      catalogSymbol('BINANCE_FUTURE_BTC_USDC', 'BINANCE'),
      catalogSymbol('KRAKEN_FUTURE_SOL_USD', 'KRAKEN'),
      catalogSymbol('GATE_FUTURE_ZETA_USDT', 'GATE'),
      catalogSymbol('GATE_FUTURE_SKHYNIX_USDT', 'GATE'),
      catalogSymbol('HYPERLIQUID_FUTURE_SKHX_USDC', 'HYPERLIQUID'),
      catalogSymbol('HYPERLIQUID_FUTURE_SKHY_USDC', 'HYPERLIQUID'),
      { ...catalogSymbol('OKX_FUTURE_ETH_USDT', 'OKX'), state: 'suspend' },
    ];
    const headers = { host: '127.0.0.1:17840' };
    const response = await app.inject({ method: 'GET', url: '/api/markets/catalog', headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { cacheStatus: string; assets: Array<{ asset: string; streamed: boolean; venues: Array<{ venue: string; symbol: string; quote: string }> }> };
    expect(body.cacheStatus).toBe('fresh');
    const btc = body.assets.find((entry) => entry.asset === 'BTC');
    // GATE is listed before BINANCE, and the USDT listing beats the USDC one on BINANCE.
    expect(btc).toMatchObject({ streamed: true, venues: [
      { venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT' },
      { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', quote: 'USDT' },
    ] });
    expect(body.assets.find((entry) => entry.asset === 'SOL')?.venues).toEqual([
      { venue: 'KRAKEN', symbol: 'KRAKEN_FUTURE_SOL_USD', quote: 'USD' },
    ]);
    expect(body.assets.find((entry) => entry.asset === 'SKHYNIX')?.venues).toEqual([
      { venue: 'GATE', symbol: 'GATE_FUTURE_SKHYNIX_USDT', quote: 'USDT' },
      { venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_SKHX_USDC', quote: 'USDC' },
    ]);
    expect(body.assets.some((entry) => entry.asset === 'SKHX')).toBe(false);
    expect(body.assets.find((entry) => entry.asset === 'SKHY')?.venues).toEqual([
      { venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_SKHY_USDC', quote: 'USDC' },
    ]);
    // ZETA is not part of the hub's seed watchlist; suspended instruments are excluded entirely.
    expect(body.assets.find((entry) => entry.asset === 'ZETA')?.streamed).toBe(false);
    expect(body.assets.some((entry) => entry.asset === 'ETH')).toBe(false);
    expect(gateway.symbolQueryCount).toBe(1);
  });

  it('serves the all-pairs funding overview joined onto the catalog and caches venue sweeps', async () => {
    const { app, gateway, publicMarketGateway } = await createTestApp();
    gateway.extraSymbols = [catalogSymbol('GATE_FUTURE_BTC_USDT', 'GATE'), catalogSymbol('GATE_FUTURE_ZETA_USDT', 'GATE')];
    const headers = { host: '127.0.0.1:17840' };

    const response = await app.inject({ method: 'GET', url: '/api/markets/funding-overview', headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as FundingOverviewResponse;
    expect(body.cacheStatus).toBe('fresh');
    const btc = body.assets.find((entry) => entry.asset === 'BTC');
    expect(btc?.venues.find((venue) => venue.venue === 'GATE')).toMatchObject({
      fundingRate: '0.00001625', fundingIntervalHours: 1, fundingRate8h: '0.00013', openInterestValue: '2500000', lastPrice: '50000', change24h: '0.0125',
    });
    expect(btc?.venues.find((venue) => venue.venue === 'BINANCE')).toMatchObject({
      fundingRate: '0.0001', fundingIntervalHours: 8, fundingRate8h: '0.0001', openInterestValue: null, lastPrice: '50010', change24h: '-0.01',
    });
    // Catalog pairs without venue stats still appear so the page can render the full universe.
    expect(body.assets.find((entry) => entry.asset === 'ZETA')?.venues[0]).toMatchObject({
      venue: 'GATE', fundingRate: null, lastPrice: null, change24h: null,
    });
    expect(body.venueStatus).toHaveLength(7);
    expect(body.venueStatus.every((status) => status.status === 'ok')).toBe(true);
    expect(publicMarketGateway.fundingStatsQueryCount).toBe(7);

    // A second request inside the freshness window reuses the sweep.
    expect((await app.inject({ method: 'GET', url: '/api/markets/funding-overview', headers })).statusCode).toBe(200);
    expect(publicMarketGateway.fundingStatsQueryCount).toBe(7);
  });

  it('still answers the funding overview when every venue fetch fails', async () => {
    const { app, publicMarketGateway } = await createTestApp();
    publicMarketGateway.failFundingStats = true;
    const headers = { host: '127.0.0.1:17840' };
    const response = await app.inject({ method: 'GET', url: '/api/markets/funding-overview', headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as FundingOverviewResponse;
    expect(body.venueStatus.every((status) => status.status === 'error')).toBe(true);
    const btc = body.assets.find((entry) => entry.asset === 'BTC');
    expect(btc?.venues.every((venue) => venue.fundingRate === null)).toBe(true);
  });

  it('serves and caches realized funding history only for catalog symbols', async () => {
    const { app, gateway, publicMarketGateway } = await createTestApp();
    gateway.extraSymbols = [catalogSymbol('GATE_FUTURE_BTC_USDT', 'GATE')];
    const headers = { host: '127.0.0.1:17840', 'x-gct-read-intent': 'funding-history' };
    expect((await app.inject({ method: 'GET', url: '/api/markets/catalog', headers })).statusCode).toBe(200);

    const coldRanking = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-rankings',
      headers,
      payload: { symbols: ['GATE_FUTURE_BTC_USDT'], durationDays: 30 },
    });
    expect(coldRanking.statusCode).toBe(200);
    expect(coldRanking.json()).toMatchObject({ entries: [{ symbol: 'GATE_FUTURE_BTC_USDT', status: 'pending' }] });
    expect(publicMarketGateway.fundingHistoryQueryCount).toBe(0);

    const first = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-history',
      headers,
      payload: { symbols: ['GATE_FUTURE_BTC_USDT'] },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      entries: [{
        symbol: 'GATE_FUTURE_BTC_USDT',
        status: 'pending',
      }],
    });
    await vi.waitFor(() => expect(publicMarketGateway.fundingHistoryQueryCount).toBe(1));
    await vi.waitFor(async () => {
      const cached = await app.inject({
        method: 'POST',
        url: '/api/markets/funding-history',
        headers,
        payload: { symbols: ['GATE_FUTURE_BTC_USDT'] },
      });
      expect(cached.json()).toMatchObject({
        entries: [{
          symbol: 'GATE_FUTURE_BTC_USDT',
          status: 'ok',
          rate24h: '-0.00003',
          rate7d: '0.00017',
          rate30d: '0.00017',
          settlementCount30d: 2,
        }],
      });
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-history',
      headers,
      payload: { symbols: ['GATE_FUTURE_BTC_USDT'] },
    });
    expect(second.statusCode).toBe(200);
    expect(publicMarketGateway.fundingHistoryQueryCount).toBe(1);

    const warmRanking = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-rankings',
      headers,
      payload: { symbols: ['GATE_FUTURE_BTC_USDT'], durationDays: 30 },
    });
    expect(warmRanking.statusCode).toBe(200);
    expect(warmRanking.json()).toMatchObject({ entries: [{
      symbol: 'GATE_FUTURE_BTC_USDT', status: 'ok', rate30d: '0.00017',
    }] });
    expect(publicMarketGateway.fundingHistoryQueryCount).toBe(1);

    const series = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-history/series',
      headers,
      payload: { symbols: ['GATE_FUTURE_BTC_USDT'], durationDays: 1 },
    });
    expect(series.statusCode).toBe(200);
    expect(series.json()).toMatchObject({
      entries: [{
        symbol: 'GATE_FUTURE_BTC_USDT',
        status: 'ok',
        points: [{ rate: '-0.00003' }],
      }],
    });
    expect(publicMarketGateway.fundingHistoryQueryCount).toBe(1);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-history',
      headers,
      payload: { symbols: ['GATE_FUTURE_UNKNOWN_USDT'] },
    });
    expect(unknown.statusCode).toBe(404);
    expect((await app.inject({
      method: 'POST',
      url: '/api/markets/funding-history',
      headers: { host: '127.0.0.1:17840' },
      payload: { symbols: ['GATE_FUTURE_BTC_USDT'] },
    })).statusCode).toBe(403);
  });

  it('registers catalog markets on demand when their candles are first requested', async () => {
    const { app, gateway, publicMarketGateway } = await createTestApp();
    gateway.extraSymbols = [catalogSymbol('GATE_FUTURE_ZETA_USDT', 'GATE')];
    const headers = { host: '127.0.0.1:17840' };
    // Before the catalog is cached locally the symbol is unresolvable.
    const unknown = await app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_ZETA_USDT/candles?interval=1m', headers });
    expect(unknown.statusCode).toBe(404);

    expect((await app.inject({ method: 'GET', url: '/api/markets/catalog', headers })).statusCode).toBe(200);
    const first = await app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_ZETA_USDT/candles?interval=1m', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().candles).toHaveLength(2);
    expect(publicMarketGateway.candleQueryCount).toBe(1);

    const markets = await app.inject({ method: 'GET', url: '/api/markets', headers });
    expect((markets.json() as { markets: Array<{ symbol: string }> }).markets.some((market) => market.symbol === 'GATE_FUTURE_ZETA_USDT')).toBe(true);
  });

  it('serves persisted candles instantly after a restart while refreshing in the background', async () => {
    const first = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    const initial = await first.app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=1m', headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().candles).toHaveLength(2);
    await first.app.close();
    first.database.close();

    // Same data dir simulates a backend restart; the stalled gateway proves the route serves
    // SQLite history without awaiting the venue refresh.
    const second = await createTestApp({ directory: first.directory });
    const release = second.publicMarketGateway.blockNextCandles();
    const cached = await second.app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=1m', headers });
    expect(cached.statusCode).toBe(200);
    expect(cached.json()).toMatchObject({ source: 'venue_public_rest_and_crossex_websocket', hasMore: true });
    expect(cached.json().candles).toHaveLength(2);
    expect(second.publicMarketGateway.candleQueryCount).toBe(1);
    release();
  });

  it('waits for a current candle page when the chart requests a stable first paint', async () => {
    const first = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    await first.app.inject({ method: 'GET', url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=1m', headers });
    await first.app.close();
    first.database.close();

    const second = await createTestApp({ directory: first.directory });
    const release = second.publicMarketGateway.blockNextCandles();
    let settled = false;
    const pending = second.app.inject({
      method: 'GET',
      url: '/api/markets/GATE_FUTURE_BTC_USDT/candles?interval=1m&fresh=1',
      headers,
    }).then((response) => {
      settled = true;
      return response;
    });

    await waitFor(() => second.publicMarketGateway.candleQueryCount === 1);
    expect(settled).toBe(false);
    release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'venue_public_rest_and_crossex_websocket',
      candles: expect.any(Array),
    });
  });

  it('validates and caches risk tiers for a selected instrument', async () => {
    const { app, gateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    const url = '/api/crossex/instruments/BINANCE_FUTURE_BTC_USDT/risk-limits';
    const [first, concurrent] = await Promise.all([
      app.inject({ method: 'GET', url, headers }),
      app.inject({ method: 'GET', url, headers }),
    ]);
    const second = await app.inject({ method: 'GET', url, headers });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      item: { symbol: 'BINANCE_FUTURE_BTC_USDT', tiers: [{ leverageMax: '20', maintenanceRate: '0.0065' }] },
      cacheStatus: 'fresh',
      upstreamStatus: 'healthy',
    });
    expect(concurrent.json()).toEqual(first.json());
    expect(second.json()).toEqual(first.json());
    expect(gateway.riskQueryCount).toBe(1);
  });

  it('serves, caches, and persists normalized public market snapshots', async () => {
    const { app, database, publicMarketGateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    const url = '/api/crossex/instruments/BINANCE_FUTURE_BTC_USDT/market-snapshot';
    const [first, concurrent] = await Promise.all([
      app.inject({ method: 'GET', url, headers }),
      app.inject({ method: 'GET', url, headers }),
    ]);
    const second = await app.inject({ method: 'GET', url, headers });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      snapshot: {
        symbol: 'BINANCE_FUTURE_BTC_USDT', bidPrice: '63962.00', markPrice: '63952.97',
        fundingRate: '0.00010000', source: 'binance_futures_public_rest',
      },
      cacheStatus: 'fresh', upstreamStatus: 'healthy',
    });
    expect(concurrent.json()).toEqual(first.json());
    expect(second.json()).toEqual(first.json());
    expect(publicMarketGateway.queryCount).toBe(1);
    expect(database.prepare('SELECT COUNT(*) AS count FROM public_market_snapshots').get()).toEqual({ count: 1 });
  });

  it('returns a stale public snapshot after an upstream failure and rejects unsupported venues', async () => {
    const { app, database, publicMarketGateway } = await createTestApp();
    const headers = { host: '127.0.0.1:17840' };
    const url = '/api/crossex/instruments/BINANCE_FUTURE_BTC_USDT/market-snapshot';
    await app.inject({ method: 'GET', url, headers });
    database.prepare("UPDATE public_market_snapshots SET fetched_at = '2020-01-01T00:00:00.000Z'").run();
    publicMarketGateway.fail = true;

    const stale = await app.inject({ method: 'GET', url, headers });
    const unsupported = await app.inject({
      method: 'GET', url: '/api/crossex/instruments/BYBIT_FUTURE_BTC_USDT/market-snapshot', headers,
    });

    expect(stale.json()).toMatchObject({ cacheStatus: 'stale', upstreamStatus: 'unavailable' });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toEqual({ error: 'public_market_source_not_implemented' });
  });

  it('requires configured credentials and explicit read intent for portfolio snapshots', async () => {
    const { app, gateway } = await createTestApp();
    const missingIntent = await app.inject({
      method: 'GET', url: '/api/crossex/portfolio-snapshot', headers: { host: '127.0.0.1:17840' },
    });
    const notConfigured = await app.inject({
      method: 'GET', url: '/api/crossex/portfolio-snapshot',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'portfolio-snapshot' },
    });
    expect(missingIntent.statusCode).toBe(403);
    expect(notConfigured.statusCode).toBe(409);
    expect(gateway.receivedCredentials).toEqual([]);
    const emptyReports = await app.inject({
      method: 'GET', url: '/api/reconciliation/reports', headers: { host: '127.0.0.1:17840' },
    });
    const invalidReports = await app.inject({
      method: 'GET', url: '/api/reconciliation/reports?limit=1000', headers: { host: '127.0.0.1:17840' },
    });
    expect(emptyReports.json()).toEqual({ reports: [] });
    expect(invalidReports.statusCode).toBe(400);
  });

  it('single-flights concurrent portfolio reconciliations from multiple local tabs', async () => {
    const { app, gateway, vault } = await createTestApp();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'portfolio-key', apiSecret: 'portfolio-secret' });
    const release = gateway.blockNextPortfolio();
    const request = () => app.inject({
      method: 'GET',
      url: '/api/crossex/portfolio-snapshot',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'portfolio-snapshot' },
    });
    const first = request();
    const second = request();
    await waitFor(() => gateway.portfolioQueryCount === 1);
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(gateway.portfolioQueryCount).toBe(1);
    expect(secondResponse.json()).toEqual(firstResponse.json());
  });

  it('verifies credentials through a script-free form and stores only secret-free metadata in SQLite', async () => {
    const { app, database, gateway, vault } = await createTestApp();
    const form = await app.inject({
      method: 'GET',
      url: '/secure/credentials',
      headers: { host: '127.0.0.1:5173' },
    });
    expect(form.statusCode).toBe(200);
    expect(form.headers['content-security-policy']).toContain("default-src 'none'");
    expect(form.body).not.toContain('<script');
    expect(form.body).toContain('read-only CrossEx permissions');
    expect(form.body).not.toContain('Danger zone');

    const liveForm = await app.inject({
      method: 'GET',
      url: '/secure/credentials?intent=live-trading&lang=en',
      headers: { host: '127.0.0.1:5173' },
    });
    expect(liveForm.body).toContain('CrossEx read and trade permissions');
    expect(liveForm.body).toContain('name="intent" value="live-trading"');
    expect(liveForm.body).toContain('name="lang" value="en"');
    const csrfToken = csrfTokenFrom(liveForm.body);

    const apiKey = 'example-api-key';
    const apiSecret = 'example-api-secret';
    const response = await app.inject({
      method: 'POST',
      url: '/secure/credentials',
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        csrfToken,
        intent: 'live-trading',
        lang: 'en',
        label: 'Read-only Gate key',
        apiKey,
        apiSecret,
      }).toString(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Connection secured');
    expect(response.body).toContain("I've saved credentials — enable live trading");
    expect(response.body).not.toContain(apiKey);
    expect(response.body).not.toContain(apiSecret);
    expect(gateway.receivedCredentials).toEqual([{ apiKey, apiSecret }]);
    expect(await vault.get(DEFAULT_CREDENTIAL_PROFILE)).toEqual({ apiKey, apiSecret });

    const serializedDatabaseRows = JSON.stringify({
      metadata: database.prepare('SELECT * FROM credential_metadata').all(),
      audit: database.prepare('SELECT * FROM audit_events').all(),
    });
    expect(serializedDatabaseRows).not.toContain(apiKey);
    expect(serializedDatabaseRows).not.toContain(apiSecret);

    const status = await app.inject({
      method: 'GET',
      url: '/api/onboarding/connection',
      headers: { host: '127.0.0.1:17840' },
    });
    expect(status.json()).toMatchObject({
      configured: true,
      storage: 'memory_test_only',
      label: 'Read-only Gate key',
      readOnly: true,
    });

    database.prepare(`INSERT INTO execution_orders
      (id, remote_order_id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
       quantity, price, reduce_only, state, executed_quantity, executed_average_price, created_at, updated_at)
      VALUES ('local-order-0', 'order-0', 'client-0', 'live', 'BINANCE_FUTURE_BTC_USDT', 'BINANCE',
       'BUY', 'MARKET', 'IOC', '0.01', NULL, 0, 'FILLED', '0.01', '62000',
       '2026-07-09T16:53:20.000Z', '2026-07-09T16:53:20.000Z')`).run();

    const summary = await app.inject({
      method: 'GET',
      url: '/api/crossex/account-summary',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'account-summary' },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      marginBalance: '1500',
      accountMode: 'CROSS_EXCHANGE',
      venues: ['BINANCE', 'GATE'],
      assetCount: 2,
    });

    const portfolio = await app.inject({
      method: 'GET', url: '/api/crossex/portfolio-snapshot',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'portfolio-snapshot' },
    });
    expect(portfolio.statusCode).toBe(200);
    expect(portfolio.json()).toMatchObject({
      dataStatus: 'fresh', remoteStatus: 'healthy',
      reconciliation: { status: 'baseline', issues: [{ code: 'baseline_created' }] },
      snapshot: {
        account: { marginBalance: '1500', accountMode: 'CROSS_EXCHANGE' },
        balances: expect.arrayContaining([expect.objectContaining({ venue: 'BINANCE', coin: 'USDT', equity: '1020' })]),
        futuresPositions: [{
          positionId: 'position-1', symbol: 'BINANCE_FUTURE_BTC_USDT',
          crossExAdlRank: '4', exchangeAdlRank: '3',
        }],
        marginPositions: [{ positionId: 'margin-1', symbol: 'GATE_MARGIN_ETH_USDT' }],
        openOrders: [{ orderId: 'order-1', clientOrderId: 'client-1' }],
        recentFills: [{ transactionId: 'fill-1', orderId: 'order-0' }],
      },
    });
    const storedPortfolio = database.prepare('SELECT payload_json FROM portfolio_snapshots').get() as { payload_json: string };
    expect(storedPortfolio.payload_json).not.toContain('user_id');
    expect(storedPortfolio.payload_json).not.toContain(apiKey);
    expect(storedPortfolio.payload_json).not.toContain(apiSecret);
    expect(database.prepare(`SELECT order_id, fee, realized_pnl FROM execution_fills WHERE id = 'fill-1'`).get())
      .toEqual({ order_id: 'local-order-0', fee: '0.31', realized_pnl: '0' });

    gateway.failPortfolio = true;
    const stalePortfolio = await app.inject({
      method: 'GET', url: '/api/crossex/portfolio-snapshot',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'portfolio-snapshot' },
    });
    expect(stalePortfolio.json()).toMatchObject({ dataStatus: 'stale', remoteStatus: 'unavailable' });
    expect(stalePortfolio.json()).toMatchObject({ reconciliation: { status: 'stale', issues: [{ code: 'remote_refresh_failed' }] } });
    const reports = await app.inject({
      method: 'GET', url: '/api/reconciliation/reports?limit=10', headers: { host: '127.0.0.1:17840' },
    });
    expect(reports.statusCode).toBe(200);
    expect(reports.json().reports).toHaveLength(2);
    expect(reports.json().reports[0]).toMatchObject({ status: 'stale' });
  });

  it('waits for an accepted order workflow before switching credentials', async () => {
    const context = await createTestApp({ liveTradingEnabled: true });
    const { app, gateway } = context;
    await addSecondaryProfile(context);
    const releasePositions = gateway.blockNextPositions();

    const orderRequest = app.inject({
      method: 'POST',
      url: '/api/trading/orders',
      headers: { host: '127.0.0.1:17840', 'x-gct-trading-intent': 'place-order' },
      payload: {
        symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
        quantity: '0.01', price: '64000', reduceOnly: false,
      },
    });
    await waitFor(() => gateway.positionsQueryCount === 1);

    let switchSettled = false;
    const switchRequest = app.inject({
      method: 'POST',
      url: `/api/onboarding/accounts/${SECONDARY_PROFILE_ID}/activate`,
      headers: { host: '127.0.0.1:5173', 'x-gct-credential-intent': 'switch-account' },
    }).finally(() => { switchSettled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(switchSettled).toBe(false);

    releasePositions();
    const [order, switched] = await Promise.all([orderRequest, switchRequest]);
    expect(order.statusCode).toBe(200);
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ activeProfileId: SECONDARY_PROFILE_ID, readOnly: true });
    expect(gateway.createdOrderCredentials).toEqual([{ apiKey: 'test-key', apiSecret: 'test-secret' }]);
    expect(gateway.cancelledOrders).toEqual(['live-1']);
  });

  it('drops an old-account positions response that finishes after an account switch', async () => {
    const context = await createTestApp({ liveTradingEnabled: true });
    const { app, gateway } = context;
    await addSecondaryProfile(context);
    const releasePositions = gateway.blockNextPositions();

    const oldPositions = app.inject({
      method: 'GET',
      url: '/api/crossex/positions-snapshot',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'positions-snapshot' },
    });
    await waitFor(() => gateway.positionsQueryCount === 1);
    const switched = await app.inject({
      method: 'POST',
      url: `/api/onboarding/accounts/${SECONDARY_PROFILE_ID}/activate`,
      headers: { host: '127.0.0.1:5173', 'x-gct-credential-intent': 'switch-account' },
    });
    expect(switched.statusCode).toBe(200);

    releasePositions();
    const staleResponse = await oldPositions;
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toEqual({ error: 'credential_context_changed' });
    const snapshot = await app.inject({
      method: 'GET', url: '/api/trading/snapshot', headers: { host: '127.0.0.1:17840' },
    });
    expect(snapshot.json().positions).toEqual([]);
  });

  it('keeps an old-account fee request from repopulating the new account cache', async () => {
    const context = await createTestApp({ liveTradingEnabled: true });
    const { app, gateway } = context;
    await addSecondaryProfile(context);
    const releaseFees = gateway.blockNextFeeRates();
    const feeHeaders = { host: '127.0.0.1:17840', 'x-gct-read-intent': 'fee-rates' };

    const oldFees = app.inject({ method: 'GET', url: '/api/crossex/fees', headers: feeHeaders });
    await waitFor(() => gateway.feeQueryCount === 1);
    const switched = await app.inject({
      method: 'POST',
      url: `/api/onboarding/accounts/${SECONDARY_PROFILE_ID}/activate`,
      headers: { host: '127.0.0.1:5173', 'x-gct-credential-intent': 'switch-account' },
    });
    expect(switched.statusCode).toBe(200);

    const newFees = await app.inject({ method: 'GET', url: '/api/crossex/fees', headers: feeHeaders });
    expect(newFees.statusCode).toBe(200);
    expect(newFees.json().fees[0]).toMatchObject({ venue: 'BINANCE', futureMakerFee: '0.00099' });

    releaseFees();
    const staleResponse = await oldFees;
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toEqual({ error: 'credential_context_changed' });
    const cached = await app.inject({ method: 'GET', url: '/api/crossex/fees', headers: feeHeaders });
    expect(cached.json().fees[0]).toMatchObject({ futureMakerFee: '0.00099' });
    expect(gateway.feeQueryCount).toBe(2);
  });

  it('adds and switches saved accounts while clearing the previous account state', async () => {
    const { app, database, vault } = await createTestApp();
    const browserHeaders = { host: '127.0.0.1:5173' };
    const postHeaders = {
      ...browserHeaders,
      origin: 'http://127.0.0.1:5173',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const firstForm = await app.inject({ method: 'GET', url: '/secure/credentials', headers: browserHeaders });
    await app.inject({
      method: 'POST', url: '/secure/credentials', headers: postHeaders,
      payload: new URLSearchParams({
        csrfToken: csrfTokenFrom(firstForm.body), label: 'Primary account',
        apiKey: 'primary-api-key', apiSecret: 'primary-api-secret',
      }).toString(),
    });

    const addForm = await app.inject({ method: 'GET', url: '/secure/credentials?action=add', headers: browserHeaders });
    expect(addForm.body).toContain('Sign in to another Gate account');
    const added = await app.inject({
      method: 'POST', url: '/secure/credentials', headers: postHeaders,
      payload: new URLSearchParams({
        csrfToken: csrfTokenFrom(addForm.body), action: 'add', label: 'Secondary account',
        apiKey: 'secondary-api-key', apiSecret: 'secondary-api-secret',
      }).toString(),
    });
    expect(added.statusCode).toBe(200);

    const profiles = database.prepare('SELECT id, label FROM credential_metadata ORDER BY created_at').all() as Array<{ id: string; label: string }>;
    expect(profiles.map((profile) => profile.label)).toEqual(['Primary account', 'Secondary account']);
    const secondary = profiles.find((profile) => profile.label === 'Secondary account');
    expect(secondary).toBeDefined();
    expect(await vault.get(secondary!.id)).toMatchObject({ apiKey: 'secondary-api-key' });

    database.prepare(`INSERT INTO live_balances
      (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
      VALUES ('KRAKEN', 'USD', '6.59', '6.59', '7.35', '0.76', '2026-08-12T15:00:00.000Z')`).run();
    const manager = await app.inject({ method: 'GET', url: '/secure/credentials', headers: browserHeaders });
    expect(manager.body).toContain('Primary account');
    expect(manager.body).toContain('Secondary account');
    expect(manager.body).toContain('Saved accounts');

    const switched = await app.inject({
      method: 'POST', url: '/secure/credentials/switch', headers: postHeaders,
      payload: new URLSearchParams({
        csrfToken: csrfTokenFrom(manager.body), profileId: DEFAULT_CREDENTIAL_PROFILE,
      }).toString(),
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.body).toContain('Account switched');
    expect(database.prepare('SELECT COUNT(*) AS count FROM live_balances').get()).toEqual({ count: 0 });

    const connection = await app.inject({ method: 'GET', url: '/api/onboarding/connection', headers: browserHeaders });
    expect(connection.json()).toMatchObject({
      label: 'Primary account',
      activeProfileId: DEFAULT_CREDENTIAL_PROFILE,
      profiles: [
        expect.objectContaining({ label: 'Primary account', active: true }),
        expect.objectContaining({ label: 'Secondary account', active: false }),
      ],
    });

    const strategyId = 'PAIR-ACCOUNT1';
    database.prepare(`INSERT INTO execution_strategies
      (id, kind, environment, status, config_json, progress, filled_quantity, filled_left,
       filled_right, open_position, credential_profile_id, credential_profile_label,
       created_at, updated_at, stopped_at)
      VALUES (?, 'position', 'live', 'RUNNING', ?, 0, '0', '0', '0', '0', ?, ?, ?, ?, NULL)`)
      .run(strategyId, JSON.stringify({
        kind: 'position', asset: 'BTC', hedgeMode: 'SHARE_RATIO', leftLeverage: '1', rightLeverage: '1',
        leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY', entryBps: '5',
        totalAmount: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
        executionMethod: 'MAKER_TAKER', makerLeg: 'left', grid: false,
      }), DEFAULT_CREDENTIAL_PROFILE, 'Primary account',
      '2026-08-12T16:20:00.000Z', '2026-08-12T16:20:00.000Z');

    const switchNeedsConfirmation = await app.inject({
      method: 'POST',
      url: `/api/onboarding/accounts/${secondary!.id}/activate`,
      headers: { ...browserHeaders, 'x-gct-credential-intent': 'switch-account' },
    });
    expect(switchNeedsConfirmation.statusCode).toBe(409);
    expect(switchNeedsConfirmation.json()).toEqual({
      error: 'running_strategies_require_confirmation', strategyCount: 1, strategyIds: [strategyId],
    });
    expect(database.prepare('SELECT status FROM execution_strategies WHERE id = ?').get(strategyId))
      .toEqual({ status: 'RUNNING' });

    const switchedInWebApp = await app.inject({
      method: 'POST',
      url: `/api/onboarding/accounts/${secondary!.id}/activate`,
      headers: { ...browserHeaders, 'x-gct-credential-intent': 'switch-account' },
      payload: { confirmPauseRunningStrategies: true },
    });
    expect(switchedInWebApp.statusCode).toBe(200);
    expect(switchedInWebApp.json()).toMatchObject({
      label: 'Secondary account',
      activeProfileId: secondary!.id,
      profiles: [
        expect.objectContaining({ label: 'Primary account', active: false }),
        expect.objectContaining({ label: 'Secondary account', active: true }),
      ],
    });
    expect(database.prepare('SELECT status, credential_profile_id FROM execution_strategies WHERE id = ?').get(strategyId))
      .toEqual({ status: 'PAUSED', credential_profile_id: DEFAULT_CREDENTIAL_PROFILE });

    database.prepare(`
      UPDATE execution_strategies
      SET credential_profile_id = ?, credential_profile_label = ?
      WHERE id = ?
    `).run(secondary!.id, 'Secondary account', strategyId);
    const renameWithoutIntent = await app.inject({
      method: 'PATCH',
      url: `/api/onboarding/accounts/${secondary!.id}`,
      headers: browserHeaders,
      payload: { label: 'Secondary desk' },
    });
    expect(renameWithoutIntent.statusCode).toBe(403);
    const invalidRename = await app.inject({
      method: 'PATCH',
      url: `/api/onboarding/accounts/${secondary!.id}`,
      headers: { ...browserHeaders, 'x-gct-credential-intent': 'rename-account' },
      payload: { label: '   ' },
    });
    expect(invalidRename.statusCode).toBe(400);
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/onboarding/accounts/${secondary!.id}`,
      headers: { ...browserHeaders, 'x-gct-credential-intent': 'rename-account' },
      payload: { label: '  Secondary desk  ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      label: 'Secondary desk',
      profiles: expect.arrayContaining([
        expect.objectContaining({ id: secondary!.id, label: 'Secondary desk', active: true }),
      ]),
    });
    expect(database.prepare('SELECT label FROM credential_metadata WHERE id = ?').get(secondary!.id))
      .toEqual({ label: 'Secondary desk' });
    expect(database.prepare('SELECT credential_profile_label FROM execution_strategies WHERE id = ?').get(strategyId))
      .toEqual({ credential_profile_label: 'Secondary desk' });

    const deletedInactive = await app.inject({
      method: 'DELETE',
      url: `/api/onboarding/accounts/${DEFAULT_CREDENTIAL_PROFILE}`,
      headers: { ...browserHeaders, 'x-gct-credential-intent': 'delete-account' },
    });
    expect(deletedInactive.statusCode).toBe(200);
    expect(deletedInactive.json()).toMatchObject({
      label: 'Secondary desk',
      profiles: [expect.objectContaining({ label: 'Secondary desk', active: true })],
    });
    expect(await vault.get(DEFAULT_CREDENTIAL_PROFILE)).toBeNull();

    const deletedActive = await app.inject({
      method: 'DELETE',
      url: `/api/onboarding/accounts/${secondary!.id}`,
      headers: { ...browserHeaders, 'x-gct-credential-intent': 'delete-account' },
    });
    expect(deletedActive.statusCode).toBe(200);
    expect(deletedActive.json()).toMatchObject({ configured: false, activeProfileId: null, profiles: [] });
    expect(await vault.get(secondary!.id)).toBeNull();
  });

  it('discards authenticated cache at boot when the active .env credentials may have changed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-env-restart-'));
    const config = loadConfig({
      GCT_DATA_DIR: directory,
      GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
      GCT_CREDENTIAL_ENV_PATH: join(directory, '.env'),
    });
    const database = openDatabase(config.databasePath, config.migrationsDir);
    const vault = new EnvFileCredentialVault(config.credentialEnvPath);
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, {
      apiKey: 'new-account-api-key', apiSecret: 'new-account-api-secret',
    });
    database.prepare(`INSERT INTO credential_metadata
      (id, label, provider, created_at, last_verified_at)
      VALUES (?, 'Previous account', 'env_file', '2026-08-11T10:00:00.000Z', '2026-08-11T10:00:00.000Z')`)
      .run(DEFAULT_CREDENTIAL_PROFILE);
    database.prepare(`INSERT INTO live_balances
      (venue, coin, balance, available_balance, equity, unrealized_pnl, updated_at)
      VALUES ('KRAKEN', 'USD', '6.59', '6.59', '7.35', '0.76', '2026-08-11T10:00:00.000Z')`).run();
    const gateway = new FakeCrossExGateway();
    const publicMarketGateway = new FakePublicMarketGateway();
    const tradingSession = new TradingSession();
    const app = await buildApp({
      config, database, credentialVault: vault, crossExGateway: gateway,
      publicMarketGateway, tradingSession, startMarketStream: false, logger: false,
    });
    resources.push({ app, database, vault, gateway, publicMarketGateway, tradingSession, directory });

    expect(database.prepare('SELECT COUNT(*) AS count FROM live_balances').get()).toEqual({ count: 0 });
    expect((await app.inject({
      method: 'GET', url: '/api/trading/snapshot', headers: { host: '127.0.0.1:17840' },
    })).json().balances).toEqual([]);
  });

  it('preserves Chinese through credential setup, verification, and deletion', async () => {
    const { app } = await createTestApp();
    const browserHeaders = { host: '127.0.0.1:5173' };
    const form = await app.inject({
      method: 'GET',
      url: '/secure/credentials?intent=live-trading&lang=zh',
      headers: browserHeaders,
    });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('<html lang="zh-CN">');
    expect(form.body).toContain('无脚本安全设置');
    expect(form.body).toContain('<h1>添加 Gate API 密钥</h1>');
    expect(form.body).toContain('您正在设置实盘交易');
    expect(form.body).toContain('name="lang" value="zh"');
    expect(form.body).not.toContain('Script-free secure setup');

    const saved = await app.inject({
      method: 'POST',
      url: '/secure/credentials',
      headers: {
        ...browserHeaders,
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        csrfToken: csrfTokenFrom(form.body),
        intent: 'live-trading',
        lang: 'zh',
        label: 'Gate 中文连接',
        apiKey: 'chinese-test-key',
        apiSecret: 'chinese-test-secret',
      }).toString(),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain('<html lang="zh-CN">');
    expect(saved.body).toContain('<h1>连接已安全保存</h1>');
    expect(saved.body).toContain('我已保存API密钥 — 启用实盘交易');

    const configuredForm = await app.inject({
      method: 'GET',
      url: '/secure/credentials?lang=zh',
      headers: browserHeaders,
    });
    expect(configuredForm.body).toContain('<h1>替换已保存的 Gate API 密钥</h1>');
    expect(configuredForm.body).toContain('验证并保存新密钥');
    expect(configuredForm.body).toContain('仅验证成功后，才会替换当前已保存的密钥');
    expect(configuredForm.body).toContain('<h2 id="danger-zone-title">危险操作</h2>');
    expect(configuredForm.body).toContain('点击此按钮不会提交上方输入的新密钥');
    expect(configuredForm.body).toContain('删除当前已保存的 API 密钥');
    const deleted = await app.inject({
      method: 'POST',
      url: '/secure/credentials/delete',
      headers: {
        ...browserHeaders,
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ csrfToken: csrfTokenFrom(configuredForm.body), lang: 'zh' }).toString(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toContain('<html lang="zh-CN">');
    expect(deleted.body).toContain('<h1>已删除保存的 API 密钥</h1>');
  });

  it('uses one-time CSRF protection when a browser reports an opaque credential-form origin', async () => {
    const { app, gateway, vault } = await createTestApp();
    const form = await app.inject({
      method: 'GET',
      url: '/secure/credentials?lang=en',
      headers: { host: '127.0.0.1:17840' },
    });
    const validResponse = await app.inject({
      method: 'POST',
      url: '/secure/credentials',
      headers: {
        host: '127.0.0.1:17840',
        origin: 'null',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        csrfToken: csrfTokenFrom(form.body),
        lang: 'en',
        label: 'Opaque-origin Gate key',
        apiKey: 'opaque-origin-api-key',
        apiSecret: 'opaque-origin-api-secret',
      }).toString(),
    });
    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.body).toContain('Connection secured');
    expect(gateway.receivedCredentials).toEqual([{
      apiKey: 'opaque-origin-api-key', apiSecret: 'opaque-origin-api-secret',
    }]);
    expect(await vault.get(DEFAULT_CREDENTIAL_PROFILE)).toEqual({
      apiKey: 'opaque-origin-api-key', apiSecret: 'opaque-origin-api-secret',
    });

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/secure/credentials/delete',
      headers: {
        host: '127.0.0.1:17840',
        origin: 'https://attacker.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ csrfToken: 'invalid-one-time-token-value' }).toString(),
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.headers['content-type']).toContain('text/html');
    expect(invalidResponse.body).toContain('delete request was invalid or expired');
    expect(await vault.get(DEFAULT_CREDENTIAL_PROFILE)).not.toBeNull();
  });

  it('detects credentials populated directly in a vault and verifies them before creating metadata', async () => {
    const { app, database, vault } = await createTestApp();
    await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'manually-added-key', apiSecret: 'manually-added-secret' });

    const connection = await app.inject({
      method: 'GET', url: '/api/onboarding/connection', headers: { host: '127.0.0.1:17840' },
    });
    expect(connection.json()).toMatchObject({ configured: true, storage: 'memory_test_only' });
    expect(database.prepare('SELECT * FROM credential_metadata').all()).toEqual([]);

    const summary = await app.inject({
      method: 'GET', url: '/api/crossex/account-summary',
      headers: { host: '127.0.0.1:17840', 'x-gct-read-intent': 'account-summary' },
    });
    expect(summary.statusCode).toBe(200);
    expect(database.prepare('SELECT provider FROM credential_metadata').get()).toEqual({ provider: 'memory_test_only' });
  });

  it('locks trading, confirms open-order cancellation, and clears account data before deleting credentials', async () => {
    const { app, database, gateway, vault, tradingSession } = await createTestApp({ liveTradingEnabled: true });
    const host = { host: '127.0.0.1:17840' };
    const order = await app.inject({
      method: 'POST',
      url: '/api/trading/orders',
      headers: { ...host, 'x-gct-trading-intent': 'place-order' },
      payload: {
        symbol: 'BINANCE_FUTURE_BTC_USDT',
        side: 'BUY',
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity: '0.001',
        price: '1',
        reduceOnly: false,
      },
    });
    expect(order.statusCode).toBe(200);
    await app.inject({
      method: 'GET',
      url: '/api/crossex/portfolio-snapshot',
      headers: { ...host, 'x-gct-read-intent': 'portfolio-snapshot' },
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM portfolio_snapshots').get()).toEqual({ count: 1 });

    const form = await app.inject({ method: 'GET', url: '/secure/credentials', headers: { host: '127.0.0.1:5173' } });
    const deleted = await app.inject({
      method: 'POST',
      url: '/secure/credentials/delete',
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ csrfToken: csrfTokenFrom(form.body) }).toString(),
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toContain('Saved credentials deleted');
    expect(tradingSession.current).toBe('readonly');
    expect(gateway.cancelledOrders).toEqual(['live-1']);
    expect(await vault.get(DEFAULT_CREDENTIAL_PROFILE)).toBeNull();
    expect(database.prepare('SELECT COUNT(*) AS count FROM portfolio_snapshots').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM live_positions').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM live_balances').get()).toEqual({ count: 0 });
  });

  it('rejects an expired one-time CSRF token without storing credentials', async () => {
    const { app, gateway, vault } = await createTestApp();
    const payload = new URLSearchParams({
      csrfToken: 'not-a-real-csrf-token-value',
      label: 'Gate',
      apiKey: 'example-api-key',
      apiSecret: 'example-api-secret',
    }).toString();
    const response = await app.inject({
      method: 'POST',
      url: '/secure/credentials',
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(gateway.receivedCredentials).toEqual([]);
    expect(await vault.get(DEFAULT_CREDENTIAL_PROFILE)).toBeNull();
  });
});
