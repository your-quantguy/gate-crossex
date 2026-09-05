import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { PublicMarketDataError, type PublicMarketDataGateway } from '@gate-crossex/public-data';
import { reconcilePortfolioSnapshots, stalePortfolioReconciliation } from '@gate-crossex/domain';
import {
  BorosUpstreamMarketFeesResponseSchema,
  BorosUpstreamStrategiesResponseSchema,
  CrossExTransferAccountSchema,
  CrossExTransferRequestSchema,
  canonicalizeCrossExTransfer,
  crossExTransferRouteError,
  UserPreferencesSchema,
  type UserPreferencesResponse,
  type UnresolvedOrder,
} from '@gate-crossex/shared-types';
import type {
  BorosStrategiesResponse,
  CandleInterval,
  CandleSeriesResponse,
  CredentialConnectionStatus,
  CrossExInstrument,
  CrossExInstrumentCatalog,
  CrossExRiskLimit,
  CrossExRiskLimitResponse,
  CrossExPortfolioActivityResponse,
  CrossExTransferBalancesResponse,
  CrossExTransferCoinsResponse,
  CrossExTransferRecord,
  CrossExAccountBookRecord,
  FundingHistoryResponse,
  FundingHistorySeriesResponse,
  FundingOverviewResponse,
  HealthResponse,
  MarketCatalogAsset,
  MarketCatalogResponse,
  MarketCatalogVenue,
  PortfolioFuturesPosition,
  PortfolioSnapshot,
  ReconciliationReportList,
  PublicMarketSnapshotResponse,
  ReadOnlyAccountSummary,
  SystemDiscovery,
  VenueFeeRatesResponse,
} from '@gate-crossex/shared-types';
import type { BackendConfig } from './config.js';
import { CredentialOperationBusyError, CredentialOperationGate } from './credential-operation-gate.js';
import {
  CredentialVaultUnavailableError,
  DEFAULT_CREDENTIAL_PROFILE,
  type CredentialVault,
  type CredentialStorageProvider,
  type GateCredentials,
  type SelectableCredentialStorageProvider,
} from './credential-vault.js';
import { OneTimeCsrfTokens } from './csrf.js';
import { GateApiError, type GateCrossExAccount, type GateCrossExPortfolio, type GateCrossExPosition, type GateCrossExRiskLimit, type GateCrossExSymbol, type GateTransferRecord, type GateAccountBookRecord, type PortfolioOperationsCrossExGateway, type ReadOnlyCrossExGateway, type TradingCrossExGateway } from './crossex-client.js';
import { CandleStore } from './candle-store.js';
import { FundingHistoryService } from './funding-history.js';
import { FundingOverviewService } from './funding-overview.js';
import { canonicalMarketAsset } from './market-asset-aliases.js';
import { CrossExMarketHub, CANDLE_INTERVALS, type MarketDefinition, type MarketHubMessage } from './market-hub.js';
import { StrategyEngine, StrategyEngineError, type StrategyEngineOptions } from './strategy-engine.js';
import { TradingSession } from './trading-session.js';
import { TradingRuntime, TradingRuntimeError, unresolvedOrderDetails } from './trading-runtime.js';
import { CrossExPrivateStream } from './private-stream.js';
import { LivePortfolioStore, type LivePortfolioSnapshot } from './live-portfolio.js';
import { readDatabaseStatus } from './database.js';
import { runDatabaseMaintenance } from './database-maintenance.js';
import {
  addAuditEvent,
  deleteCredentialMetadata,
  getCredentialMetadata,
  listCredentialMetadata,
  readActiveCredentialProfile,
  readInstrumentCatalog,
  readLatestPortfolioSnapshot,
  readPublicMarketSnapshot,
  readRiskLimit,
  readUserPreferences,
  saveUserPreferences,
  recordMarketDataFailure,
  replaceInstrumentCatalog,
  replaceRiskLimits,
  listReconciliationReports,
  savePortfolioSnapshot,
  saveReconciliationReport,
  saveActiveCredentialProfile,
  upsertPublicMarketSnapshot,
  upsertCredentialMetadata,
} from './repositories.js';
import {
  renderCredentialDeletedPage,
  renderCredentialEntryPage,
  renderCredentialSuccessPage,
  renderCredentialSwitchSuccessPage,
  type SecureCredentialLanguage,
} from './secure-credential-page.js';

const API_DOCS_RETRIEVED_AT = '2026-08-01';
const API_DOCS_VERSION = 'Gate CrossEx REST v1.0.2 / WebSocket v1.0.0';
const MARKET_REFERENCE_CACHE_MS = 5 * 60_000;
const STREAM_VOLATILE_EMIT_INTERVAL_MS = 200;
const STREAM_STATUS_INTERVAL_MS = 20_000;
const MAX_STREAM_TRADE_BATCH = 80;
const MARKET_CATALOG_FRESH_MS = 30 * 60_000;
const PUBLIC_SNAPSHOT_FRESH_MS = 4_000;
const BOROS_STRATEGIES_URL = 'https://api-boros.pendle.finance/apis/v1/strategies';
const BOROS_MARKETS_URL = 'https://api-boros.pendle.finance/apis/v1/markets/by-ids';
const BOROS_STRATEGIES_CACHE_MS = 30_000;

const CATALOG_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'] as const;
const QUOTE_PREFERENCE = ['USDT', 'USDC', 'USD'] as const;
const CROSSEX_FUTURE_SYMBOL = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_([A-Z0-9]+)_(USDT|USDC|USD)$/;
const STRATEGY_ID = /^(AUTO|PAIR|PREM|CLOSE)-[A-Z0-9]{8}$/;
const FundingHistoryRequestSchema = z.object({
  symbols: z.array(z.string().regex(CROSSEX_FUTURE_SYMBOL)).min(1).max(50),
  durationDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(30),
});
const FundingRankingRequestSchema = z.object({
  symbols: z.array(z.string().regex(CROSSEX_FUTURE_SYMBOL)).min(1).max(5_000),
  durationDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});
const FundingHistorySeriesRequestSchema = z.object({
  symbols: z.array(z.string().regex(CROSSEX_FUTURE_SYMBOL)).min(1).max(7),
  durationDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});

interface DerivedMarketCatalog {
  fetchedAt: string;
  assets: Map<string, MarketCatalogVenue[]>;
  liveSymbols: Set<string>;
}

/** Group live FUTURE instruments by asset with one venue entry each (preferred quote first). */
function deriveMarketCatalog(items: CrossExInstrument[], fetchedAt: string): DerivedMarketCatalog {
  const assets = new Map<string, Map<string, MarketCatalogVenue>>();
  const liveSymbols = new Set<string>();
  for (const item of items) {
    if (item.businessType !== 'FUTURE' || item.state !== 'live') continue;
    const match = CROSSEX_FUTURE_SYMBOL.exec(item.symbol);
    if (!match) continue;
    const [, venue, nativeAsset, quote] = match;
    if (!venue || !nativeAsset || !quote || !(CATALOG_VENUES as readonly string[]).includes(venue)) continue;
    const asset = canonicalMarketAsset(venue, item.businessType, nativeAsset);
    liveSymbols.add(item.symbol);
    const venues = assets.get(asset) ?? new Map<string, MarketCatalogVenue>();
    const existing = venues.get(venue);
    const rank = (value: string) => { const index = (QUOTE_PREFERENCE as readonly string[]).indexOf(value); return index === -1 ? QUOTE_PREFERENCE.length : index; };
    if (!existing || rank(quote) < rank(existing.quote)) {
      venues.set(venue, { venue, symbol: item.symbol, quote });
    }
    assets.set(asset, venues);
  }
  const ordered = new Map<string, MarketCatalogVenue[]>();
  for (const asset of [...assets.keys()].sort()) {
    const venues = assets.get(asset);
    if (!venues) continue;
    ordered.set(asset, [...venues.values()].sort((left, right) => (CATALOG_VENUES as readonly string[]).indexOf(left.venue) - (CATALOG_VENUES as readonly string[]).indexOf(right.venue)));
  }
  return { fetchedAt, assets: ordered, liveSymbols };
}

const CredentialContextSchema = z.object({
  intent: z.literal('live-trading').optional(),
  lang: z.enum(['en', 'zh']).optional(),
  action: z.literal('add').optional(),
});
const CredentialFormSchema = CredentialContextSchema.extend({
  csrfToken: z.string().min(20).max(200),
  label: z.string().trim().min(1).max(80).refine(noControlCharacters),
  apiKey: z.string().min(8).max(256).refine(noControlCharacters),
  apiSecret: z.string().min(8).max(512).refine(noControlCharacters),
  storageProvider: z.enum(['os_keychain', 'env_file']).optional(),
});

function hasLiveTradingCredentialIntent(value: unknown): boolean {
  const parsed = CredentialContextSchema.safeParse(value);
  return parsed.success && parsed.data.intent === 'live-trading';
}

function secureCredentialLanguage(value: unknown): SecureCredentialLanguage {
  const parsed = CredentialContextSchema.safeParse(value);
  return parsed.success && parsed.data.lang === 'zh' ? 'zh' : 'en';
}

function credentialPageMessage(language: SecureCredentialLanguage, english: string, chinese: string): string {
  return language === 'zh' ? chinese : english;
}

const DeleteCredentialFormSchema = CredentialContextSchema.extend({
  csrfToken: z.string().min(20).max(200),
});
const CredentialProfileIdSchema = z.string().regex(/^gate-crossex-(?:default|account-[0-9a-f-]{36})$/);
const SwitchCredentialFormSchema = CredentialContextSchema.extend({
  csrfToken: z.string().min(20).max(200),
  profileId: CredentialProfileIdSchema,
});
const CredentialProfileParamsSchema = z.object({ profileId: CredentialProfileIdSchema });
const WebAccountSwitchSchema = z.object({
  confirmPauseRunningStrategies: z.boolean().default(false),
});
const WebAccountRenameSchema = z.object({
  label: z.string().trim().min(1).max(80).refine(noControlCharacters),
});

export interface BuildAppOptions {
  config: BackendConfig;
  database: Database.Database;
  credentialVault: CredentialVault;
  crossExGateway: ReadOnlyCrossExGateway;
  publicMarketGateway: PublicMarketDataGateway;
  marketHub?: CrossExMarketHub;
  tradingSession?: TradingSession;
  startMarketStream?: boolean;
  logger?: boolean;
  rateLimitMax?: number;
  /** Test seam for the fixed, public Boros strategy endpoint. */
  borosStrategyFetcher?: () => Promise<unknown>;
  /** Test seam for the public Boros market fee configuration endpoint. */
  borosMarketFeeFetcher?: (marketIds: number[]) => Promise<unknown>;
  /** Engine timing overrides; tests shorten the remote-confirmation timeout. */
  strategyEngineOptions?: StrategyEngineOptions;
}

async function fetchBorosStrategyPayload(): Promise<unknown> {
  const response = await fetch(BOROS_STRATEGIES_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Boros strategies returned HTTP ${response.status}`);
  return response.json();
}

async function fetchBorosMarketFeePayload(marketIds: number[]): Promise<unknown> {
  const url = new URL(BOROS_MARKETS_URL);
  url.searchParams.set('marketIds', marketIds.join(','));
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Boros markets returned HTTP ${response.status}`);
  return response.json();
}

function fixedX18Rate(value: string): number {
  const rate = Number(value) / 1e18;
  if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid Boros fixed-point fee rate');
  return rate;
}

function noControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
}

function storedCredentialProvider(value: string | undefined, fallback: CredentialStorageProvider): CredentialStorageProvider {
  return value === 'os_keychain' || value === 'env_file' || value === 'memory_test_only' || value === 'unavailable'
    ? value
    : fallback;
}

function hostnameFromHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    return closingBracket > 0 ? value.slice(1, closingBracket) : null;
  }
  return value.split(':', 1)[0] || null;
}

function isAllowedBrowserOrigin(origin: string, hostHeader: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
  if (allowedOrigins.has(origin)) return true;
  if (!hostHeader) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

function isCsrfProtectedCredentialForm(method: string, url: string): boolean {
  if (method !== 'POST') return false;
  const pathname = url.split('?', 1)[0];
  return pathname === '/secure/credentials'
    || pathname === '/secure/credentials/delete'
    || pathname === '/secure/credentials/switch';
}

function setSecureHtml(reply: FastifyReply, rendered: { html: string; csp: string }, statusCode = 200): FastifyReply {
  return reply
    .code(statusCode)
    .header('Cache-Control', 'no-store, max-age=0')
    .header('Pragma', 'no-cache')
    .header('Content-Security-Policy', rendered.csp)
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Frame-Options', 'DENY')
    .type('text/html; charset=utf-8')
    .send(rendered.html);
}

function summarizeAccount(account: GateCrossExAccount, verifiedAt: string): ReadOnlyAccountSummary {
  const remoteUpdateMilliseconds = Number(account.update_time);
  const remoteUpdatedAt = Number.isFinite(remoteUpdateMilliseconds)
    ? new Date(remoteUpdateMilliseconds).toISOString()
    : account.update_time;
  return {
    availableMargin: account.available_margin,
    marginBalance: account.margin_balance,
    initialMargin: account.initial_margin,
    maintenanceMargin: account.maintenance_margin,
    initialMarginRate: account.initial_margin_rate,
    maintenanceMarginRate: account.maintenance_margin_rate,
    positionMode: account.position_mode,
    accountMode: account.account_mode,
    exchangeType: account.exchange_type,
    venues: [...new Set(account.assets.map((asset) => asset.exchange_type))].sort(),
    assetCount: account.assets.length,
    remoteUpdatedAt,
    verifiedAt,
  };
}

function normalizeInstrument(symbol: GateCrossExSymbol): CrossExInstrument {
  return {
    symbol: symbol.symbol,
    exchangeType: symbol.exchange_type,
    businessType: symbol.business_type,
    state: symbol.state,
    minSize: symbol.min_size,
    minNotional: symbol.min_notional,
    lotSize: symbol.lot_size,
    tickSize: symbol.tick_size,
    maxNumOrders: symbol.max_num_orders,
    maxMarketSize: symbol.max_market_size,
    maxLimitSize: symbol.max_limit_size,
    contractSize: symbol.contract_size,
    liquidationFee: symbol.liquidation_fee,
    defaultLeverage: symbol.default_leverage ?? null,
    delistTime: symbol.delist_time,
  };
}

function normalizeRiskLimit(limit: GateCrossExRiskLimit): CrossExRiskLimit {
  return {
    symbol: limit.symbol,
    tiers: limit.tiers.map((tier) => ({
      tier: tier.tier,
      minRiskLimitValue: tier.min_risk_limit_value,
      maxRiskLimitValue: tier.max_risk_limit_value,
      quickCalAmount: tier.quick_cal_amount,
      leverageMax: tier.leverage_max,
      maintenanceRate: tier.maintenance_rate,
    })),
  };
}

function isFresh(timestamp: string, now: number): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && now - parsed < MARKET_REFERENCE_CACHE_MS;
}

function millisecondTimestamp(value: string | number): string {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : String(value);
}

function normalizeFuturesPositions(
  positions: GateCrossExPosition[],
  adlRanks: NonNullable<GateCrossExPortfolio['adlRanks']> = [],
): PortfolioFuturesPosition[] {
  const adlBySymbol = new Map(adlRanks.map((rank) => [rank.symbol, rank]));
  return positions.map((position) => ({
    positionId: position.position_id, symbol: position.symbol, positionSide: position.position_side,
    initialMargin: position.initial_margin, maintenanceMargin: position.maintenance_margin,
    quantity: position.position_qty, value: position.position_value, unrealizedPnl: position.upnl,
    unrealizedPnlRate: position.upnl_rate, entryPrice: position.entry_price, markPrice: position.mark_price,
    leverage: position.leverage, maxLeverage: position.max_leverage, riskLimit: position.risk_limit,
    fee: position.fee, fundingFee: position.funding_fee, fundingTime: position.funding_time,
    createdAt: millisecondTimestamp(position.create_time), updatedAt: millisecondTimestamp(position.update_time),
    realizedPnl: position.closed_pnl,
    crossExAdlRank: adlBySymbol.get(position.symbol)?.crossex_adl_rank ?? null,
    exchangeAdlRank: adlBySymbol.get(position.symbol)?.exchange_adl_rank ?? null,
  }));
}

function normalizePortfolio(portfolio: GateCrossExPortfolio, fetchedAt: string): PortfolioSnapshot {
  const { account } = portfolio;
  return {
    account: {
      availableMargin: account.available_margin, marginBalance: account.margin_balance,
      initialMargin: account.initial_margin, maintenanceMargin: account.maintenance_margin,
      initialMarginRate: account.initial_margin_rate, maintenanceMarginRate: account.maintenance_margin_rate,
      positionMode: account.position_mode, accountMode: account.account_mode,
      exchangeType: account.exchange_type, remoteUpdatedAt: millisecondTimestamp(account.update_time),
    },
    balances: account.assets.map((asset) => ({
      venue: asset.exchange_type, coin: asset.coin, balance: asset.balance, unrealizedPnl: asset.upnl,
      equity: asset.equity, futuresInitialMargin: asset.futures_initial_margin,
      futuresMaintenanceMargin: asset.futures_maintenance_margin,
      borrowingInitialMargin: asset.borrowing_initial_margin,
      borrowingMaintenanceMargin: asset.borrowing_maintenance_margin,
      availableBalance: asset.available_balance, liability: asset.liability,
    })),
    futuresPositions: normalizeFuturesPositions(portfolio.positions, portfolio.adlRanks),
    marginPositions: portfolio.marginPositions.map((position) => ({
      positionId: position.position_id, symbol: position.symbol, positionSide: position.position_side,
      initialMargin: position.initial_margin, maintenanceMargin: position.maintenance_margin,
      assetQuantity: position.asset_qty, assetCoin: position.asset_coin, value: position.position_value,
      liability: position.liability, liabilityCoin: position.liability_coin, interest: position.interest,
      maxPositionQuantity: position.max_position_qty, entryPrice: position.entry_price,
      indexPrice: position.index_price, unrealizedPnl: position.upnl, unrealizedPnlRate: position.upnl_rate,
      leverage: position.leverage, maxLeverage: position.max_leverage,
      createdAt: millisecondTimestamp(position.create_time), updatedAt: millisecondTimestamp(position.update_time),
    })),
    openOrders: portfolio.openOrders.map((order) => ({
      orderId: order.order_id, clientOrderId: order.client_order_id ?? order.text ?? '', state: order.state,
      symbol: order.symbol, side: order.side, type: order.type, attribute: order.attribute,
      venue: order.exchange_type, product: order.business_type, quantity: order.qty,
      quoteQuantity: order.quote_qty, price: order.price, timeInForce: order.time_in_force,
      executedQuantity: order.executed_qty, executedAmount: order.executed_amount,
      executedAveragePrice: order.executed_avg_price, feeCoin: order.fee_coin, fee: order.fee,
      reduceOnly: order.reduce_only, leverage: order.leverage, reason: order.reason,
      positionSide: order.position_side, createdAt: millisecondTimestamp(order.create_time),
      updatedAt: millisecondTimestamp(order.update_time),
    })),
    recentFills: portfolio.recentTrades.map((trade) => ({
      transactionId: trade.transaction_id, orderId: trade.order_id, clientOrderId: trade.text,
      symbol: trade.symbol, venue: trade.exchange_type, product: trade.business_type, side: trade.side,
      quantity: trade.qty, price: trade.price, fee: trade.fee, feeCoin: trade.fee_coin,
      feeRate: trade.fee_rate, matchRole: trade.match_role, realizedPnl: trade.rpnl,
      positionMode: trade.position_mode, positionSide: trade.position_side,
      createdAt: millisecondTimestamp(trade.create_time),
    })),
    fetchedAt,
    source: 'gate_crossex_authenticated_rest',
  };
}

function normalizeTransferRecords(records: GateTransferRecord[]): CrossExTransferRecord[] {
  return records.map((record) => ({
    id: record.id,
    text: record.text,
    from: record.from_account_type,
    to: record.to_account_type,
    coin: record.coin,
    amount: record.amount,
    actualReceive: record.actual_receive,
    status: record.status,
    failureReason: record.fail_reason,
    createdAt: millisecondTimestamp(record.create_time),
    updatedAt: millisecondTimestamp(record.update_time),
  }));
}

function normalizeAccountBook(records: GateAccountBookRecord[]): CrossExAccountBookRecord[] {
  return records.map((record) => ({
    id: record.id,
    businessId: record.business_id,
    statementType: record.statement_type,
    venue: record.exchange_type,
    coin: record.coin,
    symbol: record.symbol ?? null,
    change: record.change,
    balance: record.balance,
    createdAt: millisecondTimestamp(record.create_time),
  }));
}

function safeCredentialError(error: unknown, language: SecureCredentialLanguage): string {
  if (error instanceof CredentialVaultUnavailableError) {
    return credentialPageMessage(language, 'The selected credential store is unavailable.', '所选凭证存储方式不可用。');
  }
  if (error instanceof StrategyEngineError && error.code === 'credential_change_blocked_by_open_orders') {
    // Name the orders so the user can cancel them on Gate instead of guessing which rows are stuck.
    const details = error.details?.unresolvedOrders;
    const blocking = Array.isArray(details) ? details as UnresolvedOrder[] : [];
    const summary = blocking.map((order) => `${order.symbol} ${order.side} ${order.quantity} · ${order.state} · ${order.reason}`).join('; ');
    return credentialPageMessage(
      language,
      `The credential change was blocked because one or more live orders could not be confirmed canceled. The old credential remains configured and trading remains locked.${summary ? ` Unconfirmed orders: ${summary}.` : ''}`,
      `由于一个或多个实盘订单无法确认已取消，API 密钥更改被阻止。旧 API 密钥仍保持配置，交易继续锁定。${summary ? `未确认的订单：${summary}。` : ''}`,
    );
  }
  if (error instanceof GateApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return credentialPageMessage(language, 'Gate rejected the credentials or required permissions are missing.', 'Gate 拒绝了该 API 密钥，或 API 密钥缺少所需权限。');
    }
    if (error.label === 'NETWORK_ERROR') {
      return credentialPageMessage(language, 'The local backend could not reach the Gate API. No credentials were stored.', '本地后端无法连接 Gate API。未存储任何 API 密钥。');
    }
    if (error.label === 'INVALID_ACCOUNT_RESPONSE') {
      return credentialPageMessage(language, 'Gate returned an account response that did not match the documented schema.', 'Gate 返回的账户响应与文档中的数据结构不符。');
    }
    return credentialPageMessage(language, `Gate rejected the account verification (${error.label}).`, `Gate 拒绝了账户验证（${error.label}）。`);
  }
  return credentialPageMessage(language, 'Credential verification failed. No credentials were stored.', 'API 密钥验证失败。未存储任何 API 密钥。');
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, database, crossExGateway, publicMarketGateway } = options;
  const storedCredentialVault = options.credentialVault;
  const storedProfilesAtBoot = listCredentialMetadata(database);
  for (const profile of storedProfilesAtBoot) {
    if (profile.provider === 'os_keychain' || profile.provider === 'env_file') {
      storedCredentialVault.setPreferredProvider?.(profile.id, profile.provider);
    }
  }
  const persistedActiveProfile = readActiveCredentialProfile(database);
  let activeCredentialProfileId: string | null = persistedActiveProfile === undefined
    ? storedProfilesAtBoot.some((profile) => profile.id === DEFAULT_CREDENTIAL_PROFILE)
      ? DEFAULT_CREDENTIAL_PROFILE
      : storedProfilesAtBoot[0]?.id ?? DEFAULT_CREDENTIAL_PROFILE
    : persistedActiveProfile && storedProfilesAtBoot.some((profile) => profile.id === persistedActiveProfile)
      ? persistedActiveProfile
      : null;
  const resolveActiveProfile = (profile: string): string | null => (
    profile === DEFAULT_CREDENTIAL_PROFILE ? activeCredentialProfileId : profile
  );
  const credentialVault: CredentialVault = {
    provider: storedCredentialVault.provider,
    availableProviders: storedCredentialVault.availableProviders,
    async set(profile, credentials, provider) {
      return storedCredentialVault.set(resolveActiveProfile(profile) ?? DEFAULT_CREDENTIAL_PROFILE, credentials, provider);
    },
    async get(profile) {
      const resolved = resolveActiveProfile(profile);
      return resolved ? storedCredentialVault.get(resolved) : null;
    },
    async getProvider(profile) {
      const resolved = resolveActiveProfile(profile);
      return resolved ? storedCredentialVault.getProvider(resolved) : null;
    },
    async delete(profile) {
      const resolved = resolveActiveProfile(profile);
      return resolved ? storedCredentialVault.delete(resolved) : false;
    },
    setPreferredProvider(profile, provider) {
      const resolved = resolveActiveProfile(profile);
      if (resolved) storedCredentialVault.setPreferredProvider?.(resolved, provider);
    },
  };
  const activeProviderAtBoot = activeCredentialProfileId
    ? await storedCredentialVault.getProvider(activeCredentialProfileId)
    : null;
  const activeMetadataAtBoot = activeCredentialProfileId
    ? getCredentialMetadata(database, activeCredentialProfileId)
    : null;
  if (activeProviderAtBoot === 'env_file'
    || activeMetadataAtBoot?.provider === 'env_file'
    || (activeMetadataAtBoot !== null && activeProviderAtBoot === null)) {
    // The .env fallback is deliberately user-editable outside the app, and any provider can be
    // cleared outside this process. Never paint an authenticated cache whose account identity
    // cannot be proven against the credential store available at this boot.
    database.transaction(() => {
      database.prepare('DELETE FROM live_balances').run();
      database.prepare('DELETE FROM live_positions').run();
      database.prepare('DELETE FROM portfolio_snapshots').run();
      database.prepare('DELETE FROM reconciliation_reports').run();
    })();
  }
  const marketHub = options.marketHub ?? new CrossExMarketHub(config.gatePublicWebSocketUrl);
  const tradingSession = options.tradingSession ?? new TradingSession();
  const credentialOperationGate = new CredentialOperationGate();
  const runAuthenticatedWrite = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await credentialOperationGate.runAuthenticatedWrite(work);
    } catch (error) {
      if (error instanceof CredentialOperationBusyError) {
        throw new TradingRuntimeError('credential_mutation_in_progress', 409);
      }
      throw error;
    }
  };
  const acquireCredentialMutation = async (): Promise<() => void> => {
    try {
      return await credentialOperationGate.acquireCredentialMutation();
    } catch (error) {
      if (error instanceof CredentialOperationBusyError) {
        throw new TradingRuntimeError('credential_mutation_in_progress', 409);
      }
      throw error;
    }
  };
  const tradingRuntime = new TradingRuntime(database, tradingSession, credentialVault, crossExGateway, {
    runAuthenticatedWrite,
  });
  const privateStream = new CrossExPrivateStream(config.gatePrivateWebSocketUrl, credentialVault);
  const cachedPortfolioAtBoot = readLatestPortfolioSnapshot(database);
  const livePortfolio = new LivePortfolioStore(
    cachedPortfolioAtBoot ? {
      snapshot: cachedPortfolioAtBoot,
      dataStatus: 'stale',
      remoteStatus: 'unavailable',
      reconciliation: stalePortfolioReconciliation(randomUUID(), new Date().toISOString(), cachedPortfolioAtBoot),
    } : null,
    privateStream.snapshot(),
  );
  let triggerPortfolioRefresh: (() => void) | null = null;
  let previousPrivateStreamState = privateStream.snapshot().state;
  privateStream.subscribe((event) => {
    try {
      livePortfolio.ingest(event);
      tradingRuntime.ingestPrivateEvent(event);
    } catch (error) {
      app.log.error({ err: error, channel: event.channel }, 'failed to ingest private stream event');
    }
  });
  privateStream.subscribeStatus((status) => {
    livePortfolio.setStreamStatus(status);
    if (status.state === 'live' && previousPrivateStreamState !== 'live') triggerPortfolioRefresh?.();
    previousPrivateStreamState = status.state;
  });
  const csrfTokens = new OneTimeCsrfTokens();
  let feeCache: { fees: VenueFeeRatesResponse['fees']; fetchedAt: string } | null = null;
  let feeFetchInFlight: {
    generation: number;
    promise: Promise<{ fees: VenueFeeRatesResponse['fees']; fetchedAt: string }>;
  } | null = null;
  let transferCoinCache: { items: CrossExTransferCoinsResponse['items']; fetchedAt: string } | null = null;
  let transferCoinFetchInFlight: Promise<{ items: CrossExTransferCoinsResponse['items']; fetchedAt: string }> | null = null;
  let sizeUnitCache: { units: Record<string, string>; fetchedAt: string; complete: boolean; marketCount: number } | null = null;
  let sizeUnitInFlight: Promise<void> | null = null;
  let borosStrategyCache: BorosStrategiesResponse | null = null;
  let borosStrategyFetchInFlight: Promise<BorosStrategiesResponse> | null = null;
  const loadBorosStrategies = (): Promise<BorosStrategiesResponse> => {
    if (borosStrategyCache && Date.now() - Date.parse(borosStrategyCache.fetchedAt) < BOROS_STRATEGIES_CACHE_MS) {
      return Promise.resolve(borosStrategyCache);
    }
    borosStrategyFetchInFlight ??= (async () => {
      const payload = await (options.borosStrategyFetcher ?? fetchBorosStrategyPayload)();
      const parsed = BorosUpstreamStrategiesResponseSchema.parse(payload);
      let strategies = parsed.strategies;
      if (options.borosMarketFeeFetcher || !options.borosStrategyFetcher) {
        try {
          const marketIds = [...new Set(strategies.flatMap((strategy) => [strategy.longMarket.marketId, strategy.shortMarket.marketId]))];
          const feePayload = await (options.borosMarketFeeFetcher ?? fetchBorosMarketFeePayload)(marketIds);
          const marketFees = BorosUpstreamMarketFeesResponseSchema.parse(feePayload);
          const feeByMarket = new Map(marketFees.results.map((market) => [market.marketId, {
            takerFeeRate: fixedX18Rate(market.config.takerFee),
            settleFeeRate: fixedX18Rate(market.extConfig.settleFeeRate),
            initialMarginFactor: fixedX18Rate(market.config.kIM),
            marginRateFloor: market.imData.marginFloor,
            marginTimeFloorSeconds: market.config.tThresh,
            timeToMaturitySeconds: market.data.timeToMaturity,
          }]));
          strategies = strategies.map((strategy) => ({
            ...strategy,
            longMarket: { ...strategy.longMarket, ...feeByMarket.get(strategy.longMarket.marketId) },
            shortMarket: { ...strategy.shortMarket, ...feeByMarket.get(strategy.shortMarket.marketId) },
          }));
        } catch (error) {
          app.log.warn({ reason: error instanceof Error ? error.message : 'invalid_response' }, 'Boros market fee enrichment failed');
        }
      }
      const refreshed: BorosStrategiesResponse = {
        ...parsed,
        strategies,
        fetchedAt: new Date().toISOString(),
        cacheStatus: 'fresh',
        source: 'boros_open_api',
      };
      borosStrategyCache = refreshed;
      return refreshed;
    })().finally(() => { borosStrategyFetchInFlight = null; });
    return borosStrategyFetchInFlight;
  };
  const selectableStorageProviders = storedCredentialVault.availableProviders.filter(
    (provider): provider is SelectableCredentialStorageProvider => provider === 'os_keychain' || provider === 'env_file',
  );
  let positionsRefreshGeneration: number | null = null;

  const fetchTransferCoins = async (): Promise<{ items: CrossExTransferCoinsResponse['items']; fetchedAt: string }> => {
    if (transferCoinCache && Date.now() - Date.parse(transferCoinCache.fetchedAt) < 10 * 60_000) return transferCoinCache;
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryTransferCoins) throw new GateApiError(503, 'TRANSFER_COINS_UNAVAILABLE');
    transferCoinFetchInFlight ??= (async () => {
      const coins = await operationsGateway.queryTransferCoins!();
      const refreshed = {
        items: coins
          .map((coin) => ({
            coin: coin.coin,
            minimumAmount: coin.min_trans_amount,
            estimatedFee: coin.est_fee,
            precision: coin.precision,
            disabled: coin.is_disabled !== 0,
          }))
          .sort((left, right) => left.coin.localeCompare(right.coin)),
        fetchedAt: new Date().toISOString(),
      };
      transferCoinCache = refreshed;
      return refreshed;
    })().finally(() => { transferCoinFetchInFlight = null; });
    return transferCoinFetchInFlight;
  };

  // --- Instrument catalog: one fetch path shared by /api/crossex/instruments and /api/markets/catalog.
  let instrumentFetchInFlight: Promise<{ items: CrossExInstrument[]; fetchedAt: string }> | null = null;
  const fetchInstrumentCatalog = () => {
    instrumentFetchInFlight ??= (async () => {
      const items = (await crossExGateway.querySymbols())
        .map(normalizeInstrument)
        .sort((left, right) => left.symbol.localeCompare(right.symbol));
      const fetchedAt = new Date().toISOString();
      replaceInstrumentCatalog(database, items, fetchedAt);
      return { items, fetchedAt };
    })().finally(() => { instrumentFetchInFlight = null; });
    return instrumentFetchInFlight;
  };
  const riskLimitFetches = new Map<string, Promise<{ item: CrossExRiskLimit; fetchedAt: string } | null>>();
  const fetchRiskLimit = (symbol: string) => {
    const existing = riskLimitFetches.get(symbol);
    if (existing) return existing;
    const pending = (async () => {
      const limits = (await crossExGateway.queryRiskLimits([symbol])).map(normalizeRiskLimit);
      const item = limits.find((limit) => limit.symbol === symbol) ?? null;
      if (!item) return null;
      const fetchedAt = new Date().toISOString();
      replaceRiskLimits(database, limits, fetchedAt);
      return { item, fetchedAt };
    })().finally(() => {
      if (riskLimitFetches.get(symbol) === pending) riskLimitFetches.delete(symbol);
    });
    riskLimitFetches.set(symbol, pending);
    return pending;
  };
  const publicSnapshotFetches = new Map<string, Promise<PublicMarketSnapshotResponse['snapshot']>>();
  const fetchPublicSnapshot = (symbol: string) => {
    const existing = publicSnapshotFetches.get(symbol);
    if (existing) return existing;
    const pending = (async () => {
      const snapshot = await publicMarketGateway.querySnapshot(symbol);
      upsertPublicMarketSnapshot(database, snapshot);
      return snapshot;
    })().finally(() => {
      if (publicSnapshotFetches.get(symbol) === pending) publicSnapshotFetches.delete(symbol);
    });
    publicSnapshotFetches.set(symbol, pending);
    return pending;
  };

  let derivedCatalog: DerivedMarketCatalog | null = null;
  const derivedMarketCatalog = (): DerivedMarketCatalog | null => {
    const cached = readInstrumentCatalog(database);
    if (!cached) return null;
    if (!derivedCatalog || derivedCatalog.fetchedAt !== cached.fetchedAt) {
      derivedCatalog = deriveMarketCatalog(cached.items, cached.fetchedAt);
    }
    return derivedCatalog;
  };

  /**
   * All venue legs to stream for the asset of `symbol`, from the cached catalog only — this runs
   * on the watch path and must never block on upstream. Includes the exact requested symbol when
   * it is a live instrument, even if its quote is not the venue-preferred one.
   */
  const marketDefinitionsFor = (symbol: string): MarketDefinition[] | null => {
    const match = CROSSEX_FUTURE_SYMBOL.exec(symbol);
    if (!match) return null;
    const [, venue, nativeAsset] = match;
    const catalog = derivedMarketCatalog();
    if (!catalog || !venue || !nativeAsset) return null;
    const asset = canonicalMarketAsset(venue, 'FUTURE', nativeAsset);
    const definitions: MarketDefinition[] = (catalog.assets.get(asset) ?? [])
      .map((entry) => ({ symbol: entry.symbol, venue: entry.venue as MarketDefinition['venue'], asset }));
    if (catalog.liveSymbols.has(symbol) && !definitions.some((definition) => definition.symbol === symbol)) {
      definitions.push({ symbol, venue: venue as MarketDefinition['venue'], asset });
    }
    return definitions.length > 0 ? definitions : null;
  };

  const ensureMarketKnown = (symbol: string): boolean => {
    if (marketHub.market(symbol)) return true;
    const definitions = marketDefinitionsFor(symbol);
    return definitions !== null && marketHub.ensureMarkets(definitions) && marketHub.market(symbol) !== null;
  };

  // Strategies may trade catalog-only tickers (e.g. stock perps) that nothing has watched yet, so
  // the engine's market source can register them on demand at launch.
  const strategyEngine = new StrategyEngine(database, tradingSession, tradingRuntime, {
    market: (symbol) => marketHub.market(symbol),
    ensureMarket: ensureMarketKnown,
    // Unit/injected hubs may deliberately supply static market objects without starting a socket.
    // Production passes startMarketStream=true, where stream health must gate every strategy.
    ...(options.startMarketStream ? { connectionState: () => marketHub.connectionState() } : {}),
  }, options.strategyEngineOptions);

  const quiesceForCredentialMutation = async (): Promise<void> => {
    const previous = tradingSession.current;
    if (previous === 'live') {
      tradingSession.set('readonly');
    }
    const unresolved = await strategyEngine.suspendForTradingLock();
    if (previous === 'live') {
      addAuditEvent(database, 'trading_mode_changed', {
        from: previous,
        to: 'readonly',
        disclaimerAccepted: false,
        reason: 'credential_mutation',
        unresolvedOrderCount: unresolved.length,
      });
    }
    if (unresolved.length > 0) {
      throw new StrategyEngineError(
        'credential_change_blocked_by_open_orders',
        409,
        unresolved.map(({ order }) => order.id).join(','),
        { unresolvedOrders: unresolvedOrderDetails(unresolved) },
      );
    }
  };

  let credentialGeneration = 0;
  const invalidateAuthenticatedState = (): void => {
    credentialGeneration += 1;
    feeCache = null;
    livePortfolio.clear();
    tradingRuntime.clearAuthenticatedAccountState();
  };

  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger:
      options.logger === false
        ? false
        : {
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers.key',
                'req.headers.sign',
                'req.headers.x-gate-sign',
                'req.headers.x-gate-key',
                'req.body.apiKey',
                'req.body.apiSecret',
                '*.apiKey',
                '*.apiSecret',
                '*.key',
                '*.secret',
                '*.signature',
              ],
              censor: '[REDACTED]',
            },
          },
  });

  const maintenanceResult = runDatabaseMaintenance(database);
  if (Object.values(maintenanceResult).some((deleted) => deleted > 0)) {
    app.log.info(maintenanceResult, 'pruned expired local database records');
  }

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: options.rateLimitMax ?? 120, timeWindow: '1 minute' });
  await app.register(cors, { origin: [...config.allowedOrigins], credentials: false });
  await app.register(formbody, { bodyLimit: 16 * 1024 });
  await app.register(websocket);

  const frontendIndexPath = join(config.frontendDistPath, 'index.html');
  const frontendAssetsPath = join(config.frontendDistPath, 'assets');
  if (existsSync(frontendIndexPath) && existsSync(frontendAssetsPath)) {
    const frontendIndex = readFileSync(frontendIndexPath, 'utf8');
    await app.register(fastifyStatic, {
      root: frontendAssetsPath,
      prefix: '/assets/',
      wildcard: true,
      decorateReply: false,
      cacheControl: true,
      immutable: true,
      maxAge: '1y',
    });
    const sendFrontend = async (_request: unknown, reply: FastifyReply) => (
      reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(frontendIndex)
    );
    app.get('/', sendFrontend);
    app.get('/portfolio', sendFrontend);
    app.get('/funding-rates', sendFrontend);
    app.get('/funding-rates/:asset', async (request, reply) => {
      const parsed = z.object({ asset: z.string().regex(/^[A-Z0-9]{1,20}$/i) }).safeParse(request.params);
      if (!parsed.success) return reply.code(404).send({ error: 'frontend_route_not_found' });
      return sendFrontend(request, reply);
    });
    app.get('/strategies/paired-position', sendFrontend);
    app.get('/strategies/price-difference', sendFrontend);
    app.get('/strategies/sk-hynix-premium', sendFrontend);
    app.get('/strategies/boros', sendFrontend);
  }

  const candleStore = new CandleStore(database, marketHub, publicMarketGateway, {
    warn: (details, message) => app.log.warn(details, message),
  });

  const fundingOverviewService = new FundingOverviewService(publicMarketGateway, {
    warn: (venue, reason) => app.log.warn({ venue, reason }, 'funding overview venue fetch failed'),
  });
  const fundingHistoryService = new FundingHistoryService(database, publicMarketGateway, {
    warn: (symbol, reason) => app.log.warn({ symbol, reason }, 'funding history fetch failed'),
  });

  let portfolioRefreshInFlight: { generation: number; promise: Promise<LivePortfolioSnapshot> } | null = null;
  const refreshPortfolio = (): Promise<LivePortfolioSnapshot> => {
    if (portfolioRefreshInFlight?.generation === credentialGeneration) return portfolioRefreshInFlight.promise;
    const refreshCredentialGeneration = credentialGeneration;
    const pending = (async () => {
      let credentials: GateCredentials | null = null;
      try {
        credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
        if (!credentials) throw new TradingRuntimeError('credential_missing_from_vault', 409);
        const profileId = activeCredentialProfileId ?? DEFAULT_CREDENTIAL_PROFILE;
        const metadata = getCredentialMetadata(database, profileId);
        const previous = readLatestPortfolioSnapshot(database);
        const portfolioCheckpoint = livePortfolio.checkpoint();
        const portfolio = await crossExGateway.queryPortfolio(credentials);
        if (refreshCredentialGeneration !== credentialGeneration) {
          throw new TradingRuntimeError('credential_context_changed', 409);
        }
        const fetchedAt = new Date().toISOString();
        const snapshot = normalizePortfolio(portfolio, fetchedAt);
        const recoveredExecutionFillCount = tradingRuntime.reconcileExecutionFills(snapshot.recentFills);
        tradingRuntime.reconcileLivePositions(snapshot.futuresPositions);
        tradingRuntime.reconcileLiveBalances(snapshot.balances.map((balance) => ({
          venue: balance.venue,
          coin: balance.coin,
          balance: balance.balance,
          availableBalance: balance.availableBalance,
          equity: balance.equity,
          unrealizedPnl: balance.unrealizedPnl,
        })), fetchedAt);
        const provider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE) ?? credentialVault.provider;
        upsertCredentialMetadata(database, {
          id: profileId,
          label: metadata?.label ?? (provider === 'env_file' ? 'Gate CrossEx (.env)' : 'Gate CrossEx'),
          provider,
          createdAt: metadata?.createdAt ?? fetchedAt,
          lastVerifiedAt: fetchedAt,
        });
        const reconciliation = reconcilePortfolioSnapshots(randomUUID(), fetchedAt, previous, snapshot);
        savePortfolioSnapshot(database, snapshot);
        saveReconciliationReport(database, reconciliation);
        addAuditEvent(database, 'portfolio_read_only_snapshot_refreshed', {
          balanceCount: snapshot.balances.length,
          futuresPositionCount: snapshot.futuresPositions.length,
          marginPositionCount: snapshot.marginPositions.length,
          openOrderCount: snapshot.openOrders.length,
          recentFillCount: snapshot.recentFills.length,
          recoveredExecutionFillCount,
          reconciliationStatus: reconciliation.status,
          reconciliationIssueCount: reconciliation.issues.length,
        });
        return livePortfolio.reconcile({
          snapshot,
          dataStatus: 'fresh',
          remoteStatus: 'healthy',
          reconciliation,
        }, 'rest', portfolioCheckpoint);
      } finally {
        credentials = null;
      }
    })();
    const completed = pending.finally(() => {
      if (portfolioRefreshInFlight?.promise === completed) portfolioRefreshInFlight = null;
    });
    portfolioRefreshInFlight = { generation: refreshCredentialGeneration, promise: completed };
    return completed;
  };

  triggerPortfolioRefresh = () => {
    void refreshPortfolio().catch((error) => {
      if (error instanceof TradingRuntimeError && error.code === 'credential_context_changed') return;
      if (!(error instanceof TradingRuntimeError && error.code === 'credential_missing_from_vault')) {
        app.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'background portfolio reconciliation failed');
      }
      livePortfolio.markRemoteUnavailable();
    });
  };

  let portfolioReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let databaseMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  const schedulePortfolioReconciliation = () => {
    if (!options.startMarketStream) return;
    const interval = Math.round(5 * 60_000 * (0.9 + Math.random() * 0.2));
    portfolioReconcileTimer = setTimeout(() => {
      triggerPortfolioRefresh?.();
      schedulePortfolioReconciliation();
    }, interval);
    portfolioReconcileTimer.unref?.();
  };

  if (options.startMarketStream) {
    marketHub.start();
    privateStream.start();
    strategyEngine.start();
    fundingHistoryService.startBackground();
    databaseMaintenanceTimer = setInterval(() => {
      try {
        const result = runDatabaseMaintenance(database);
        if (Object.values(result).some((deleted) => deleted > 0)) {
          app.log.info(result, 'pruned expired local database records');
        }
      } catch (error) {
        app.log.warn({ err: error }, 'database retention maintenance failed');
      }
    }, 24 * 60 * 60_000);
    databaseMaintenanceTimer.unref?.();
    schedulePortfolioReconciliation();
    // Bootstrap once per backend process. Concurrent UI tabs and a private-stream ready event
    // join the same single-flight request instead of multiplying five authenticated REST reads.
    triggerPortfolioRefresh();
  }
  app.addHook('onClose', async () => {
    await fundingHistoryService.stopBackground();
    await strategyEngine.stop();
    if (portfolioReconcileTimer) clearTimeout(portfolioReconcileTimer);
    if (databaseMaintenanceTimer) clearInterval(databaseMaintenanceTimer);
    livePortfolio.stop();
    marketHub.stop();
    privateStream.stop();
  });

  app.addHook('onRequest', async (request, reply) => {
    const hostname = hostnameFromHeader(request.headers.host);
    if (!hostname || !config.allowedHosts.has(hostname)) {
      return reply.code(403).send({ error: 'non_local_host_rejected' });
    }

    const origin = request.headers.origin;
    if (origin
      && !isAllowedBrowserOrigin(origin, request.headers.host, config.allowedOrigins)
      // These two script-free forms carry a high-entropy, one-time CSRF token that their route
      // consumes before touching credentials. Some browsers report an opaque/re-written Origin
      // for the isolated page, so let the stronger per-form check make the decision here.
      && !isCsrfProtectedCredentialForm(request.method, request.url)) {
      request.log.warn({ origin, host: request.headers.host }, 'rejected unexpected browser origin');
      return reply.code(403).send({ error: 'unexpected_origin_rejected' });
    }
  });

  app.get('/health', async (): Promise<HealthResponse> => {
    const databaseStatus = readDatabaseStatus(database);
    const marketConnectionState = marketHub.connectionState();
    return {
      ok: databaseStatus.state === 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: 'live',
      database: databaseStatus.state,
      apiDocsRetrievedAt: API_DOCS_RETRIEVED_AT,
      connectionState: databaseStatus.state === 'ok' ? marketConnectionState === 'disconnected' ? 'healthy' : marketConnectionState : 'degraded',
    };
  });

  app.get('/api/system/discovery', async (): Promise<SystemDiscovery> => {
    const databaseStatus = readDatabaseStatus(database);
    return {
      product: 'Gate CrossEx Local Trading Terminal',
      mode: 'live',
      authenticatedTradingEnabled: tradingSession.liveTradingEnabled,
      tradingMode: tradingSession.current,
      docs: { apiVersion: API_DOCS_VERSION, retrievedAt: API_DOCS_RETRIEVED_AT },
      database: {
        migrationCount: databaseStatus.migrationCount,
        currentMigration: databaseStatus.currentMigration,
      },
      security: {
        credentialStorage: storedCredentialProvider(
          activeCredentialProfileId ? getCredentialMetadata(database, activeCredentialProfileId)?.provider : undefined,
          credentialVault.provider,
        ),
        credentialEntryPath: '/secure/credentials',
        browserJavaScriptHandlesSecrets: false,
      },
    };
  });

  const credentialConnectionStatus = async (): Promise<CredentialConnectionStatus> => {
    const metadata = activeCredentialProfileId ? getCredentialMetadata(database, activeCredentialProfileId) : null;
    const detectedProvider = metadata || !activeCredentialProfileId
      ? null
      : await storedCredentialVault.getProvider(activeCredentialProfileId);
    const profiles = listCredentialMetadata(database);
    return {
      configured: metadata !== null || detectedProvider !== null,
      storage: storedCredentialProvider(metadata?.provider, detectedProvider ?? credentialVault.provider),
      label: metadata?.label ?? (detectedProvider === 'env_file' ? 'Gate CrossEx (.env)' : null),
      lastVerifiedAt: metadata?.lastVerifiedAt ?? null,
      secureEntryPath: '/secure/credentials',
      readOnly: !tradingSession.liveTradingEnabled,
      activeProfileId: activeCredentialProfileId,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        storage: storedCredentialProvider(profile.provider, credentialVault.provider),
        lastVerifiedAt: profile.lastVerifiedAt,
        active: profile.id === activeCredentialProfileId,
      })),
    };
  };

  app.get('/api/onboarding/connection', credentialConnectionStatus);

  app.patch('/api/onboarding/accounts/:profileId', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-credential-intent'] !== 'rename-account') {
        return reply.code(403).send({ error: 'missing_credential_intent' });
      }
    },
  }, async (request, reply) => {
    const profileParams = CredentialProfileParamsSchema.safeParse(request.params);
    const renameRequest = WebAccountRenameSchema.safeParse(request.body);
    if (!profileParams.success || !renameRequest.success) {
      return reply.code(400).send({ error: 'invalid_account_name' });
    }
    const profile = getCredentialMetadata(database, profileParams.data.profileId);
    if (!profile) return reply.code(404).send({ error: 'credential_profile_not_found' });
    if (profile.id !== activeCredentialProfileId) {
      return reply.code(409).send({ error: 'credential_profile_not_active' });
    }
    if (profile.label === renameRequest.data.label) return credentialConnectionStatus();

    try {
      database.transaction(() => {
        upsertCredentialMetadata(database, { ...profile, label: renameRequest.data.label });
        database.prepare(`
          UPDATE execution_strategies
          SET credential_profile_label = ?
          WHERE credential_profile_id = ?
        `).run(renameRequest.data.label, profile.id);
        addAuditEvent(database, 'credential_profile_renamed', {
          profile: profile.id,
          previousLabel: profile.label,
          nextLabel: renameRequest.data.label,
          source: 'web_app',
        });
      })();
      return credentialConnectionStatus();
    } catch {
      request.log.error({ profile: profile.id }, 'web account rename failed');
      return reply.code(500).send({ error: 'credential_profile_rename_failed' });
    }
  });

  app.post('/api/onboarding/accounts/:profileId/activate', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-credential-intent'] !== 'switch-account') {
        return reply.code(403).send({ error: 'missing_credential_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = CredentialProfileParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credential_profile' });
    const switchRequest = WebAccountSwitchSchema.safeParse(request.body ?? {});
    if (!switchRequest.success) return reply.code(400).send({ error: 'invalid_account_switch' });
    const target = getCredentialMetadata(database, parsed.data.profileId);
    if (!target) return reply.code(404).send({ error: 'credential_profile_not_found' });
    if (target.id === activeCredentialProfileId) return credentialConnectionStatus();

    let credentials: GateCredentials | null = null;
    const previousActiveProfileId = activeCredentialProfileId;
    let releaseCredentialMutation: (() => void) | null = null;
    try {
      releaseCredentialMutation = await acquireCredentialMutation();
      const affectedStrategies = strategyEngine.runningStrategiesForCredentialProfile(previousActiveProfileId);
      if (affectedStrategies.length > 0 && !switchRequest.data.confirmPauseRunningStrategies) {
        return reply.code(409).send({
          error: 'running_strategies_require_confirmation',
          strategyCount: affectedStrategies.length,
          strategyIds: affectedStrategies.map((strategy) => strategy.id),
        });
      }
      await quiesceForCredentialMutation();
      credentials = await storedCredentialVault.get(target.id);
      if (!credentials) throw new TradingRuntimeError('credential_missing_from_vault', 409);
      const account = await crossExGateway.queryAccount(credentials);
      const pausedStrategyCount = strategyEngine.pauseRunningStrategiesForCredentialChange(previousActiveProfileId);
      const verifiedAt = new Date().toISOString();
      privateStream.stop();
      database.transaction(() => {
        upsertCredentialMetadata(database, { ...target, lastVerifiedAt: verifiedAt });
        saveActiveCredentialProfile(database, target.id);
        addAuditEvent(database, 'credential_profile_switched', {
          fromProfile: previousActiveProfileId,
          toProfile: target.id,
          accountMode: account.account_mode,
          pausedStrategyCount,
          source: 'web_app',
        });
      })();
      activeCredentialProfileId = target.id;
      invalidateAuthenticatedState();
      privateStream.start();
      if (options.startMarketStream) triggerPortfolioRefresh?.();
      return credentialConnectionStatus();
    } catch (error) {
      if (releaseCredentialMutation) {
        activeCredentialProfileId = previousActiveProfileId;
        try { saveActiveCredentialProfile(database, previousActiveProfileId); } catch { /* preserve original error */ }
        privateStream.start();
      }
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'web account switch failed');
      if (error instanceof StrategyEngineError || error instanceof TradingRuntimeError) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      if (error instanceof GateApiError) {
        return reply.code(502).send({ error: 'credential_verification_failed', label: error.label });
      }
      return reply.code(500).send({ error: 'credential_profile_switch_failed' });
    } finally {
      credentials = null;
      releaseCredentialMutation?.();
    }
  });

  app.delete('/api/onboarding/accounts/:profileId', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-credential-intent'] !== 'delete-account') {
        return reply.code(403).send({ error: 'missing_credential_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = CredentialProfileParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credential_profile' });
    const profile = getCredentialMetadata(database, parsed.data.profileId);
    if (!profile) return reply.code(404).send({ error: 'credential_profile_not_found' });

    const deletingActiveProfile = profile.id === activeCredentialProfileId;
    const previousActiveProfileId = activeCredentialProfileId;
    let previousCredentials: GateCredentials | null = null;
    let previousProvider: CredentialStorageProvider | null = null;
    let vaultDeleted = false;
    let releaseCredentialMutation: (() => void) | null = null;
    try {
      releaseCredentialMutation = await acquireCredentialMutation();
      if (deletingActiveProfile) await quiesceForCredentialMutation();
      const pausedStrategyCount = deletingActiveProfile
        ? strategyEngine.pauseRunningStrategiesForCredentialChange(previousActiveProfileId)
        : 0;
      previousCredentials = await storedCredentialVault.get(profile.id);
      previousProvider = await storedCredentialVault.getProvider(profile.id);
      if (deletingActiveProfile) privateStream.stop();
      vaultDeleted = await storedCredentialVault.delete(profile.id);
      if (previousCredentials && !vaultDeleted) throw new Error('credential_store_reported_no_deletion');
      try {
        database.transaction(() => {
          deleteCredentialMetadata(database, profile.id);
          if (deletingActiveProfile) saveActiveCredentialProfile(database, null);
          addAuditEvent(database, 'credential_deleted', {
            profile: profile.id,
            active: deletingActiveProfile,
            pausedStrategyCount,
            source: 'web_app',
          });
        })();
      } catch (error) {
        if (previousCredentials) {
          await storedCredentialVault.set(profile.id, previousCredentials, previousProvider ?? undefined);
          vaultDeleted = false;
        }
        throw error;
      }
      if (deletingActiveProfile) {
        activeCredentialProfileId = null;
        invalidateAuthenticatedState();
        privateStream.start();
      }
      return credentialConnectionStatus();
    } catch (error) {
      if (vaultDeleted && previousCredentials) {
        await storedCredentialVault.set(profile.id, previousCredentials, previousProvider ?? undefined)
          .catch((rollbackError) => request.log.error({ err: rollbackError }, 'web account deletion rollback failed'));
      }
      if (releaseCredentialMutation) {
        try {
          database.transaction(() => {
            upsertCredentialMetadata(database, profile);
            if (deletingActiveProfile) saveActiveCredentialProfile(database, previousActiveProfileId);
          })();
          activeCredentialProfileId = previousActiveProfileId;
        } catch { /* preserve deletion error */ }
        if (deletingActiveProfile) privateStream.start();
      }
      request.log.warn({ profile: profile.id }, 'web account deletion failed');
      if (error instanceof StrategyEngineError || error instanceof TradingRuntimeError) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      return reply.code(500).send({ error: 'credential_profile_delete_failed' });
    } finally {
      previousCredentials = null;
      releaseCredentialMutation?.();
    }
  });

  app.get('/api/trading-mode', async () => ({ mode: tradingSession.current }));

  app.post('/api/trading-mode', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'set-trading-mode') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    const parsed = z.object({ mode: z.enum(['readonly', 'live']), acceptDisclaimer: z.boolean().default(false) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_trading_mode' });
    // Leaving the boot-time 'unset' state in any direction, or arming live trading from any
    // state, requires a fresh human acknowledgement of the risk disclaimer. The one transition
    // that must never be gated is live → readonly: locking is the safety action.
    const requiresDisclaimer = parsed.data.mode === 'live' || tradingSession.current === 'unset';
    if (requiresDisclaimer && !parsed.data.acceptDisclaimer) {
      return reply.code(400).send({ error: 'disclaimer_not_accepted' });
    }
    const changeTradingMode = async () => {
      const previous = tradingSession.current;
      if (parsed.data.mode === previous) return { mode: previous };

      if (parsed.data.mode === 'live') {
        const credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
        if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
        try {
          const account = await crossExGateway.queryAccount(credentials);
          const verifiedAt = new Date().toISOString();
          const profileId = activeCredentialProfileId ?? DEFAULT_CREDENTIAL_PROFILE;
          const existing = getCredentialMetadata(database, profileId);
          const provider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE) ?? credentialVault.provider;
          upsertCredentialMetadata(database, {
            id: profileId,
            label: existing?.label ?? (provider === 'env_file' ? 'Gate CrossEx (.env)' : 'Gate CrossEx'),
            provider,
            createdAt: existing?.createdAt ?? verifiedAt,
            lastVerifiedAt: verifiedAt,
          });
          addAuditEvent(database, 'live_mode_credential_verified', {
            profile: profileId,
            accountMode: account.account_mode,
          });
          await strategyEngine.prepareForLiveActivation();
        } catch (error) {
          if (error instanceof StrategyEngineError || error instanceof TradingRuntimeError) {
            if (error.code === 'strategy_recovery_unresolved') {
              // Surface the blocking orders in the log and audit trail: without them a user only
              // sees a list of ids and has no way to tell a stale row from live exposure.
              request.log.warn({ ...error.details }, 'live activation blocked by unreconciled open orders');
              addAuditEvent(database, 'live_mode_activation_blocked', {
                profile: activeCredentialProfileId ?? DEFAULT_CREDENTIAL_PROFILE,
                ...error.details,
              });
            }
            return reply.code(error.statusCode).send({
              error: error.code,
              ...(error.label ? { label: error.label } : {}),
              ...error.details,
            });
          }
          const reason = error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR';
          request.log.warn({ reason }, 'live-mode credential verification failed');
          return reply.code(502).send({ error: 'credential_verification_failed' });
        }
      }

      // Lock first so no new order can pass createOrder while cancellation/quiescence is running.
      const mode = tradingSession.set(parsed.data.mode);
      let unresolvedOrders: UnresolvedOrder[] = [];
      if (mode === 'readonly') {
        unresolvedOrders = unresolvedOrderDetails(await strategyEngine.suspendForTradingLock());
      } else {
        strategyEngine.activatePersistedStrategies(activeCredentialProfileId);
      }
      if (mode !== previous) {
        addAuditEvent(database, 'trading_mode_changed', {
          from: previous,
          to: mode,
          disclaimerAccepted: parsed.data.acceptDisclaimer,
          unresolvedOrderCount: unresolvedOrders.length,
        });
        request.log.info({ from: previous, to: mode, unresolvedOrderCount: unresolvedOrders.length }, 'trading mode changed');
      }
      if (unresolvedOrders.length > 0) {
        request.log.warn({ unresolvedOrders }, 'read-only lock left open orders unconfirmed');
        return reply.code(202).send({
          mode,
          warning: 'readonly_quiesce_incomplete',
          unresolvedOrderIds: unresolvedOrders.map((order) => order.id),
          unresolvedOrders,
        });
      }
      return { mode };
    };

    try {
      return parsed.data.mode === 'live'
        ? await runAuthenticatedWrite(changeTradingMode)
        : await changeTradingMode();
    } catch (error) {
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
  });

  app.get('/api/preferences', async (): Promise<UserPreferencesResponse> => ({ preferences: readUserPreferences(database) }));

  app.put('/api/preferences', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = UserPreferencesSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_preferences' });
    saveUserPreferences(database, parsed.data);
    return { preferences: readUserPreferences(database) };
  });

  app.get('/api/markets', async () => marketHub.snapshot());

  app.get('/api/boros/strategies', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store, max-age=0');
    try {
      return await loadBorosStrategies();
    } catch (error) {
      request.log.warn({ reason: error instanceof z.ZodError ? 'INVALID_BOROS_RESPONSE' : 'BOROS_UNAVAILABLE' }, 'Boros strategy refresh failed');
      if (borosStrategyCache) return { ...borosStrategyCache, cacheStatus: 'stale' as const };
      return reply.code(502).send({ error: 'boros_strategies_unavailable' });
    }
  });

  app.get('/api/trading/snapshot', async () => tradingRuntime.snapshot());

  app.get('/api/trading/leverage/:symbol', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'leverage') return reply.code(403).send({ error: 'missing_read_intent' });
    },
  }, async (request, reply) => {
    const parsed = z.object({ symbol: z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_leverage_symbol' });
    const tradingGateway = crossExGateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.queryLeverages) return reply.code(503).send({ error: 'leverage_unavailable' });
    try {
      const credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      const leverages = await tradingGateway.queryLeverages(credentials, [parsed.data.symbol]);
      return { symbol: parsed.data.symbol, leverage: leverages[parsed.data.symbol] ?? null };
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'leverage query failed');
      return reply.code(502).send({ error: 'leverage_unavailable' });
    }
  });

  app.post('/api/trading/leverage/:symbol', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'set-leverage') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    const params = z.object({ symbol: z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/) }).safeParse(request.params);
    const body = z.object({ leverage: z.string().regex(/^(?:[1-9]\d*)(?:\.\d+)?$/).refine((value) => Number(value) <= 200) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_leverage' });
    const tradingGateway = crossExGateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.setLeverage) return reply.code(503).send({ error: 'leverage_unavailable' });
    try {
      return await runAuthenticatedWrite(async () => {
        if (!tradingSession.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
        const credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
        if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
        const result = await tradingGateway.setLeverage!(credentials, params.data.symbol, body.data.leverage);
        addAuditEvent(database, 'leverage_changed', { symbol: result.symbol, leverage: result.leverage });
        request.log.info({ symbol: result.symbol, leverage: result.leverage }, 'leverage changed');
        return result;
      });
    } catch (error) {
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof GateApiError) return reply.code(error.statusCode >= 400 && error.statusCode < 500 ? 400 : 502).send({ error: 'leverage_rejected', label: error.label });
      request.log.error({ error }, 'leverage update failed');
      return reply.code(500).send({ error: 'leverage_update_failed' });
    }
  });

  app.post('/api/trading/orders', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'place-order') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    try {
      const orderIntent = z.object({
        symbol: z.string(), side: z.enum(['BUY', 'SELL']), type: z.enum(['LIMIT', 'MARKET']),
        price: z.string().optional(),
      }).safeParse(request.body);
      const liveReference = orderIntent.success ? marketHub.market(orderIntent.data.symbol) : null;
      const referencePrice = orderIntent.success
        ? orderIntent.data.type === 'LIMIT'
          ? orderIntent.data.price
          : orderIntent.data.side === 'BUY' ? liveReference?.askPrice : liveReference?.bidPrice
        : undefined;
      // An empty reference deliberately fails closed inside the runtime when the live market is
      // unavailable; the endpoint must never silently bypass the position-tier review.
      return await tradingRuntime.createOrder(request.body, undefined, referencePrice ?? '');
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_order', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof GateApiError) return reply.code(error.statusCode > 0 ? 502 : 503).send({ error: 'gate_order_rejected', label: error.label });
      request.log.error({ error }, 'order submission failed');
      return reply.code(500).send({ error: 'order_submission_failed' });
    }
  });

  app.delete('/api/trading/orders/:id', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'cancel-order') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_order_id' });
    try { return await runAuthenticatedWrite(() => tradingRuntime.cancelOrder(parsed.data.id)); }
    catch (error) {
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof GateApiError) return reply.code(502).send({ error: 'gate_cancel_rejected', label: error.label });
      return reply.code(500).send({ error: 'order_cancel_failed' });
    }
  });

  app.get('/api/strategies', async () => ({ strategies: tradingRuntime.listStrategies() }));

  app.post('/api/strategies', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'start-strategy') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    try {
      return await runAuthenticatedWrite(async () => {
        // Strategy submission is an execution boundary: load exchange constraints here even when a
        // direct API client has not visited the instrument pages first.
        if (tradingSession.liveTradingEnabled && !readInstrumentCatalog(database)) {
          try { await fetchInstrumentCatalog(); }
          catch (error) {
            request.log.warn({ reason: error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR' }, 'strategy instrument preflight failed');
            return reply.code(503).send({ error: 'strategy_instrument_constraints_unavailable' });
          }
        }
        const profileId = activeCredentialProfileId;
        const profile = profileId ? getCredentialMetadata(database, profileId) : null;
        if (!profileId) return reply.code(409).send({ error: 'credential_not_configured' });
        const provider = await storedCredentialVault.getProvider(profileId);
        return strategyEngine.startStrategy(request.body, {
          profileId,
          label: profile?.label ?? (provider === 'env_file' ? 'Gate CrossEx (.env)' : 'Gate CrossEx'),
        });
      });
    }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_strategy', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      if (error instanceof TradingRuntimeError) {
        if (error.label) request.log.warn({ code: error.code, label: error.label }, 'strategy start rejected by upstream');
        return reply.code(error.statusCode).send({ error: error.code, ...(error.label ? { label: error.label } : {}) });
      }
      request.log.error({ error }, 'strategy start failed');
      return reply.code(500).send({ error: 'strategy_start_failed' });
    }
  });

  app.post('/api/strategies/:id/stop', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'stop-strategy') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(STRATEGY_ID) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_strategy_id' });
    try { return await runAuthenticatedWrite(() => strategyEngine.stopStrategy(parsed.data.id)); }
    catch (error) {
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(500).send({ error: 'strategy_stop_failed' });
    }
  });

  app.post('/api/strategies/:id/resume', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'resume-strategy') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(STRATEGY_ID) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_strategy_id' });
    if (!activeCredentialProfileId) return reply.code(409).send({ error: 'credential_not_configured' });
    try {
      return await runAuthenticatedWrite(async () => {
        // Resume repeats launch preflight, so its order-size checks need the same authoritative
        // instrument catalog as a newly submitted strategy.
        if (tradingSession.liveTradingEnabled && !readInstrumentCatalog(database)) {
          try { await fetchInstrumentCatalog(); }
          catch (error) {
            request.log.warn({ reason: error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR' }, 'strategy resume instrument preflight failed');
            return reply.code(503).send({ error: 'strategy_instrument_constraints_unavailable' });
          }
        }
        const profileId = activeCredentialProfileId;
        if (!profileId) throw new TradingRuntimeError('credential_not_configured', 409);
        return strategyEngine.resumeStrategy(parsed.data.id, profileId);
      });
    }
    catch (error) {
      if (error instanceof TradingRuntimeError) {
        if (error.label) request.log.warn({ code: error.code, label: error.label }, 'strategy resume rejected');
        return reply.code(error.statusCode).send({ error: error.code, ...(error.label ? { label: error.label } : {}) });
      }
      request.log.error({ error }, 'strategy resume failed');
      return reply.code(500).send({ error: 'strategy_resume_failed' });
    }
  });

  app.patch('/api/strategies/:id/take-profit', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'update-strategy-take-profit') {
        return reply.code(403).send({ error: 'missing_trading_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(STRATEGY_ID) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_strategy_id' });
    try { return await strategyEngine.updatePremiumTakeProfit(parsed.data.id, request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_take_profit', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      request.log.error({ error }, 'strategy take-profit update failed');
      return reply.code(500).send({ error: 'strategy_take_profit_update_failed' });
    }
  });

  app.get('/api/strategies/:id/logs', async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(STRATEGY_ID) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_strategy_id' });
    return { logs: tradingRuntime.strategyLogs(parsed.data.id) };
  });

  const MarketWatchSymbolSchema = z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/);
  const WatchMessageSchema = z.union([
    z.object({
      type: z.literal('watch.quotes'),
      symbols: z.array(MarketWatchSymbolSchema).max(20),
    }),
    z.object({
      type: z.literal('watch.klines'),
      watches: z.array(z.object({
        symbol: MarketWatchSymbolSchema,
        interval: z.enum(CANDLE_INTERVALS),
      })).max(20),
    }),
    z.object({
      type: z.literal('watch.market'),
      symbol: MarketWatchSymbolSchema,
      interval: z.enum(CANDLE_INTERVALS),
    }),
    z.object({ type: z.literal('watch.clear') }),
  ]);

  app.get('/ws/stream', { websocket: true }, (socket) => {
    const safeSend = (message: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      const type = typeof message === 'object' && message !== null && 'type' in message
        ? String((message as { type: unknown }).type)
        : '';
      const volatile = type.startsWith('market.')
        || type.startsWith('orderbook.')
        || type.startsWith('trade.')
        || type.startsWith('kline.');
      // A background tab can stop draining its socket. Coalesce/drop replaceable market data
      // before it consumes unbounded memory; critical account/execution state is retained unless
      // the connection is so far behind that a clean reconnect is safer.
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        socket.terminate();
        return;
      }
      if (volatile && socket.bufferedAmount > 512 * 1024) return;
      socket.send(JSON.stringify(message));
    };
    const marketBatch = new Map<string, MarketHubMessage & { type: 'market.update' }>();
    let marketBatchTimer: ReturnType<typeof setTimeout> | null = null;
    let marketSymbols = new Set<string>();
    const tradeBatch: Array<Extract<MarketHubMessage, { type: 'trade.update' }>['payload']['trade']> = [];
    let tradeBatchSymbol: string | null = null;
    let tradeBatchTimer: ReturnType<typeof setTimeout> | null = null;
    const klineBatch = new Map<string, Extract<MarketHubMessage, { type: 'kline.update' }>>();
    let klineBatchTimer: ReturnType<typeof setTimeout> | null = null;
    const flushMarketBatch = () => {
      marketBatchTimer = null;
      if (marketBatch.size === 0) return;
      const markets = [...marketBatch.values()].map((message) => message.payload);
      marketBatch.clear();
      safeSend({ type: 'market.batch', payload: { markets } });
    };
    const queueMarketUpdate = (message: MarketHubMessage & { type: 'market.update' }) => {
      marketBatch.set(message.payload.symbol, message);
      if (marketBatchTimer) return;
      marketBatchTimer = setTimeout(flushMarketBatch, 250);
      marketBatchTimer.unref?.();
    };
    const clearMarketBatch = () => {
      if (marketBatchTimer) clearTimeout(marketBatchTimer);
      marketBatchTimer = null;
      marketBatch.clear();
    };
    const flushTradeBatch = () => {
      if (tradeBatchTimer) clearTimeout(tradeBatchTimer);
      tradeBatchTimer = null;
      const symbol = tradeBatchSymbol;
      const trades = tradeBatch.splice(0);
      tradeBatchSymbol = null;
      if (!symbol || trades.length === 0) return;
      safeSend({ type: 'trade.batch', payload: { symbol, trades } });
    };
    const queueTradeUpdate = (message: Extract<MarketHubMessage, { type: 'trade.update' }>) => {
      if (tradeBatchSymbol !== message.payload.symbol) {
        flushTradeBatch();
        tradeBatchSymbol = message.payload.symbol;
      }
      tradeBatch.push(message.payload.trade);
      if (tradeBatch.length > MAX_STREAM_TRADE_BATCH) tradeBatch.splice(0, tradeBatch.length - MAX_STREAM_TRADE_BATCH);
      if (tradeBatchTimer) return;
      tradeBatchTimer = setTimeout(flushTradeBatch, STREAM_VOLATILE_EMIT_INTERVAL_MS);
      tradeBatchTimer.unref?.();
    };
    const flushKlineBatch = () => {
      klineBatchTimer = null;
      const messages = [...klineBatch.values()];
      klineBatch.clear();
      for (const message of messages) safeSend(message);
    };
    const queueKlineUpdate = (message: Extract<MarketHubMessage, { type: 'kline.update' }>) => {
      klineBatch.set(`${message.payload.symbol}:${message.payload.interval}`, message);
      if (klineBatchTimer) return;
      klineBatchTimer = setTimeout(flushKlineBatch, STREAM_VOLATILE_EMIT_INTERVAL_MS);
      klineBatchTimer.unref?.();
    };
    const clearVolatileBatches = () => {
      if (tradeBatchTimer) clearTimeout(tradeBatchTimer);
      if (klineBatchTimer) clearTimeout(klineBatchTimer);
      tradeBatchTimer = null;
      klineBatchTimer = null;
      tradeBatch.length = 0;
      tradeBatchSymbol = null;
      klineBatch.clear();
    };
    const clearKlineBatch = () => {
      if (klineBatchTimer) clearTimeout(klineBatchTimer);
      klineBatchTimer = null;
      klineBatch.clear();
    };
    // The hub broadcasts book/trade/kline messages for the union of every client's watches, so
    // relay only this connection's watched market: another tab watching a second symbol must not
    // leak into this client's single-slot book state.
    let watched: { symbol: string; interval: CandleInterval } | null = null;
    let watchedKlines = new Set<string>();
    const watchesKline = (symbol: string, interval: CandleInterval) =>
      (watched?.symbol === symbol && watched.interval === interval)
      || watchedKlines.has(`${symbol}:${interval}`);
    const scopedSend = (message: MarketHubMessage) => {
      if (message.type === 'market.snapshot') {
        safeSend({ type: 'market.status', payload: {
          connectionState: message.payload.connectionState,
          checkedAt: new Date().toISOString(),
        } });
        if (marketSymbols.size === 0) return;
        safeSend({
          type: 'market.snapshot',
          payload: { ...message.payload, markets: message.payload.markets.filter((market) => marketSymbols.has(market.symbol)) },
        });
        return;
      }
      if (message.type === 'market.update') {
        if (marketSymbols.has(message.payload.symbol)) queueMarketUpdate(message);
        return;
      }
      if (message.type === 'orderbook.update' && message.payload.symbol !== watched?.symbol) return;
      if (message.type === 'trade.update') {
        if (message.payload.symbol === watched?.symbol) queueTradeUpdate(message);
        return;
      }
      if (message.type === 'kline.update') {
        if (watchesKline(message.payload.symbol, message.payload.interval)) queueKlineUpdate(message);
        return;
      }
      if (message.type === 'kline.snapshot'
        && !watchesKline(message.payload.symbol, message.payload.interval)) return;
      safeSend(message);
    };
    const unsubscribeMarkets = marketHub.subscribe(scopedSend);
    const unsubscribeRuntime = tradingRuntime.subscribe(safeSend);
    const unsubscribePortfolio = livePortfolio.subscribe(safeSend);
    const unsubscribeMode = tradingSession.subscribe(safeSend);
    const statusHeartbeat = setInterval(() => {
      safeSend({ type: 'market.status', payload: {
        connectionState: marketHub.connectionState(),
        checkedAt: new Date().toISOString(),
      } });
    }, STREAM_STATUS_INTERVAL_MS);
    statusHeartbeat.unref?.();
    let watchReleases: Array<() => void> = [];
    let quoteWatchRelease: (() => void) | null = null;
    const klineWatchReleases: Array<() => void> = [];
    const clearWatch = () => { for (const release of watchReleases.splice(0)) release(); };
    const clearQuoteWatch = () => {
      quoteWatchRelease?.();
      quoteWatchRelease = null;
    };
    const clearKlineWatches = () => {
      for (const release of klineWatchReleases.splice(0)) release();
      watchedKlines = new Set();
      clearKlineBatch();
    };
    safeSend({ type: 'mode.update', payload: { mode: tradingSession.current } });
    safeSend({ type: 'strategy.snapshot', payload: { strategies: tradingRuntime.listStrategies() } });
    safeSend({ type: 'execution.snapshot', payload: tradingRuntime.snapshot() });
    socket.on('message', (raw: { toString(): string }) => {
      let parsedMessage: unknown;
      try { parsedMessage = JSON.parse(raw.toString()); } catch { return; }
      const watch = WatchMessageSchema.safeParse(parsedMessage);
      if (!watch.success) return;
      if (watch.data.type === 'watch.quotes') {
        clearQuoteWatch();
        const symbols = watch.data.symbols.filter((symbol) => ensureMarketKnown(symbol));
        quoteWatchRelease = marketHub.watchQuotes(symbols);
        marketSymbols = new Set(symbols);
        clearMarketBatch();
        if (marketSymbols.size > 0) {
          const snapshot = marketHub.snapshot();
          safeSend({
            type: 'market.snapshot',
            payload: { ...snapshot, markets: snapshot.markets.filter((market) => marketSymbols.has(market.symbol)) },
          });
        }
        return;
      }
      if (watch.data.type === 'watch.klines') {
        clearKlineWatches();
        const unique = new Map(watch.data.watches.map((entry) => [`${entry.symbol}:${entry.interval}`, entry]));
        const watches = [...unique.values()].filter((entry) => ensureMarketKnown(entry.symbol));
        watchedKlines = new Set(watches.map((entry) => `${entry.symbol}:${entry.interval}`));
        for (const entry of watches) {
          klineWatchReleases.push(marketHub.watchKlines(entry.symbol, entry.interval));
          candleStore.hydrate(entry.symbol, entry.interval);
          safeSend({
            type: 'kline.snapshot',
            payload: { symbol: entry.symbol, interval: entry.interval, candles: marketHub.candles(entry.symbol, entry.interval) },
          });
          candleStore.prefetch(entry.symbol, entry.interval);
        }
        return;
      }
      clearVolatileBatches();
      clearWatch();
      watched = null;
      if (watch.data.type === 'watch.clear') return;
      const { symbol, interval } = watch.data;
      if (!ensureMarketKnown(symbol)) return;
      watched = { symbol, interval };
      watchReleases = [
        marketHub.watchOrderBook(symbol),
        marketHub.watchTrades(symbol),
        marketHub.watchKlines(symbol, interval),
      ];
      const book = marketHub.orderBook(symbol);
      if (book) safeSend({ type: 'orderbook.update', payload: book });
      safeSend({ type: 'trade.snapshot', payload: { symbol, trades: marketHub.recentTrades(symbol) } });
      candleStore.hydrate(symbol, interval);
      safeSend({ type: 'kline.snapshot', payload: { symbol, interval, candles: marketHub.candles(symbol, interval) } });
      // Fetch only the selected timeframe; other intervals backfill when the user requests them.
      candleStore.prefetch(symbol, interval);
    });
    socket.on('close', () => {
      clearWatch();
      clearQuoteWatch();
      clearKlineWatches();
      clearMarketBatch();
      clearVolatileBatches();
      clearInterval(statusHeartbeat);
      unsubscribeMarkets();
      unsubscribeRuntime();
      unsubscribePortfolio();
      unsubscribeMode();
    });
  });

  app.get('/api/markets/catalog', async (request, reply) => {
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        recordMarketDataFailure(database, 'gate_crossex_instruments', new Date().toISOString(), errorCode);
        request.log.warn({ reason: errorCode }, 'market catalog discovery failed');
      }
      if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    } else if (Date.now() - Date.parse(catalog.fetchedAt) > MARKET_CATALOG_FRESH_MS) {
      // Serve the cached list instantly; converge in the background for the next request.
      void fetchInstrumentCatalog().catch((error: unknown) => {
        request.log.warn({ reason: error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR' }, 'market catalog refresh failed');
      });
    }
    const assets: MarketCatalogAsset[] = [...catalog.assets.entries()].map(([asset, venues]) => ({
      asset,
      streamed: marketHub.hasAsset(asset),
      venues,
    }));
    return {
      assets,
      fetchedAt: catalog.fetchedAt,
      cacheStatus: Date.now() - Date.parse(catalog.fetchedAt) <= MARKET_CATALOG_FRESH_MS ? 'fresh' : 'stale',
    } satisfies MarketCatalogResponse;
  });

  app.get('/api/markets/funding-overview', async (request, reply) => {
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        recordMarketDataFailure(database, 'gate_crossex_instruments', new Date().toISOString(), errorCode);
        request.log.warn({ reason: errorCode }, 'funding overview catalog discovery failed');
      }
      if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    } else if (Date.now() - Date.parse(catalog.fetchedAt) > MARKET_CATALOG_FRESH_MS) {
      void fetchInstrumentCatalog().catch((error: unknown) => {
        request.log.warn({ reason: error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR' }, 'market catalog refresh failed');
      });
    }
    await fundingOverviewService.ensureFresh();
    return fundingOverviewService.buildResponse(catalog) satisfies FundingOverviewResponse;
  });

  app.post('/api/markets/funding-history', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'funding-history') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = FundingHistoryRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_funding_history_request' });
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const reason = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        request.log.warn({ reason }, 'funding history catalog discovery failed');
      }
    }
    if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    if (parsed.data.symbols.some((symbol) => !catalog?.liveSymbols.has(symbol))) {
      return reply.code(404).send({ error: 'unknown_market_symbol' });
    }
    return fundingHistoryService.loadCachedMany(
      parsed.data.symbols,
      parsed.data.durationDays * 24 * 60 * 60_000,
    ) satisfies FundingHistoryResponse;
  });

  app.post('/api/markets/funding-rankings', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'funding-history') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = FundingRankingRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_funding_ranking_request' });
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const reason = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        request.log.warn({ reason }, 'funding ranking catalog discovery failed');
      }
    }
    if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    if (parsed.data.symbols.some((symbol) => !catalog?.liveSymbols.has(symbol))) {
      return reply.code(404).send({ error: 'unknown_market_symbol' });
    }
    return fundingHistoryService.loadRankingSnapshot(
      parsed.data.symbols,
      parsed.data.durationDays * 24 * 60 * 60_000,
    ) satisfies FundingHistoryResponse;
  });

  app.post('/api/markets/funding-history/series', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'funding-history') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = FundingHistorySeriesRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_funding_history_series_request' });
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const reason = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        request.log.warn({ reason }, 'funding history series catalog discovery failed');
      }
    }
    if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    if (parsed.data.symbols.some((symbol) => !catalog?.liveSymbols.has(symbol))) {
      return reply.code(404).send({ error: 'unknown_market_symbol' });
    }
    return await fundingHistoryService.loadSeries(
      parsed.data.symbols,
      parsed.data.durationDays * 24 * 60 * 60_000,
    ) satisfies FundingHistorySeriesResponse;
  });

  app.get('/api/markets/:symbol/candles', async (request, reply) => {
    const params = z.object({ symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/) }).safeParse(request.params);
    const query = z.object({
      interval: z.enum(CANDLE_INTERVALS).default('1m'),
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(30).max(500).default(300),
      fresh: z.literal('1').optional(),
    }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_candle_request' });
    const symbol = params.data.symbol;
    const interval: CandleInterval = query.data.interval;
    if (!ensureMarketKnown(symbol)) return reply.code(404).send({ error: 'unknown_market_symbol' });

    if (query.data.before !== undefined) {
      const candles = await candleStore.loadBefore(symbol, interval, query.data.before, query.data.limit);
      if (candles === null) return reply.code(502).send({ error: 'candle_history_unavailable' });
      return {
        symbol,
        interval,
        candles,
        source: candleStore.canBackfill(symbol) ? 'venue_public_rest_and_crossex_websocket' : 'crossex_websocket_only',
        building: false,
        hasMore: candles.length >= query.data.limit,
      } satisfies CandleSeriesResponse;
    }

    candleStore.hydrate(symbol, interval);
    let candles = marketHub.candles(symbol, interval);
    if (candleStore.canBackfill(symbol) && !candleStore.backfilledRecently(symbol, interval)) {
      const refresh = candleStore.refresh(symbol, interval);
      if (candles.length === 0 || query.data.fresh === '1') {
        // A chart switching to this key opts into one stable first paint: wait for the current
        // venue page instead of returning persisted candles and replacing them moments later.
        await refresh;
        candles = marketHub.candles(symbol, interval);
      }
      // Otherwise the cached series ships now; watchers receive a kline.snapshot push when the
      // background refresh lands.
    }
    return {
      symbol,
      interval,
      candles,
      source: candleStore.hasVenueHistory(symbol, interval) ? 'venue_public_rest_and_crossex_websocket' : 'crossex_websocket_only',
      building: candles.length < 30,
      // A short persisted/live series can be returned while its latest venue refresh is still
      // running. Keep history loading eligible until a completed refresh proves the page short.
      hasMore: candleStore.canBackfill(symbol) && candles.length > 0
        && (!candleStore.backfilledRecently(symbol, interval) || candles.length >= query.data.limit),
    } satisfies CandleSeriesResponse;
  });

  // Public book/trade streams are venue-native: contract counts on GATE and OKX, base-coin
  // quantities on the other venues (verified against live feed magnitudes, 2026-07-22). This maps
  // each futures symbol to base-units-per-feed-unit so the UI can label real coin amounts.
  app.get('/api/markets/size-units', async (request) => {
    const cached = sizeUnitCache;
    // A dynamically registered market invalidates the cache (count changes) so its symbols get mapped.
    if (cached && cached.complete && cached.marketCount === marketHub.marketCount()
      && Date.now() - Date.parse(cached.fetchedAt) < MARKET_REFERENCE_CACHE_MS) {
      return { units: cached.units, fetchedAt: cached.fetchedAt };
    }
    if (!sizeUnitInFlight) {
      sizeUnitInFlight = (async () => {
        const markets = marketHub.snapshot().markets;
        const units: Record<string, string> = {};
        for (const market of markets) {
          if (market.venue !== 'GATE' && market.venue !== 'OKX') units[market.symbol] = '1';
        }
        let complete = true;
        for (const venue of ['GATE', 'OKX'] as const) {
          try {
            const sizes = await publicMarketGateway.queryContractSizes?.(venue) ?? [];
            const byPair = new Map(sizes.map((size) => [`${size.base}_${size.quote}`, size.multiplier]));
            for (const market of markets) {
              if (market.venue !== venue) continue;
              const quote = market.symbol.split('_')[3] ?? '';
              const multiplier = byPair.get(`${market.asset}_${quote}`);
              if (multiplier && /^\d+(?:\.\d+)?$/.test(multiplier) && Number(multiplier) > 0) {
                units[market.symbol] = multiplier;
              }
            }
          } catch (error) {
            // A failed venue fetch leaves its symbols unmapped; the UI then shows raw feed sizes.
            complete = false;
            const errorCode = error instanceof PublicMarketDataError ? error.code : 'PUBLIC_DATA_ERROR';
            request.log.warn({ venue, reason: errorCode }, 'contract size fetch failed');
          }
        }
        sizeUnitCache = { units, fetchedAt: new Date().toISOString(), complete, marketCount: markets.length };
      })().finally(() => { sizeUnitInFlight = null; });
    }
    await sizeUnitInFlight;
    const latest = sizeUnitCache;
    return latest ? { units: latest.units, fetchedAt: latest.fetchedAt } : { units: {}, fetchedAt: new Date().toISOString() };
  });

  app.get('/api/crossex/fees', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'fee-rates') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const requestCredentialGeneration = credentialGeneration;
    if (feeCache && Date.now() - Date.parse(feeCache.fetchedAt) < 10 * 60_000) {
      return { fees: feeCache.fees, fetchedAt: feeCache.fetchedAt, cacheStatus: 'fresh' } satisfies VenueFeeRatesResponse;
    }
    const tradingGateway = crossExGateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.queryFeeRates) return reply.code(503).send({ error: 'fee_rates_unavailable' });
    try {
      if (feeFetchInFlight?.generation !== credentialGeneration) {
        const refreshCredentialGeneration = credentialGeneration;
        const pending = (async () => {
          let credentials: GateCredentials | null = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
          try {
            if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
            const rates = await tradingGateway.queryFeeRates!(credentials);
            if (refreshCredentialGeneration !== credentialGeneration) {
              throw new TradingRuntimeError('credential_context_changed', 409);
            }
            const fetchedAt = new Date().toISOString();
            const fees = rates.map((rate) => ({
              venue: rate.exchange_type, spotMakerFee: rate.spot_maker_fee, spotTakerFee: rate.spot_taker_fee,
              futureMakerFee: rate.future_maker_fee, futureTakerFee: rate.future_taker_fee,
              specialFees: (rate.special_fee_list ?? []).map((special) => ({
                symbol: special.symbol,
                makerFee: special.maker_fee_rate,
                takerFee: special.taker_fee_rate,
              })),
            }));
            feeCache = { fees, fetchedAt };
            return { fees, fetchedAt };
          } finally {
            credentials = null;
          }
        })();
        const completed = pending.finally(() => {
          if (feeFetchInFlight?.promise === completed) feeFetchInFlight = null;
        });
        feeFetchInFlight = { generation: refreshCredentialGeneration, promise: completed };
      }
      const refreshed = await feeFetchInFlight.promise;
      return { ...refreshed, cacheStatus: 'fresh' } satisfies VenueFeeRatesResponse;
    } catch (error) {
      if (requestCredentialGeneration !== credentialGeneration) {
        return reply.code(409).send({ error: 'credential_context_changed' });
      }
      if (error instanceof TradingRuntimeError
        && (error.code === 'credential_not_configured' || error.code === 'credential_context_changed')) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'fee rate refresh failed');
      if (feeCache) return { fees: feeCache.fees, fetchedAt: feeCache.fetchedAt, cacheStatus: 'stale' } satisfies VenueFeeRatesResponse;
      return reply.code(502).send({ error: 'fee_rates_unavailable' });
    }
  });

  app.get('/api/crossex/transfer-coins', async (request, reply) => {
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryTransferCoins) {
      return reply.code(503).send({ error: 'transfer_coins_unavailable' });
    }
    try {
      return { ...(await fetchTransferCoins()), cacheStatus: 'fresh' } satisfies CrossExTransferCoinsResponse;
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'TRANSFER_COIN_ERROR' }, 'transfer coin query failed');
      if (transferCoinCache) return { ...transferCoinCache, cacheStatus: 'stale' } satisfies CrossExTransferCoinsResponse;
      return reply.code(502).send({ error: 'transfer_coins_unavailable' });
    }
  });

  app.get('/api/crossex/transfer-balances', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'transfer-balances') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryAccount || !operationsGateway.querySpotAccounts) {
      return reply.code(503).send({ error: 'transfer_balances_unavailable' });
    }
    let credentials: GateCredentials | null = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
    try {
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      const [account, spotAccounts] = await Promise.all([
        operationsGateway.queryAccount(credentials),
        operationsGateway.querySpotAccounts(credentials),
      ]);
      const balances = new Map<string, CrossExTransferBalancesResponse['items'][number]>();
      const addBalance = (transferAccount: unknown, coin: string, available: string) => {
        const parsedAccount = CrossExTransferAccountSchema.safeParse(transferAccount);
        if (!parsedAccount.success || !coin || !/^\d+(?:\.\d+)?$/.test(available)) return;
        balances.set(`${parsedAccount.data}:${coin}`, { account: parsedAccount.data, coin, available });
      };
      for (const spot of spotAccounts) addBalance('SPOT', spot.currency, spot.available);
      for (const asset of account.assets) {
        const exchange = asset.exchange_type.toUpperCase();
        addBalance(exchange === 'CROSSEX' ? 'CROSSEX' : `CROSSEX_${exchange}`, asset.coin, asset.available_balance);
      }
      addBalance('CROSSEX', 'USDT', account.available_margin);
      return {
        items: [...balances.values()].sort((left, right) => left.account.localeCompare(right.account) || left.coin.localeCompare(right.coin)),
        fetchedAt: new Date().toISOString(),
      } satisfies CrossExTransferBalancesResponse;
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'transfer balance query failed');
      return reply.code(502).send({ error: 'transfer_balances_unavailable' });
    } finally {
      credentials = null;
    }
  });

  app.get('/api/crossex/portfolio-activity', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'portfolio-activity') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = z.object({
      coin: z.string().trim().regex(/^[A-Z0-9]{1,20}$/).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_portfolio_activity_query' });
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryTransfers || !operationsGateway.queryAccountBook) {
      return reply.code(503).send({ error: 'portfolio_activity_unavailable' });
    }

    let credentials: GateCredentials | null = null;
    try {
      credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      const [transfers, accountBook, fundingFees] = await Promise.all([
        operationsGateway.queryTransfers(credentials, parsed.data),
        operationsGateway.queryAccountBook(credentials, parsed.data),
        operationsGateway.queryAccountBook(credentials, {
          ...parsed.data,
          statementType: 'FUNDING_FEE',
        }),
      ]);
      return {
        transfers: normalizeTransferRecords(transfers),
        accountBook: normalizeAccountBook(accountBook),
        fundingFees: normalizeAccountBook(fundingFees),
        fetchedAt: new Date().toISOString(),
      } satisfies CrossExPortfolioActivityResponse;
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'portfolio activity query failed');
      return reply.code(502).send({ error: 'portfolio_activity_unavailable' });
    } finally {
      credentials = null;
    }
  });

  app.post('/api/crossex/transfers', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'transfer-funds') {
        return reply.code(403).send({ error: 'missing_trading_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = CrossExTransferRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_transfer' });
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.createTransfer || !operationsGateway.queryAccount || !operationsGateway.queryTransferCoins) {
      return reply.code(503).send({ error: 'transfers_unavailable' });
    }

    let credentials: GateCredentials | null = null;
    try {
      return await runAuthenticatedWrite(async () => {
        if (!tradingSession.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
        credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
        if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
        if (parsed.data.from === 'SPOT' && !operationsGateway.querySpotAccounts) {
          return reply.code(503).send({ error: 'transfer_balances_unavailable' });
        }
        const stableCredentials = credentials;
        const [account, transferCoins, spotAccounts] = await Promise.all([
          operationsGateway.queryAccount!(stableCredentials),
          fetchTransferCoins(),
          parsed.data.from === 'SPOT' ? operationsGateway.querySpotAccounts!(stableCredentials) : Promise.resolve(null),
        ]);
        const routeError = crossExTransferRouteError(parsed.data, account.account_mode);
        if (routeError) return reply.code(400).send({ error: 'invalid_transfer_route', label: routeError });
        const canonicalTransfer = canonicalizeCrossExTransfer(parsed.data, account.account_mode);

        const coinRule = transferCoins.items.find((coin) => coin.coin === parsed.data.coin);
        if (!coinRule || coinRule.disabled) {
          return reply.code(400).send({ error: 'unsupported_transfer_coin', label: coinRule?.disabled ? 'TRANSFER_COIN_DISABLED' : 'TRANSFER_COIN_UNSUPPORTED' });
        }
        const amount = new Decimal(parsed.data.amount);
        if (amount.lt(coinRule.minimumAmount)) {
          return reply.code(400).send({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_BELOW_MINIMUM' });
        }
        if (amount.decimalPlaces() > coinRule.precision) {
          return reply.code(400).send({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_PRECISION_EXCEEDED' });
        }

        let sourceAvailable: string | null = null;
        if (canonicalTransfer.from === 'SPOT') {
          sourceAvailable = spotAccounts?.find((balance) => balance.currency === canonicalTransfer.coin)?.available ?? null;
        } else if (canonicalTransfer.from === 'CROSSEX') {
          sourceAvailable = canonicalTransfer.coin === 'USDT' ? account.available_margin : null;
        } else {
          const exchange = canonicalTransfer.from.slice('CROSSEX_'.length);
          sourceAvailable = account.assets.find((asset) => asset.exchange_type === exchange && asset.coin === canonicalTransfer.coin)?.available_balance ?? null;
        }
        if (sourceAvailable === null) return reply.code(409).send({ error: 'source_balance_unavailable' });
        if (amount.gt(sourceAvailable)) {
          return reply.code(400).send({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_EXCEEDS_AVAILABLE' });
        }

        const transfer = await operationsGateway.createTransfer!(stableCredentials, canonicalTransfer);
        addAuditEvent(database, 'fund_transfer_submitted', {
          transactionId: transfer.tx_id,
          coin: canonicalTransfer.coin,
          amount: canonicalTransfer.amount,
          from: canonicalTransfer.from,
          to: canonicalTransfer.to,
        });
        request.log.info({ transactionId: transfer.tx_id, coin: canonicalTransfer.coin, from: canonicalTransfer.from, to: canonicalTransfer.to }, 'fund transfer submitted');
        triggerPortfolioRefresh?.();
        return { transactionId: transfer.tx_id, text: transfer.text };
      });
    } catch (error) {
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof GateApiError) {
        if (error.retryAfterMs !== undefined) {
          reply.header('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
        }
        const statusCode = error.statusCode === 429 ? 429 : error.statusCode >= 400 && error.statusCode < 500 ? 400 : 502;
        return reply.code(statusCode).send({ error: 'transfer_rejected', label: error.label });
      }
      request.log.error({ error }, 'fund transfer failed');
      return reply.code(500).send({ error: 'transfer_failed' });
    } finally {
      credentials = null;
    }
  });

  app.get('/api/crossex/instruments', async (request, reply) => {
    const now = Date.now();
    const cached = readInstrumentCatalog(database);
    if (cached && isFresh(cached.fetchedAt, now)) {
      const value: CrossExInstrumentCatalog = {
        ...cached,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      };
      return value;
    }

    try {
      const { items, fetchedAt } = await fetchInstrumentCatalog();
      return {
        items,
        fetchedAt,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies CrossExInstrumentCatalog;
    } catch (error) {
      const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
      recordMarketDataFailure(database, 'gate_crossex_instruments', new Date().toISOString(), errorCode);
      request.log.warn({ reason: errorCode }, 'CrossEx instrument discovery failed');
      if (cached) {
        return {
          ...cached,
          source: 'gate_crossex_public_rest',
          cacheStatus: 'stale',
          upstreamStatus: 'unavailable',
        } satisfies CrossExInstrumentCatalog;
      }
      return reply.code(502).send({ error: 'instrument_catalog_unavailable' });
    }
  });

  app.get('/api/crossex/instruments/:symbol/risk-limits', async (request, reply) => {
    const parsed = z.object({ symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_instrument_symbol' });
    const now = Date.now();
    const cached = readRiskLimit(database, parsed.data.symbol);
    if (cached && isFresh(cached.fetchedAt, now)) {
      return {
        ...cached,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies CrossExRiskLimitResponse;
    }

    try {
      const refreshed = await fetchRiskLimit(parsed.data.symbol);
      if (!refreshed) return reply.code(404).send({ error: 'risk_limits_not_found' });
      return {
        ...refreshed,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies CrossExRiskLimitResponse;
    } catch (error) {
      const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
      recordMarketDataFailure(database, 'gate_crossex_risk_limits', new Date().toISOString(), errorCode);
      request.log.warn({ reason: errorCode, symbol: parsed.data.symbol }, 'CrossEx risk-limit discovery failed');
      if (cached) {
        return {
          ...cached,
          source: 'gate_crossex_public_rest',
          cacheStatus: 'stale',
          upstreamStatus: 'unavailable',
        } satisfies CrossExRiskLimitResponse;
      }
      return reply.code(502).send({ error: 'risk_limits_unavailable' });
    }
  });

  app.get('/api/crossex/instruments/:symbol/market-snapshot', async (request, reply) => {
    const parsed = z.object({ symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_instrument_symbol' });
    if (!/^(BINANCE|GATE|OKX)_FUTURE_/.test(parsed.data.symbol)) {
      return reply.code(422).send({ error: 'public_market_source_not_implemented' });
    }

    const cached = readPublicMarketSnapshot(database, parsed.data.symbol);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < PUBLIC_SNAPSHOT_FRESH_MS) {
      return {
        snapshot: cached,
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies PublicMarketSnapshotResponse;
    }

    try {
      const snapshot = await fetchPublicSnapshot(parsed.data.symbol);
      return {
        snapshot,
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies PublicMarketSnapshotResponse;
    } catch (error) {
      const errorCode = error instanceof PublicMarketDataError ? error.code : 'PUBLIC_DATA_ERROR';
      recordMarketDataFailure(database, 'venue_public_market_snapshot', new Date().toISOString(), errorCode);
      request.log.warn({ reason: errorCode, symbol: parsed.data.symbol }, 'public market snapshot failed');
      if (cached) {
        return {
          snapshot: cached,
          cacheStatus: 'stale',
          upstreamStatus: 'unavailable',
        } satisfies PublicMarketSnapshotResponse;
      }
      return reply.code(502).send({ error: 'public_market_snapshot_unavailable' });
    }
  });

  app.get('/api/crossex/account-summary', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'account-summary') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const profileId = activeCredentialProfileId ?? DEFAULT_CREDENTIAL_PROFILE;
    const metadata = getCredentialMetadata(database, profileId);

    let credentials: GateCredentials | null;
    try {
      credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_missing_from_vault' });
      const account = await crossExGateway.queryAccount(credentials);
      const verifiedAt = new Date().toISOString();
      const provider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE) ?? credentialVault.provider;
      upsertCredentialMetadata(database, {
        id: profileId,
        label: metadata?.label ?? (provider === 'env_file' ? 'Gate CrossEx (.env)' : 'Gate CrossEx'),
        provider,
        createdAt: metadata?.createdAt ?? verifiedAt,
        lastVerifiedAt: verifiedAt,
      });
      addAuditEvent(database, 'crossex_read_only_account_verified', {
        profile: profileId,
        accountMode: account.account_mode,
        venueCount: new Set(account.assets.map((asset) => asset.exchange_type)).size,
      });
      return summarizeAccount(account, verifiedAt);
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'read-only CrossEx account refresh failed');
      return reply.code(502).send({ error: 'read_only_account_refresh_failed' });
    } finally {
      credentials = null;
    }
  });

  app.get('/api/crossex/portfolio-snapshot', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'portfolio-snapshot') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    try {
      return await refreshPortfolio();
    } catch (error) {
      if (error instanceof TradingRuntimeError && error.code === 'credential_missing_from_vault') {
        return reply.code(409).send({ error: error.code });
      }
      if (error instanceof TradingRuntimeError && error.code === 'credential_context_changed') {
        return reply.code(409).send({ error: error.code });
      }
      const reason = error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR';
      request.log.warn({ reason }, 'read-only portfolio snapshot failed');
      const cached = livePortfolio.snapshot()?.snapshot ?? readLatestPortfolioSnapshot(database);
      if (cached) {
        const createdAt = new Date().toISOString();
        const reconciliation = stalePortfolioReconciliation(randomUUID(), createdAt, cached);
        saveReconciliationReport(database, reconciliation);
        addAuditEvent(database, 'portfolio_reconciliation_stale', {
          reconciliationStatus: reconciliation.status,
          reconciliationIssueCount: reconciliation.issues.length,
        });
        return livePortfolio.reconcile({
          snapshot: cached,
          dataStatus: 'stale',
          remoteStatus: 'unavailable',
          reconciliation,
        }, 'cache');
      }
      return reply.code(502).send({ error: 'portfolio_snapshot_unavailable' });
    }
  });

  app.get('/api/crossex/positions-snapshot', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'positions-snapshot') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const refreshCredentialGeneration = credentialGeneration;
    if (positionsRefreshGeneration === refreshCredentialGeneration) {
      return reply.code(409).send({ error: 'positions_refresh_in_progress' });
    }
    positionsRefreshGeneration = refreshCredentialGeneration;

    let credentials: GateCredentials | null;
    try {
      credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_missing_from_vault' });
      const positions = await crossExGateway.queryPositions(credentials);
      if (refreshCredentialGeneration !== credentialGeneration) {
        return reply.code(409).send({ error: 'credential_context_changed' });
      }
      tradingRuntime.reconcileLivePositions(normalizeFuturesPositions(positions));
      return tradingRuntime.snapshot();
    } catch (error) {
      const reason = error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR';
      request.log.warn({ reason }, 'positions snapshot refresh failed');
      return reply.code(502).send({ error: 'positions_snapshot_unavailable' });
    } finally {
      credentials = null;
      if (positionsRefreshGeneration === refreshCredentialGeneration) positionsRefreshGeneration = null;
    }
  });

  app.get('/api/reconciliation/reports', async (request, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_report_query' });
    try {
      return { reports: listReconciliationReports(database, parsed.data.limit) } satisfies ReconciliationReportList;
    } catch {
      request.log.error({ reason: 'INVALID_RECONCILIATION_REPORT_STORAGE' }, 'stored reconciliation report validation failed');
      return reply.code(500).send({ error: 'reconciliation_reports_unavailable' });
    }
  });

  app.get('/secure/credentials', async (request, reply) => {
    const liveTradingIntent = hasLiveTradingCredentialIntent(request.query);
    const language = secureCredentialLanguage(request.query);
    const adding = CredentialContextSchema.safeParse(request.query).data?.action === 'add';
    const metadata = activeCredentialProfileId ? getCredentialMetadata(database, activeCredentialProfileId) : null;
    const detectedProvider = metadata || !activeCredentialProfileId
      ? null
      : await storedCredentialVault.getProvider(activeCredentialProfileId);
    return setSecureHtml(reply, renderCredentialEntryPage({
      csrfToken: csrfTokens.issue(),
      configured: metadata !== null || detectedProvider !== null,
      storageAvailable: storedCredentialVault.provider !== 'unavailable',
      storageProviders: selectableStorageProviders,
      configuredStorageProvider: metadata?.provider ?? detectedProvider ?? undefined,
      profiles: listCredentialMetadata(database),
      activeProfileId: activeCredentialProfileId,
      adding,
      tradingEnabled: tradingSession.liveTradingEnabled,
      liveTradingIntent,
      language,
    }));
  });

  app.post('/secure/credentials', async (request, reply) => {
    const parsed = CredentialFormSchema.safeParse(request.body);
    const liveTradingIntent = hasLiveTradingCredentialIntent(request.body);
    const language = secureCredentialLanguage(request.body);
    const adding = parsed.success && parsed.data.action === 'add';
    const activeMetadata = activeCredentialProfileId ? getCredentialMetadata(database, activeCredentialProfileId) : null;
    if (!parsed.success || !csrfTokens.consume(parsed.data.csrfToken)) {
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: activeMetadata !== null,
        storageAvailable: storedCredentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: activeMetadata?.provider,
        profiles: listCredentialMetadata(database),
        activeProfileId: activeCredentialProfileId,
        adding,
        tradingEnabled: tradingSession.liveTradingEnabled,
        liveTradingIntent,
        language,
        errorMessage: credentialPageMessage(language, 'The form was invalid or expired. Credentials were not stored.', '表单无效或已过期。未存储任何 API 密钥。'),
      }), 400);
    }

    let credentials: GateCredentials | null = {
      apiKey: parsed.data.apiKey,
      apiSecret: parsed.data.apiSecret,
    };
    let previousCredentials: GateCredentials | null = null;
    let previousProvider: CredentialStorageProvider | null = null;
    let vaultMutated = false;
    let releaseCredentialMutation: (() => void) | null = null;
    const previousActiveProfileId = activeCredentialProfileId;
    const profileId = adding
      ? `gate-crossex-account-${randomUUID()}`
      : activeCredentialProfileId ?? DEFAULT_CREDENTIAL_PROFILE;
    const previousProfileMetadata = getCredentialMetadata(database, profileId);
    try {
      releaseCredentialMutation = await acquireCredentialMutation();
      await quiesceForCredentialMutation();
      const account = await crossExGateway.queryAccount(credentials);
      const pausedStrategyCount = strategyEngine.pauseRunningStrategiesForCredentialChange(previousActiveProfileId);
      const verifiedAt = new Date().toISOString();
      const storageProvider = parsed.data.storageProvider ?? storedCredentialVault.provider;
      previousCredentials = await storedCredentialVault.get(profileId);
      previousProvider = await storedCredentialVault.getProvider(profileId);
      privateStream.stop();
      await storedCredentialVault.set(profileId, credentials, storageProvider);
      vaultMutated = true;
      try {
        database.transaction(() => {
          const previous = getCredentialMetadata(database, profileId);
          upsertCredentialMetadata(database, {
            id: profileId,
            label: parsed.data.label,
            provider: storageProvider,
            createdAt: previous?.createdAt ?? verifiedAt,
            lastVerifiedAt: verifiedAt,
          });
          saveActiveCredentialProfile(database, profileId);
          addAuditEvent(database, 'credential_verified_and_stored', {
            profile: profileId,
            provider: storageProvider,
            accountMode: account.account_mode,
            addedProfile: adding,
            pausedStrategyCount,
          });
        })();
      } catch (error) {
        if (previousCredentials) {
          await storedCredentialVault.set(profileId, previousCredentials, previousProvider ?? undefined);
        } else {
          await storedCredentialVault.delete(profileId);
        }
        vaultMutated = false;
        throw error;
      }

      activeCredentialProfileId = profileId;
      invalidateAuthenticatedState();
      privateStream.start();
      if (options.startMarketStream) triggerPortfolioRefresh?.();
      return setSecureHtml(reply, renderCredentialSuccessPage({
        label: parsed.data.label,
        accountMode: account.account_mode,
        venues: [...new Set(account.assets.map((asset) => asset.exchange_type))].sort(),
        storageProvider,
        liveTradingIntent,
        language,
      }));
    } catch (error) {
      if (vaultMutated) {
        try {
          if (previousCredentials) {
            await storedCredentialVault.set(profileId, previousCredentials, previousProvider ?? undefined);
          } else {
            await storedCredentialVault.delete(profileId);
          }
          database.transaction(() => {
            if (previousProfileMetadata) upsertCredentialMetadata(database, previousProfileMetadata);
            else deleteCredentialMetadata(database, profileId);
            saveActiveCredentialProfile(database, previousActiveProfileId);
          })();
          activeCredentialProfileId = previousActiveProfileId;
        } catch (rollbackError) {
          request.log.error({ err: rollbackError }, 'credential rollback failed');
        }
      }
      if (releaseCredentialMutation) privateStream.start();
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'credential verification failed');
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: previousActiveProfileId ? getCredentialMetadata(database, previousActiveProfileId) !== null : false,
        storageAvailable: storedCredentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: previousActiveProfileId ? getCredentialMetadata(database, previousActiveProfileId)?.provider : undefined,
        profiles: listCredentialMetadata(database),
        activeProfileId: activeCredentialProfileId,
        adding,
        tradingEnabled: tradingSession.liveTradingEnabled,
        liveTradingIntent,
        language,
        errorMessage: safeCredentialError(error, language),
      }), error instanceof StrategyEngineError || error instanceof TradingRuntimeError
        ? error.statusCode
        : error instanceof GateApiError ? 502 : 500);
    } finally {
      credentials = null;
      previousCredentials = null;
      releaseCredentialMutation?.();
    }
  });

  app.post('/secure/credentials/switch', async (request, reply) => {
    const parsed = SwitchCredentialFormSchema.safeParse(request.body);
    const language = secureCredentialLanguage(request.body);
    const liveTradingIntent = hasLiveTradingCredentialIntent(request.body);
    if (!parsed.success || !csrfTokens.consume(parsed.data.csrfToken)) {
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: activeCredentialProfileId !== null,
        storageAvailable: storedCredentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        profiles: listCredentialMetadata(database),
        activeProfileId: activeCredentialProfileId,
        tradingEnabled: tradingSession.liveTradingEnabled,
        liveTradingIntent,
        language,
        errorMessage: credentialPageMessage(language, 'The account switch request was invalid or expired.', '账户切换请求无效或已过期。'),
      }), 400);
    }
    const target = getCredentialMetadata(database, parsed.data.profileId);
    if (!target) return reply.code(404).send({ error: 'credential_profile_not_found' });
    let credentials: GateCredentials | null = null;
    const previousActiveProfileId = activeCredentialProfileId;
    let releaseCredentialMutation: (() => void) | null = null;
    try {
      releaseCredentialMutation = await acquireCredentialMutation();
      await quiesceForCredentialMutation();
      credentials = await storedCredentialVault.get(target.id);
      if (!credentials) throw new TradingRuntimeError('credential_missing_from_vault', 409);
      const account = await crossExGateway.queryAccount(credentials);
      const pausedStrategyCount = strategyEngine.pauseRunningStrategiesForCredentialChange(previousActiveProfileId);
      const verifiedAt = new Date().toISOString();
      privateStream.stop();
      database.transaction(() => {
        upsertCredentialMetadata(database, { ...target, lastVerifiedAt: verifiedAt });
        saveActiveCredentialProfile(database, target.id);
        addAuditEvent(database, 'credential_profile_switched', {
          fromProfile: previousActiveProfileId,
          toProfile: target.id,
          accountMode: account.account_mode,
          pausedStrategyCount,
        });
      })();
      activeCredentialProfileId = target.id;
      invalidateAuthenticatedState();
      privateStream.start();
      if (options.startMarketStream) triggerPortfolioRefresh?.();
      return setSecureHtml(reply, renderCredentialSwitchSuccessPage({ label: target.label, language }));
    } catch (error) {
      if (releaseCredentialMutation) {
        activeCredentialProfileId = previousActiveProfileId;
        try { saveActiveCredentialProfile(database, previousActiveProfileId); } catch { /* preserve original error */ }
        privateStream.start();
      }
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'credential profile switch failed');
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: previousActiveProfileId !== null,
        storageAvailable: storedCredentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        profiles: listCredentialMetadata(database),
        activeProfileId: previousActiveProfileId,
        tradingEnabled: tradingSession.liveTradingEnabled,
        liveTradingIntent,
        language,
        errorMessage: safeCredentialError(error, language),
      }), error instanceof StrategyEngineError || error instanceof TradingRuntimeError
        ? error.statusCode
        : error instanceof GateApiError ? 502 : 500);
    } finally {
      credentials = null;
      releaseCredentialMutation?.();
    }
  });

  app.post('/secure/credentials/delete', async (request, reply) => {
    const parsed = DeleteCredentialFormSchema.safeParse(request.body);
    const language = secureCredentialLanguage(request.body);
    if (!parsed.success || !csrfTokens.consume(parsed.data.csrfToken)) {
      const metadata = activeCredentialProfileId ? getCredentialMetadata(database, activeCredentialProfileId) : null;
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: metadata !== null,
        storageAvailable: storedCredentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: metadata?.provider,
        profiles: listCredentialMetadata(database),
        activeProfileId: activeCredentialProfileId,
        tradingEnabled: tradingSession.liveTradingEnabled,
        language,
        errorMessage: credentialPageMessage(language, 'The delete request was invalid or expired.', '删除请求无效或已过期。'),
      }), 400);
    }

    let previousCredentials: GateCredentials | null = null;
    let previousProvider: CredentialStorageProvider | null = null;
    let vaultDeleted = false;
    const profileId = activeCredentialProfileId;
    const previousMetadata = profileId ? getCredentialMetadata(database, profileId) : null;
    let releaseCredentialMutation: (() => void) | null = null;
    try {
      if (!profileId) throw new TradingRuntimeError('credential_not_configured', 409);
      releaseCredentialMutation = await acquireCredentialMutation();
      await quiesceForCredentialMutation();
      const pausedStrategyCount = strategyEngine.pauseRunningStrategiesForCredentialChange(profileId);
      previousCredentials = await storedCredentialVault.get(profileId);
      previousProvider = await storedCredentialVault.getProvider(profileId);
      privateStream.stop();
      vaultDeleted = await storedCredentialVault.delete(profileId);
      if (previousCredentials && !vaultDeleted) throw new Error('credential_store_reported_no_deletion');
      try {
        database.transaction(() => {
          deleteCredentialMetadata(database, profileId);
          saveActiveCredentialProfile(database, null);
          addAuditEvent(database, 'credential_deleted', { profile: profileId, pausedStrategyCount });
        })();
      } catch (error) {
        if (previousCredentials) {
          await storedCredentialVault.set(profileId, previousCredentials, previousProvider ?? undefined);
          vaultDeleted = false;
        }
        throw error;
      }
      activeCredentialProfileId = null;
      invalidateAuthenticatedState();
      privateStream.start();
      return setSecureHtml(reply, renderCredentialDeletedPage({ language }));
    } catch {
      if (vaultDeleted && previousCredentials) {
        await storedCredentialVault.set(profileId ?? DEFAULT_CREDENTIAL_PROFILE, previousCredentials, previousProvider ?? undefined)
          .catch((rollbackError) => request.log.error({ err: rollbackError }, 'credential delete rollback failed'));
      }
      if (releaseCredentialMutation && profileId && previousMetadata) {
        try {
          database.transaction(() => {
            upsertCredentialMetadata(database, previousMetadata);
            saveActiveCredentialProfile(database, profileId);
          })();
          activeCredentialProfileId = profileId;
        } catch { /* preserve deletion error */ }
      }
      if (releaseCredentialMutation) privateStream.start();
      const metadata = activeCredentialProfileId ? getCredentialMetadata(database, activeCredentialProfileId) : null;
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: metadata !== null,
        storageAvailable: storedCredentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: metadata?.provider,
        profiles: listCredentialMetadata(database),
        activeProfileId: activeCredentialProfileId,
        tradingEnabled: tradingSession.liveTradingEnabled,
        language,
        errorMessage: credentialPageMessage(language, 'The configured credential store could not delete the credential.', '配置的 API 密钥存储无法删除该 API 密钥。'),
      }), 500);
    } finally {
      previousCredentials = null;
      releaseCredentialMutation?.();
    }
  });

  return app;
}
