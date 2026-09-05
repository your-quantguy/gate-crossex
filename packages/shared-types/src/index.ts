import { z } from 'zod';
export const EnvironmentSchema = z.enum(['testnet','live']);
export type Environment = z.infer<typeof EnvironmentSchema>;
export const VenueSchema = z.enum(['GATE','BINANCE','OKX','BYBIT']);
export type Venue = z.infer<typeof VenueSchema>;
export const ProductTypeSchema = z.enum(['spot','cross_margin','usdt_perp']);
export type ProductType = z.infer<typeof ProductTypeSchema>;
export const ConnectionStateSchema = z.enum(['connecting','healthy','degraded','reconnecting','stale','disconnected','authentication_failed','rate_limited']);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export interface Instrument { venue: Venue; symbol: string; productType: ProductType; base: string; quote: string; priceTick: string; quantityStep: string; minNotional?: string; contractMultiplier?: string; }
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  environment: EnvironmentSchema,
  database: z.enum(['ok','missing','error']),
  apiDocsRetrievedAt: z.string(),
  connectionState: ConnectionStateSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export interface RiskRule { id: string; scope: 'account'|'venue'|'asset'|'strategy'; metric: string; limit: string; enabled: boolean; }

export const TradingModeSchema = z.enum(['unset', 'readonly', 'live']);
export type TradingMode = z.infer<typeof TradingModeSchema>;

export const TradingModeResponseSchema = z.object({ mode: TradingModeSchema });
export type TradingModeResponse = z.infer<typeof TradingModeResponseSchema>;

export const SystemDiscoverySchema = z.object({
  product: z.string(),
  mode: EnvironmentSchema,
  authenticatedTradingEnabled: z.boolean(),
  tradingMode: TradingModeSchema,
  docs: z.object({ apiVersion: z.string(), retrievedAt: z.string() }),
  database: z.object({ migrationCount: z.number().int().nonnegative(), currentMigration: z.string().nullable() }),
  security: z.object({
    credentialStorage: z.enum(['os_keychain', 'env_file', 'memory_test_only', 'unavailable']),
    credentialEntryPath: z.literal('/secure/credentials'),
    browserJavaScriptHandlesSecrets: z.literal(false),
  }),
});
export type SystemDiscovery = z.infer<typeof SystemDiscoverySchema>;

export const CredentialConnectionStatusSchema = z.object({
  configured: z.boolean(),
  storage: z.enum(['os_keychain', 'env_file', 'memory_test_only', 'unavailable']),
  label: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  secureEntryPath: z.literal('/secure/credentials'),
  readOnly: z.boolean(),
  activeProfileId: z.string().nullable(),
  profiles: z.array(z.object({
    id: z.string(),
    label: z.string(),
    storage: z.enum(['os_keychain', 'env_file', 'memory_test_only', 'unavailable']),
    lastVerifiedAt: z.string().nullable(),
    active: z.boolean(),
  })),
});
export type CredentialConnectionStatus = z.infer<typeof CredentialConnectionStatusSchema>;

export const ReadOnlyAccountSummarySchema = z.object({
  availableMargin: z.string(),
  marginBalance: z.string(),
  initialMargin: z.string(),
  maintenanceMargin: z.string(),
  initialMarginRate: z.string(),
  maintenanceMarginRate: z.string(),
  positionMode: z.string(),
  accountMode: z.string(),
  exchangeType: z.string(),
  venues: z.array(z.string()),
  assetCount: z.number().int().nonnegative(),
  remoteUpdatedAt: z.string(),
  verifiedAt: z.string(),
});
export type ReadOnlyAccountSummary = z.infer<typeof ReadOnlyAccountSummarySchema>;

export const CrossExInstrumentSchema = z.object({
  symbol: z.string(),
  exchangeType: z.string(),
  businessType: z.string(),
  state: z.string(),
  minSize: z.string(),
  minNotional: z.string().nullable(),
  lotSize: z.string(),
  tickSize: z.string(),
  maxNumOrders: z.string(),
  maxMarketSize: z.string().nullable(),
  maxLimitSize: z.string().nullable(),
  contractSize: z.string().nullable(),
  liquidationFee: z.string().nullable(),
  defaultLeverage: z.string().nullable(),
  delistTime: z.string(),
});
export type CrossExInstrument = z.infer<typeof CrossExInstrumentSchema>;

export interface MarketAssetAlias {
  venue: string;
  businessType: string;
  nativeAsset: string;
  canonicalAsset: string;
}

/**
 * Version-controlled identity aliases for venue tickers that name the same underlying asset
 * differently. Keep these scoped by venue and product so similarly named instruments elsewhere
 * are never merged accidentally.
 */
export const MARKET_ASSET_ALIASES = [
  {
    venue: 'HYPERLIQUID',
    businessType: 'FUTURE',
    nativeAsset: 'SKHX',
    canonicalAsset: 'SKHYNIX',
  },
] as const satisfies readonly MarketAssetAlias[];

function marketAssetAliasKey(venue: string, businessType: string, asset: string): string {
  return `${venue.toUpperCase()}:${businessType.toUpperCase()}:${asset.toUpperCase()}`;
}

const canonicalMarketAssetByNative = new Map<string, string>();
const nativeMarketAssetByCanonical = new Map<string, string>();

for (const alias of MARKET_ASSET_ALIASES) {
  const nativeKey = marketAssetAliasKey(alias.venue, alias.businessType, alias.nativeAsset);
  const canonicalKey = marketAssetAliasKey(alias.venue, alias.businessType, alias.canonicalAsset);
  if (canonicalMarketAssetByNative.has(nativeKey)) throw new Error(`Duplicate market asset alias: ${nativeKey}`);
  if (nativeMarketAssetByCanonical.has(canonicalKey)) throw new Error(`Ambiguous market asset routing alias: ${canonicalKey}`);
  canonicalMarketAssetByNative.set(nativeKey, alias.canonicalAsset);
  nativeMarketAssetByCanonical.set(canonicalKey, alias.nativeAsset);
}

/** Resolve an exchange-native asset code to the canonical identity used by the UI and API. */
export function canonicalMarketAsset(venue: string, businessType: string, nativeAsset: string): string {
  return canonicalMarketAssetByNative.get(marketAssetAliasKey(venue, businessType, nativeAsset)) ?? nativeAsset;
}

/** Resolve a canonical asset identity back to the native code required in an executable symbol. */
export function nativeMarketAsset(venue: string, businessType: string, canonicalAsset: string): string {
  return nativeMarketAssetByCanonical.get(marketAssetAliasKey(venue, businessType, canonicalAsset)) ?? canonicalAsset;
}

export const CrossExInstrumentCatalogSchema = z.object({
  items: z.array(CrossExInstrumentSchema),
  fetchedAt: z.string(),
  source: z.literal('gate_crossex_public_rest'),
  cacheStatus: z.enum(['fresh', 'stale']),
  upstreamStatus: z.enum(['healthy', 'unavailable']),
});
export type CrossExInstrumentCatalog = z.infer<typeof CrossExInstrumentCatalogSchema>;

export const CrossExRiskLimitTierSchema = z.object({
  tier: z.string(),
  minRiskLimitValue: z.string(),
  maxRiskLimitValue: z.string(),
  quickCalAmount: z.string(),
  leverageMax: z.string(),
  maintenanceRate: z.string(),
});
export type CrossExRiskLimitTier = z.infer<typeof CrossExRiskLimitTierSchema>;

export const CrossExRiskLimitSchema = z.object({
  symbol: z.string(),
  tiers: z.array(CrossExRiskLimitTierSchema),
});
export type CrossExRiskLimit = z.infer<typeof CrossExRiskLimitSchema>;

export const CrossExRiskLimitResponseSchema = z.object({
  item: CrossExRiskLimitSchema,
  fetchedAt: z.string(),
  source: z.literal('gate_crossex_public_rest'),
  cacheStatus: z.enum(['fresh', 'stale']),
  upstreamStatus: z.enum(['healthy', 'unavailable']),
});
export type CrossExRiskLimitResponse = z.infer<typeof CrossExRiskLimitResponseSchema>;

export const CrossExTransferAccountSchema = z.enum([
  'SPOT',
  'CROSSEX',
  'CROSSEX_BINANCE',
  'CROSSEX_OKX',
  'CROSSEX_GATE',
  'CROSSEX_BYBIT',
  'CROSSEX_KRAKEN',
  'CROSSEX_HYPERLIQUID',
  'CROSSEX_DERIBIT',
]);
export type CrossExTransferAccount = z.infer<typeof CrossExTransferAccountSchema>;

const CrossExTransferAmountSchema = z.string().trim().min(1).max(40)
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0);

export const CrossExTransferRequestSchema = z.object({
  coin: z.string().trim().regex(/^[A-Z0-9]{1,20}$/),
  amount: CrossExTransferAmountSchema,
  from: CrossExTransferAccountSchema,
  to: CrossExTransferAccountSchema,
  text: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
}).refine((value) => value.from !== value.to, {
  message: 'source and destination accounts must differ',
  path: ['to'],
});
export type CrossExTransferRequest = z.infer<typeof CrossExTransferRequestSchema>;

export function canonicalCrossExTransferAccount(
  account: CrossExTransferAccount,
  coin: string,
  accountMode: string,
): CrossExTransferAccount {
  if (coin !== 'USDT') return account;
  if (accountMode === 'CROSS_EXCHANGE' && account.startsWith('CROSSEX_')) return 'CROSSEX';
  if (accountMode === 'ISOLATED_EXCHANGE' && account === 'CROSSEX') return 'CROSSEX_GATE';
  return account;
}

export function canonicalizeCrossExTransfer(
  transfer: CrossExTransferRequest,
  accountMode: string,
): CrossExTransferRequest {
  return {
    ...transfer,
    from: canonicalCrossExTransferAccount(transfer.from, transfer.coin, accountMode),
    to: canonicalCrossExTransferAccount(transfer.to, transfer.coin, accountMode),
  };
}

export type CrossExTransferRouteError =
  | 'HYPERLIQUID_USDC_SPOT_ONLY'
  | 'KRAKEN_USDT_ONLY'
  | 'EXPLICIT_VENUE_ACCOUNT_REQUIRED'
  | 'USDT_SPOT_CROSSEX_REQUIRED'
  | 'INVALID_ISOLATED_TRANSFER_ROUTE';

export function crossExTransferRouteError(
  transfer: Pick<CrossExTransferRequest, 'coin' | 'from' | 'to'>,
  accountMode: string,
): CrossExTransferRouteError | null {
  // Gate's transfer-coin endpoint is a global currency list, not a route matrix. Non-USDT
  // transfers may use explicit venue accounts; Hyperliquid and Kraken add narrower exceptions.
  const originalAccounts = [transfer.from, transfer.to] as const;
  const hasOriginalAccount = (account: CrossExTransferAccount) => originalAccounts.includes(account);
  const originalOtherSideOf = (account: CrossExTransferAccount) => transfer.from === account ? transfer.to : transfer.from;

  if (hasOriginalAccount('CROSSEX_HYPERLIQUID')) {
    if (transfer.coin !== 'USDC' || originalOtherSideOf('CROSSEX_HYPERLIQUID') !== 'SPOT') {
      return 'HYPERLIQUID_USDC_SPOT_ONLY';
    }
    return null;
  }
  if (hasOriginalAccount('CROSSEX_KRAKEN') && transfer.coin !== 'USDT') return 'KRAKEN_USDT_ONLY';

  const from = canonicalCrossExTransferAccount(transfer.from, transfer.coin, accountMode);
  const to = canonicalCrossExTransferAccount(transfer.to, transfer.coin, accountMode);
  const accounts = [from, to] as const;
  const hasAccount = (account: CrossExTransferAccount) => accounts.includes(account);

  if (transfer.coin !== 'USDT') {
    return hasAccount('CROSSEX') ? 'EXPLICIT_VENUE_ACCOUNT_REQUIRED' : null;
  }

  if (from === to) return accountMode === 'CROSS_EXCHANGE'
    ? 'USDT_SPOT_CROSSEX_REQUIRED'
    : 'INVALID_ISOLATED_TRANSFER_ROUTE';

  if (accountMode === 'CROSS_EXCHANGE') {
    return (from === 'SPOT' && to === 'CROSSEX') || (to === 'SPOT' && from === 'CROSSEX')
      ? null
      : 'USDT_SPOT_CROSSEX_REQUIRED';
  }

  return !hasAccount('CROSSEX') && accounts.some((account) => account.startsWith('CROSSEX_'))
    ? null
    : 'INVALID_ISOLATED_TRANSFER_ROUTE';
}

export const CrossExTransferCoinSchema = z.object({
  coin: z.string(),
  minimumAmount: z.string(),
  estimatedFee: z.string(),
  precision: z.number().int().nonnegative(),
  disabled: z.boolean(),
});
export type CrossExTransferCoin = z.infer<typeof CrossExTransferCoinSchema>;

export const CrossExTransferCoinsResponseSchema = z.object({
  items: z.array(CrossExTransferCoinSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type CrossExTransferCoinsResponse = z.infer<typeof CrossExTransferCoinsResponseSchema>;

export const CrossExTransferBalanceSchema = z.object({
  account: CrossExTransferAccountSchema,
  coin: z.string(),
  available: z.string(),
});
export type CrossExTransferBalance = z.infer<typeof CrossExTransferBalanceSchema>;

export const CrossExTransferBalancesResponseSchema = z.object({
  items: z.array(CrossExTransferBalanceSchema),
  fetchedAt: z.string(),
});
export type CrossExTransferBalancesResponse = z.infer<typeof CrossExTransferBalancesResponseSchema>;

export const CrossExTransferResponseSchema = z.object({
  transactionId: z.string(),
  text: z.string(),
});
export type CrossExTransferResponse = z.infer<typeof CrossExTransferResponseSchema>;

export const CrossExTransferRecordSchema = z.object({
  id: z.string(),
  text: z.string(),
  from: CrossExTransferAccountSchema,
  to: CrossExTransferAccountSchema,
  coin: z.string(),
  amount: z.string(),
  actualReceive: z.string().nullable(),
  status: z.enum(['FAIL', 'SUCCESS', 'PENDING']),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CrossExTransferRecord = z.infer<typeof CrossExTransferRecordSchema>;

export const CrossExAccountBookRecordSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  statementType: z.string(),
  venue: z.string(),
  coin: z.string(),
  symbol: z.string().nullable(),
  change: z.string(),
  balance: z.string(),
  createdAt: z.string(),
});
export type CrossExAccountBookRecord = z.infer<typeof CrossExAccountBookRecordSchema>;

export const CrossExPortfolioActivityResponseSchema = z.object({
  transfers: z.array(CrossExTransferRecordSchema),
  accountBook: z.array(CrossExAccountBookRecordSchema),
  fundingFees: z.array(CrossExAccountBookRecordSchema),
  fetchedAt: z.string(),
});
export type CrossExPortfolioActivityResponse = z.infer<typeof CrossExPortfolioActivityResponseSchema>;

export const PublicMarketSnapshotSchema = z.object({
  symbol: z.string(),
  venue: z.enum(['BINANCE', 'GATE', 'OKX']),
  product: z.literal('FUTURE'),
  bidPrice: z.string().nullable(),
  askPrice: z.string().nullable(),
  lastPrice: z.string().nullable(),
  markPrice: z.string(),
  indexPrice: z.string(),
  fundingRate: z.string(),
  predictedFundingRate: z.string().nullable(),
  nextFundingAt: z.string(),
  sourceTimestamp: z.string(),
  fetchedAt: z.string(),
  source: z.enum([
    'binance_futures_public_rest',
    'gate_futures_public_rest',
    'okx_public_rest',
  ]),
});
export type PublicMarketSnapshot = z.infer<typeof PublicMarketSnapshotSchema>;

export const PublicMarketSnapshotResponseSchema = z.object({
  snapshot: PublicMarketSnapshotSchema,
  cacheStatus: z.enum(['fresh', 'stale']),
  upstreamStatus: z.enum(['healthy', 'unavailable']),
});
export type PublicMarketSnapshotResponse = z.infer<typeof PublicMarketSnapshotResponseSchema>;

export const PortfolioBalanceSchema = z.object({
  venue: z.string(), coin: z.string(), balance: z.string(), unrealizedPnl: z.string(),
  equity: z.string(), futuresInitialMargin: z.string(), futuresMaintenanceMargin: z.string(),
  borrowingInitialMargin: z.string(), borrowingMaintenanceMargin: z.string(),
  availableBalance: z.string(), liability: z.string(),
});
export type PortfolioBalance = z.infer<typeof PortfolioBalanceSchema>;

export const PortfolioFuturesPositionSchema = z.object({
  positionId: z.string(), symbol: z.string(), positionSide: z.string(), initialMargin: z.string(),
  maintenanceMargin: z.string(), quantity: z.string(), value: z.string(), unrealizedPnl: z.string(),
  unrealizedPnlRate: z.string(), entryPrice: z.string(), markPrice: z.string(), leverage: z.string(),
  maxLeverage: z.string(), riskLimit: z.string(), fee: z.string(), fundingFee: z.string(),
  fundingTime: z.string(), createdAt: z.string(), updatedAt: z.string(), realizedPnl: z.string(),
  crossExAdlRank: z.string().nullable().optional(), exchangeAdlRank: z.string().nullable().optional(),
});
export type PortfolioFuturesPosition = z.infer<typeof PortfolioFuturesPositionSchema>;

export const PortfolioMarginPositionSchema = z.object({
  positionId: z.string(), symbol: z.string(), positionSide: z.string(), initialMargin: z.string(),
  maintenanceMargin: z.string(), assetQuantity: z.string(), assetCoin: z.string(), value: z.string(),
  liability: z.string(), liabilityCoin: z.string(), interest: z.string(), maxPositionQuantity: z.string(),
  entryPrice: z.string(), indexPrice: z.string(), unrealizedPnl: z.string(), unrealizedPnlRate: z.string(),
  leverage: z.string(), maxLeverage: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type PortfolioMarginPosition = z.infer<typeof PortfolioMarginPositionSchema>;

export const PortfolioOrderSchema = z.object({
  orderId: z.string(), clientOrderId: z.string(), state: z.string(), symbol: z.string(),
  side: z.string(), type: z.string(), attribute: z.string(), venue: z.string(), product: z.string(),
  quantity: z.string(), quoteQuantity: z.string(), price: z.string(), timeInForce: z.string(),
  executedQuantity: z.string(), executedAmount: z.string(), executedAveragePrice: z.string(),
  feeCoin: z.string(), fee: z.string(), reduceOnly: z.string(), leverage: z.string(), reason: z.string(),
  positionSide: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type PortfolioOrder = z.infer<typeof PortfolioOrderSchema>;

export const PortfolioFillSchema = z.object({
  transactionId: z.string(), orderId: z.string(), clientOrderId: z.string(), symbol: z.string(),
  venue: z.string(), product: z.string(), side: z.string(), quantity: z.string(), price: z.string(),
  fee: z.string(), feeCoin: z.string(), feeRate: z.string(), matchRole: z.string(),
  realizedPnl: z.string(), positionMode: z.string(), positionSide: z.string(), createdAt: z.string(),
});
export type PortfolioFill = z.infer<typeof PortfolioFillSchema>;

export const PortfolioSnapshotSchema = z.object({
  account: z.object({
    availableMargin: z.string(), marginBalance: z.string(), initialMargin: z.string(),
    maintenanceMargin: z.string(), initialMarginRate: z.string(), maintenanceMarginRate: z.string(),
    positionMode: z.string(), accountMode: z.string(), exchangeType: z.string(), remoteUpdatedAt: z.string(),
  }),
  balances: z.array(PortfolioBalanceSchema),
  futuresPositions: z.array(PortfolioFuturesPositionSchema),
  marginPositions: z.array(PortfolioMarginPositionSchema),
  openOrders: z.array(PortfolioOrderSchema),
  recentFills: z.array(PortfolioFillSchema),
  fetchedAt: z.string(),
  source: z.literal('gate_crossex_authenticated_rest'),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;

export const ReconciliationIssueSchema = z.object({
  code: z.enum([
    'baseline_created', 'unknown_order_detected', 'order_resolved_by_fill',
    'order_missing_without_fill', 'unknown_futures_position_detected',
    'futures_position_changed', 'futures_position_disappeared',
    'unknown_margin_position_detected', 'margin_position_changed',
    'margin_position_disappeared', 'new_fill_detected',
    'account_configuration_changed', 'remote_refresh_failed',
  ]),
  severity: z.enum(['info', 'warning']),
  entityType: z.enum(['account', 'order', 'futures_position', 'margin_position', 'fill', 'system']),
  entityId: z.string().nullable(),
  summary: z.string(),
  changedFields: z.array(z.string()),
});
export type ReconciliationIssue = z.infer<typeof ReconciliationIssueSchema>;

export const ReconciliationReportSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: z.enum(['baseline', 'clean', 'changes_detected', 'ambiguous', 'stale']),
  previousFetchedAt: z.string().nullable(),
  currentFetchedAt: z.string(),
  issues: z.array(ReconciliationIssueSchema),
});
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

export const PortfolioSnapshotResponseSchema = z.object({
  snapshot: PortfolioSnapshotSchema,
  dataStatus: z.enum(['fresh', 'stale']),
  remoteStatus: z.enum(['healthy', 'unavailable']),
  reconciliation: ReconciliationReportSchema,
});
export type PortfolioSnapshotResponse = z.infer<typeof PortfolioSnapshotResponseSchema>;

export const ReconciliationReportListSchema = z.object({
  reports: z.array(ReconciliationReportSchema),
});
export type ReconciliationReportList = z.infer<typeof ReconciliationReportListSchema>;

export const CandleIntervalSchema = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;

export const CANDLE_INTERVAL_MILLISECONDS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export const CandleSchema = z.object({
  startTime: z.number().int().nonnegative(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
  closed: z.boolean(),
});
export type Candle = z.infer<typeof CandleSchema>;

/**
 * Return only the newest gap-free candle run. A chart must never connect two
 * unrelated market periods across a missing interval.
 */
export function contiguousCandleTail(
  candles: Candle[],
  interval: CandleInterval,
  limit = Number.MAX_SAFE_INTEGER,
): Candle[] {
  const byStartTime = new Map<number, Candle>();
  for (const candle of candles) byStartTime.set(candle.startTime, candle);
  const ordered = [...byStartTime.values()].sort((left, right) => left.startTime - right.startTime);
  if (ordered.length === 0 || limit <= 0) return [];

  const intervalMilliseconds = CANDLE_INTERVAL_MILLISECONDS[interval];
  let first = ordered.length - 1;
  while (first > 0 && ordered[first]!.startTime - ordered[first - 1]!.startTime === intervalMilliseconds) {
    first -= 1;
  }
  return ordered.slice(Math.max(first, ordered.length - Math.floor(limit)));
}

export const CandleSeriesResponseSchema = z.object({
  symbol: z.string(),
  interval: CandleIntervalSchema,
  candles: z.array(CandleSchema),
  source: z.enum(['venue_public_rest_and_crossex_websocket', 'crossex_websocket_only']),
  building: z.boolean(),
  hasMore: z.boolean(),
});
export type CandleSeriesResponse = z.infer<typeof CandleSeriesResponseSchema>;

export const MarketCatalogVenueSchema = z.object({
  venue: z.string(),
  symbol: z.string(),
  quote: z.string(),
});
export type MarketCatalogVenue = z.infer<typeof MarketCatalogVenueSchema>;

export const MarketCatalogAssetSchema = z.object({
  asset: z.string(),
  /** True when the market hub is currently streaming ticker/funding/OI for this asset. */
  streamed: z.boolean(),
  venues: z.array(MarketCatalogVenueSchema),
});
export type MarketCatalogAsset = z.infer<typeof MarketCatalogAssetSchema>;

export const MarketCatalogResponseSchema = z.object({
  assets: z.array(MarketCatalogAssetSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type MarketCatalogResponse = z.infer<typeof MarketCatalogResponseSchema>;

export const FundingOverviewVenueEntrySchema = z.object({
  venue: z.string(),
  symbol: z.string(),
  quote: z.string(),
  /** Native fraction charged or paid at one venue funding interval. */
  fundingRate: z.string().nullable(),
  /** Native funding interval in hours; null when the venue row is unavailable. */
  fundingIntervalHours: z.number().positive().max(24).nullable(),
  /** 8h-equivalent fraction used for cross-venue comparisons. */
  fundingRate8h: z.string().nullable(),
  nextFundingAt: z.string().nullable(),
  /** Open interest in USD; null when the venue publishes no bulk OI (BINANCE) or the row is missing. */
  openInterestValue: z.string().nullable(),
  /** Last or mark price from the venue's bulk ticker feed. */
  lastPrice: z.string().nullable(),
  /** Fractional 24h price change, e.g. -0.012 means -1.2%. */
  change24h: z.string().nullable(),
  fetchedAt: z.string().nullable(),
});
export type FundingOverviewVenueEntry = z.infer<typeof FundingOverviewVenueEntrySchema>;

export const FundingOverviewAssetSchema = z.object({
  asset: z.string(),
  venues: z.array(FundingOverviewVenueEntrySchema),
});
export type FundingOverviewAsset = z.infer<typeof FundingOverviewAssetSchema>;

export const FundingOverviewVenueStatusSchema = z.object({
  venue: z.string(),
  status: z.enum(['ok', 'error']),
  fetchedAt: z.string().nullable(),
  rowCount: z.number().int().nonnegative(),
});
export type FundingOverviewVenueStatus = z.infer<typeof FundingOverviewVenueStatusSchema>;

export const FundingOverviewResponseSchema = z.object({
  assets: z.array(FundingOverviewAssetSchema),
  venueStatus: z.array(FundingOverviewVenueStatusSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type FundingOverviewResponse = z.infer<typeof FundingOverviewResponseSchema>;

export const FundingHistoryEntrySchema = z.object({
  symbol: z.string(),
  status: z.enum(['ok', 'pending', 'unavailable']),
  /** Realized funding fractions summed over rolling windows ending at fetchedAt. */
  rate24h: z.string().nullable(),
  rate7d: z.string().nullable(),
  rate30d: z.string().nullable(),
  settlementCount30d: z.number().int().nonnegative(),
  oldestFundingAt: z.string().nullable(),
  newestFundingAt: z.string().nullable(),
  fetchedAt: z.string(),
});
export type FundingHistoryEntry = z.infer<typeof FundingHistoryEntrySchema>;

export const FundingHistoryResponseSchema = z.object({
  entries: z.array(FundingHistoryEntrySchema),
  fetchedAt: z.string(),
});
export type FundingHistoryResponse = z.infer<typeof FundingHistoryResponseSchema>;

export const FundingHistoryPointSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  rate: z.string(),
});
export type FundingHistoryPoint = z.infer<typeof FundingHistoryPointSchema>;

export const FundingHistorySeriesEntrySchema = z.object({
  symbol: z.string(),
  status: z.enum(['ok', 'unavailable']),
  points: z.array(FundingHistoryPointSchema),
  fetchedAt: z.string(),
});
export type FundingHistorySeriesEntry = z.infer<typeof FundingHistorySeriesEntrySchema>;

export const FundingHistorySeriesResponseSchema = z.object({
  entries: z.array(FundingHistorySeriesEntrySchema),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  fetchedAt: z.string(),
});
export type FundingHistorySeriesResponse = z.infer<typeof FundingHistorySeriesResponseSchema>;

export const OrderBookLevelSchema = z.tuple([z.string(), z.string()]);
export type OrderBookLevel = z.infer<typeof OrderBookLevelSchema>;

export const OrderBookSnapshotSchema = z.object({
  symbol: z.string(),
  bids: z.array(OrderBookLevelSchema),
  asks: z.array(OrderBookLevelSchema),
  updatedAt: z.string(),
  source: z.literal('gate_crossex_websocket'),
});
export type OrderBookSnapshot = z.infer<typeof OrderBookSnapshotSchema>;

export const PublicTradeSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  price: z.string(),
  quantity: z.string(),
  side: z.enum(['BUY', 'SELL']),
  executedAt: z.string(),
});
export type PublicTrade = z.infer<typeof PublicTradeSchema>;

export const SymbolFeeRateSchema = z.object({
  symbol: z.string(),
  makerFee: z.string(),
  takerFee: z.string(),
});
export type SymbolFeeRate = z.infer<typeof SymbolFeeRateSchema>;

export const VenueFeeRateSchema = z.object({
  venue: z.string(),
  spotMakerFee: z.string(),
  spotTakerFee: z.string(),
  futureMakerFee: z.string(),
  futureTakerFee: z.string(),
  specialFees: z.array(SymbolFeeRateSchema).optional(),
});
export type VenueFeeRate = z.infer<typeof VenueFeeRateSchema>;

export const VenueFeeRatesResponseSchema = z.object({
  fees: z.array(VenueFeeRateSchema),
  fetchedAt: z.string(),
  cacheStatus: z.enum(['fresh', 'stale']),
});
export type VenueFeeRatesResponse = z.infer<typeof VenueFeeRatesResponseSchema>;

export const LiveBalanceSchema = z.object({
  venue: z.string(),
  coin: z.string(),
  balance: z.string(),
  availableBalance: z.string(),
  equity: z.string(),
  unrealizedPnl: z.string(),
  updatedAt: z.string(),
});
export type LiveBalance = z.infer<typeof LiveBalanceSchema>;

export const LiveMarketSchema = z.object({
  symbol: z.string(),
  venue: z.string(),
  asset: z.string(),
  lastPrice: z.string(),
  bidPrice: z.string(),
  bidSize: z.string(),
  askPrice: z.string(),
  askSize: z.string(),
  open24h: z.string(),
  high24h: z.string(),
  low24h: z.string(),
  volume24h: z.string(),
  quoteVolume24h: z.string(),
  fundingRate: z.string(),
  nextFundingAt: z.string(),
  openInterest: z.string(),
  openInterestValue: z.string(),
  /** Backend wall-clock time when the latest ticker frame was received. */
  receivedAt: z.string(),
  /** Exchange source timestamp carried by the latest ticker frame. */
  updatedAt: z.string(),
  source: z.enum(['gate_crossex_websocket', 'demo_seed']),
});
export type LiveMarket = z.infer<typeof LiveMarketSchema>;

export const MarketSnapshotSchema = z.object({
  connectionState: z.enum(['connecting', 'healthy', 'reconnecting', 'stale', 'disconnected']),
  updatedAt: z.string(),
  markets: z.array(LiveMarketSchema),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const ExecutionOrderSchema = z.object({
  id: z.string(),
  remoteOrderId: z.string().nullable(),
  clientOrderId: z.string(),
  symbol: z.string(),
  venue: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET']),
  timeInForce: z.string(),
  quantity: z.string(),
  price: z.string().nullable(),
  reduceOnly: z.boolean(),
  state: z.string(),
  executedQuantity: z.string(),
  executedAveragePrice: z.string().nullable(),
  failureReason: z.string().nullable().optional(),
  strategyId: z.string().nullable(),
  strategyLeg: z.string().nullable(),
  strategyClip: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExecutionOrder = z.infer<typeof ExecutionOrderSchema>;

/**
 * A locally tracked order whose remote state could not be proven terminal during quiescence.
 * Trading-mode responses carry these so the UI can show exactly what blocks live activation and
 * why, instead of a bare list of ids.
 */
export const UnresolvedOrderSchema = ExecutionOrderSchema.pick({
  id: true, remoteOrderId: true, clientOrderId: true, symbol: true, venue: true, side: true,
  quantity: true, executedQuantity: true, price: true, state: true, strategyId: true,
}).extend({ reason: z.string() });
export type UnresolvedOrder = z.infer<typeof UnresolvedOrderSchema>;

export const ExecutionPositionSchema = z.object({
  position_id: z.string(),
  symbol: z.string(),
  venue: z.string(),
  quantity: z.string(),
  entry_price: z.string(),
  mark_price: z.string(),
  realized_pnl: z.string(),
  funding_fee: z.string().nullable().optional(),
  updated_at: z.string(),
});
export type ExecutionPosition = z.infer<typeof ExecutionPositionSchema>;

export const ExecutionFillSchema = z.object({
  id: z.string(),
  order_id: z.string(),
  symbol: z.string(),
  venue: z.string(),
  side: z.string(),
  quantity: z.string(),
  price: z.string(),
  fee: z.string(),
  realized_pnl: z.string(),
  created_at: z.string(),
});
export type ExecutionFill = z.infer<typeof ExecutionFillSchema>;

export const TradingSnapshotSchema = z.object({
  mode: z.literal('live'),
  orders: z.array(ExecutionOrderSchema),
  positions: z.array(ExecutionPositionSchema),
  fills: z.array(ExecutionFillSchema),
  balances: z.array(LiveBalanceSchema),
});
export type TradingSnapshot = z.infer<typeof TradingSnapshotSchema>;

export const PrivateStreamStatusSchema = z.object({
  state: z.enum([
    'disconnected',
    'credentials_missing',
    'connecting',
    'authenticating',
    'subscribing',
    'live',
    'reconnecting',
    'authentication_failed',
  ]),
  lastEventAt: z.string().nullable(),
  lastReadyAt: z.string().nullable(),
  retryAttempt: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type PrivateStreamStatus = z.infer<typeof PrivateStreamStatusSchema>;

export const AuthenticatedPortfolioSnapshotSchema = PortfolioSnapshotResponseSchema.extend({
  live: z.object({
    source: z.enum(['cache', 'rest', 'websocket']),
    sequence: z.number().int().nonnegative(),
    lastEventAt: z.string().nullable(),
    lastReconciledAt: z.string().nullable(),
    stream: PrivateStreamStatusSchema,
  }).optional(),
});
export type AuthenticatedPortfolioSnapshot = z.infer<typeof AuthenticatedPortfolioSnapshotSchema>;

const PositiveDecimalTextSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
const SignedDecimalTextSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);

/** Public fixed-rate opportunity returned by Pendle's Boros strategy API. */
export const BorosStrategyMarketSchema = z.object({
  marketId: z.number().int().positive(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenId: z.number().int().nonnegative(),
  name: z.string().min(1),
  assetSymbol: z.string().regex(/^[A-Z0-9]+$/),
  maturity: z.number().int().positive(),
  state: z.string().min(1),
  impliedApr: z.number().finite(),
  maxLeverage: z.number().positive(),
  maxPerpLeverage: z.number().positive(),
  ammId: z.number().int().nonnegative(),
  platformName: z.string().min(1),
  /** Enriched by the local backend from Boros market configuration (decimal rate, 1 = 100%). */
  takerFeeRate: z.number().finite().nonnegative().optional(),
  /** Annualized fee charged across periodic settlements (decimal rate, 1 = 100%). */
  settleFeeRate: z.number().finite().nonnegative().optional(),
  /** Boros initial-margin factor (kIM, decimal rate, 1 = 100%). */
  initialMarginFactor: z.number().finite().nonnegative().optional(),
  /** Minimum absolute APR used by Boros for margin calculations. */
  marginRateFloor: z.number().finite().nonnegative().optional(),
  /** Minimum remaining term used by Boros for margin calculations, in seconds. */
  marginTimeFloorSeconds: z.number().int().nonnegative().optional(),
  /** Live remaining term returned by Boros, in seconds. */
  timeToMaturitySeconds: z.number().int().nonnegative().optional(),
});
export type BorosStrategyMarket = z.infer<typeof BorosStrategyMarketSchema>;

export const BorosStrategySchema = z.object({
  id: z.string().min(1),
  longMarket: BorosStrategyMarketSchema,
  shortMarket: BorosStrategyMarketSchema,
  daysToMaturity: z.number().int().positive(),
  impliedAprSpread: z.number().finite(),
  maxPerpLeverage: z.number().positive(),
  aprTimesMaxLeverage: z.number().finite(),
});
export type BorosStrategy = z.infer<typeof BorosStrategySchema>;

export const BorosUpstreamStrategiesResponseSchema = z.object({
  strategies: z.array(BorosStrategySchema),
  totalCount: z.number().int().nonnegative(),
});
export type BorosUpstreamStrategiesResponse = z.infer<typeof BorosUpstreamStrategiesResponseSchema>;

export const BorosMarketFeeConfigSchema = z.object({
  marketId: z.number().int().positive(),
  imData: z.object({
    marginFloor: z.number().finite().nonnegative(),
  }),
  config: z.object({
    takerFee: z.string().regex(/^\d+$/),
    kIM: z.string().regex(/^\d+$/),
    tThresh: z.number().int().nonnegative(),
  }),
  extConfig: z.object({
    settleFeeRate: z.string().regex(/^\d+$/),
  }),
  data: z.object({
    timeToMaturity: z.number().int().nonnegative(),
  }),
});
export type BorosMarketFeeConfig = z.infer<typeof BorosMarketFeeConfigSchema>;

export const BorosUpstreamMarketFeesResponseSchema = z.object({
  results: z.array(BorosMarketFeeConfigSchema),
}).passthrough();
export type BorosUpstreamMarketFeesResponse = z.infer<typeof BorosUpstreamMarketFeesResponseSchema>;

export const BorosStrategiesResponseSchema = BorosUpstreamStrategiesResponseSchema.extend({
  fetchedAt: z.iso.datetime(),
  cacheStatus: z.enum(['fresh', 'stale']),
  source: z.literal('boros_open_api'),
});
export type BorosStrategiesResponse = z.infer<typeof BorosStrategiesResponseSchema>;

export const StrategyConfigSchema = z.object({
  kind: z.enum(['position', 'auto', 'premium']),
  asset: z.string(),
  hedgeAsset: z.string().optional(),
  adrRatio: PositiveDecimalTextSchema.optional(),
  hedgeMode: z.enum(['SHARE_RATIO', 'EQUAL_NOTIONAL']).optional(),
  leftLeverage: PositiveDecimalTextSchema.optional(),
  rightLeverage: PositiveDecimalTextSchema.optional(),
  leftVenue: z.string(),
  rightVenue: z.string(),
  leftSide: z.enum(['BUY', 'SELL']),
  rightSide: z.enum(['BUY', 'SELL']),
  /** Paired funding-arbitrage strategies may use a negative spread as their maximum opening cost. */
  entryBps: SignedDecimalTextSchema.optional(),
  takeProfitBps: PositiveDecimalTextSchema.optional(),
  entryPremiumPct: SignedDecimalTextSchema.optional(),
  takeProfitPremiumPct: SignedDecimalTextSchema.optional(),
  grid: z.boolean().optional(),
  gridStepPct: PositiveDecimalTextSchema.optional(),
  gridLevels: z.number().int().positive().optional(),
  totalAmount: PositiveDecimalTextSchema.optional(),
  maxPosition: PositiveDecimalTextSchema.optional(),
  perOrderQuantity: PositiveDecimalTextSchema,
  reduceOnly: z.boolean(),
  executionMethod: z.enum(['TAKER_TAKER', 'MAKER_TAKER']),
  makerLeg: z.enum(['left', 'right']).optional(),
  closePlan: z.object({
    orderCount: z.number().int().min(2).max(100),
    intervalSeconds: z.number().int().min(1).max(86_400),
    targets: z.array(z.object({
      symbol: z.string(),
      side: z.enum(['BUY', 'SELL']),
      quantity: PositiveDecimalTextSchema,
      positionSide: z.enum(['NONE', 'LONG', 'SHORT']),
    })).min(1).max(20),
  }).optional(),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export const StrategyRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(['position', 'auto', 'premium']),
  status: z.string(),
  accountProfileId: z.string().nullable(),
  accountLabel: z.string().nullable(),
  config: StrategyConfigSchema,
  progress: z.number(),
  filledQuantity: z.string(),
  filledLeft: z.string(),
  filledRight: z.string(),
  openPosition: z.string(),
  realizedPnl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stoppedAt: z.string().nullable(),
});
export type StrategyRecord = z.infer<typeof StrategyRecordSchema>;

export const StrategyLogSchema = z.object({
  id: z.string(),
  level: z.string(),
  event: z.string(),
  condition: z.string(),
  quantity: z.string(),
  result: z.string(),
  createdAt: z.string(),
});
export type StrategyLog = z.infer<typeof StrategyLogSchema>;

export const MarketSizeUnitsSchema = z.object({
  units: z.record(z.string(), z.string()),
  fetchedAt: z.string(),
});
export type MarketSizeUnits = z.infer<typeof MarketSizeUnitsSchema>;

export const TerminalStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('market.snapshot'), payload: MarketSnapshotSchema }),
  z.object({ type: z.literal('market.status'), payload: z.object({
    connectionState: MarketSnapshotSchema.shape.connectionState,
    checkedAt: z.string(),
  }) }),
  z.object({ type: z.literal('market.update'), payload: LiveMarketSchema }),
  z.object({ type: z.literal('market.batch'), payload: z.object({ markets: z.array(LiveMarketSchema) }) }),
  z.object({ type: z.literal('execution.snapshot'), payload: TradingSnapshotSchema }),
  z.object({ type: z.literal('execution.update'), payload: ExecutionOrderSchema }),
  z.object({ type: z.literal('portfolio.snapshot'), payload: AuthenticatedPortfolioSnapshotSchema }),
  z.object({ type: z.literal('portfolio.cleared'), payload: z.null() }),
  z.object({ type: z.literal('private-stream.status'), payload: PrivateStreamStatusSchema }),
  z.object({ type: z.literal('strategy.snapshot'), payload: z.object({ strategies: z.array(StrategyRecordSchema) }) }),
  z.object({ type: z.literal('strategy.update'), payload: StrategyRecordSchema }),
  z.object({ type: z.literal('orderbook.update'), payload: OrderBookSnapshotSchema }),
  z.object({ type: z.literal('trade.snapshot'), payload: z.object({ symbol: z.string(), trades: z.array(PublicTradeSchema) }) }),
  z.object({ type: z.literal('trade.update'), payload: z.object({ symbol: z.string(), trade: PublicTradeSchema }) }),
  z.object({ type: z.literal('trade.batch'), payload: z.object({ symbol: z.string(), trades: z.array(PublicTradeSchema) }) }),
  z.object({ type: z.literal('kline.snapshot'), payload: z.object({
    symbol: z.string(), interval: CandleIntervalSchema, candles: z.array(CandleSchema),
  }) }),
  z.object({ type: z.literal('kline.update'), payload: z.object({
    symbol: z.string(), interval: CandleIntervalSchema, candle: CandleSchema,
  }) }),
  z.object({ type: z.literal('balance.update'), payload: LiveBalanceSchema }),
  z.object({ type: z.literal('mode.update'), payload: z.object({ mode: TradingModeSchema }) }),
]);
export type TerminalStreamMessage = z.infer<typeof TerminalStreamMessageSchema>;

export const StrategiesResponseSchema = z.object({ strategies: z.array(StrategyRecordSchema) });
export const StrategyLogsResponseSchema = z.object({ logs: z.array(StrategyLogSchema) });
export const InstrumentsResponseSchema = z.object({ items: z.array(CrossExInstrumentSchema) });
export const LeverageResponseSchema = z.object({ symbol: z.string(), leverage: z.string().nullable() });
export const LeverageUpdateResponseSchema = z.object({ symbol: z.string(), leverage: z.string() });

// Strict so a renamed or unknown settings key fails loudly instead of silently writing a row
// no reader will ever look at. Every key is optional: clients send only what changed.
export const UserPreferencesSchema = z.strictObject({
  language: z.enum(['en', 'zh']),
  theme: z.enum(['dark', 'light']),
  favorites: z.array(z.string().min(1).max(120)).max(500),
  notificationsSeenAt: z.iso.datetime(),
  lastAsset: z.string().regex(/^[A-Z0-9]{1,30}$/),
  /** Show the order-confirmation dialog before submitting a ticket; on unless the user opted out. */
  confirmOrders: z.boolean(),
}).partial();
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const UserPreferencesResponseSchema = z.object({ preferences: UserPreferencesSchema });
export type UserPreferencesResponse = z.infer<typeof UserPreferencesResponseSchema>;
