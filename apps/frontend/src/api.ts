import {
  AuthenticatedPortfolioSnapshotSchema,
  BorosStrategiesResponseSchema,
  CandleSeriesResponseSchema,
  CredentialConnectionStatusSchema,
  CrossExPortfolioActivityResponseSchema,
  CrossExRiskLimitResponseSchema,
  CrossExTransferBalancesResponseSchema,
  CrossExTransferCoinsResponseSchema,
  CrossExTransferRequestSchema,
  CrossExTransferResponseSchema,
  ExecutionOrderSchema,
  FundingHistoryResponseSchema,
  FundingHistorySeriesResponseSchema,
  FundingOverviewResponseSchema,
  InstrumentsResponseSchema,
  LeverageResponseSchema,
  LeverageUpdateResponseSchema,
  MarketCatalogResponseSchema,
  MarketSizeUnitsSchema,
  MarketSnapshotSchema,
  PublicMarketSnapshotResponseSchema,
  StrategiesResponseSchema,
  StrategyLogsResponseSchema,
  StrategyRecordSchema,
  SystemDiscoverySchema,
  TerminalStreamMessageSchema,
  TradingModeResponseSchema,
  TradingSnapshotSchema,
  UserPreferencesResponseSchema,
  VenueFeeRatesResponseSchema,
  type AuthenticatedPortfolioSnapshot,
  type BorosStrategy,
  type BorosStrategyMarket,
  type BorosStrategiesResponse,
  type Candle,
  type CandleInterval,
  type CandleSeriesResponse,
  type CredentialConnectionStatus,
  type CrossExAccountBookRecord,
  type CrossExInstrument,
  type CrossExPortfolioActivityResponse,
  type CrossExRiskLimitResponse,
  type CrossExTransferBalance,
  type CrossExTransferBalancesResponse,
  type CrossExTransferAccount,
  type CrossExTransferCoin,
  type CrossExTransferCoinsResponse,
  type CrossExTransferRecord,
  type CrossExTransferRequest,
  type CrossExTransferResponse,
  type ExecutionFill,
  type ExecutionOrder,
  type ExecutionPosition,
  type FundingHistoryEntry,
  type FundingHistoryResponse,
  type FundingHistorySeriesEntry,
  type FundingHistorySeriesResponse,
  type FundingOverviewAsset,
  type FundingOverviewResponse,
  type FundingOverviewVenueEntry,
  type LiveBalance,
  type LiveMarket,
  type MarketCatalogAsset,
  type MarketCatalogResponse,
  type MarketSizeUnits,
  type MarketSnapshot,
  type OrderBookSnapshot,
  type PrivateStreamStatus,
  type PublicTrade,
  type PublicMarketSnapshot,
  type PublicMarketSnapshotResponse,
  type StrategyConfig,
  type StrategyLog,
  type StrategyRecord,
  type SystemDiscovery,
  type TerminalStreamMessage,
  type TradingMode,
  type TradingModeResponse,
  type TradingSnapshot,
  type UserPreferences,
  type VenueFeeRate,
  UnresolvedOrderSchema,
  type UnresolvedOrder,
} from '@gate-crossex/shared-types';

export type {
  AuthenticatedPortfolioSnapshot,
  BorosStrategy,
  BorosStrategyMarket,
  BorosStrategiesResponse,
  Candle,
  CandleInterval,
  CandleSeriesResponse,
  CredentialConnectionStatus,
  CrossExAccountBookRecord,
  CrossExInstrument,
  CrossExPortfolioActivityResponse,
  CrossExRiskLimitResponse,
  CrossExTransferBalance,
  CrossExTransferBalancesResponse,
  CrossExTransferAccount,
  CrossExTransferCoin,
  CrossExTransferCoinsResponse,
  CrossExTransferRecord,
  CrossExTransferRequest,
  CrossExTransferResponse,
  ExecutionFill,
  ExecutionOrder,
  FundingHistoryEntry,
  FundingHistoryResponse,
  FundingHistorySeriesEntry,
  FundingHistorySeriesResponse,
  FundingOverviewAsset,
  FundingOverviewResponse,
  FundingOverviewVenueEntry,
  LiveBalance,
  LiveMarket,
  MarketCatalogAsset,
  MarketCatalogResponse,
  MarketSizeUnits,
  MarketSnapshot,
  OrderBookSnapshot,
  PrivateStreamStatus,
  PublicTrade,
  PublicMarketSnapshot,
  PublicMarketSnapshotResponse,
  StrategyConfig,
  StrategyLog,
  StrategyRecord,
  SystemDiscovery,
  TerminalStreamMessage,
  TradingMode,
  TradingModeResponse,
  TradingSnapshot,
  UserPreferences,
  VenueFeeRate,
};
export type Position = ExecutionPosition;

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs?: number,
    readonly label?: string,
    /** Structured fields the backend attached beside `error`/`label`, e.g. blocking orders. */
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code.replaceAll('_', ' ')}${label ? ` (${label})` : ''}`);
  }
}

/** Orders the backend reported as blocking a trading-mode change, or an empty list. */
export function unresolvedOrdersFromError(error: unknown): UnresolvedOrder[] {
  if (!(error instanceof ApiError)) return [];
  const parsed = UnresolvedOrderSchema.array().safeParse(error.details?.unresolvedOrders);
  return parsed.success ? parsed.data : [];
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 25_000;
const inFlightReads = new Map<string, Promise<unknown>>();
let backendCooldownUntil = 0;

function retryAfterMs(value: string | null): number {
  if (!value) return 30_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : 30_000;
}

async function waitForBackendCooldown(): Promise<void> {
  const waitMs = backendCooldownUntil - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function errorPayload(value: unknown): { error?: string; label?: string; details?: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return {};
  const { error, label, ...details } = value as Record<string, unknown>;
  return {
    ...(typeof error === 'string' ? { error } : {}),
    ...(typeof label === 'string' ? { label } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function isReadRequest(init: RequestInit | undefined): boolean {
  if (!init?.method || init.method === 'GET') return true;
  return new Headers(init.headers).has('x-gct-read-intent');
}

async function requestOnce<T>(
  schema: RuntimeSchema<T>,
  path: string,
  init: RequestInit | undefined,
  retryRead: boolean,
): Promise<T> {
  const read = isReadRequest(init);
  if (read) await waitForBackendCooldown();
  else if (Date.now() < backendCooldownUntil) {
    throw new ApiError(429, 'rate_limit_cooldown', backendCooldownUntil - Date.now());
  }

  const timeoutSignal = AbortSignal.timeout(read ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal,
    });
  } catch {
    if (init?.signal?.aborted) throw new ApiError(0, 'request_cancelled');
    if (timeoutSignal.aborted) throw new ApiError(0, 'request_timeout');
    throw new ApiError(0, 'backend_unavailable');
  }

  const rawPayload: unknown = await response.json().catch(() => ({ error: 'invalid_backend_response' }));
  const failure = errorPayload(rawPayload);
  if (response.status === 429) {
    const cooldown = retryAfterMs(response.headers.get('Retry-After'));
    backendCooldownUntil = Math.max(backendCooldownUntil, Date.now() + cooldown);
    if (read && retryRead) {
      await waitForBackendCooldown();
      return requestOnce(schema, path, init, false);
    }
    throw new ApiError(response.status, failure.error ?? 'rate_limit_exceeded', cooldown);
  }
  if (!response.ok) {
    throw new ApiError(response.status, failure.error ?? 'request_failed', undefined, failure.label, failure.details);
  }
  const parsed = schema.safeParse(rawPayload);
  if (!parsed.success) throw new ApiError(response.status, 'invalid_backend_response');
  return parsed.data;
}

async function request<T>(schema: RuntimeSchema<T>, path: string, init?: RequestInit): Promise<T> {
  const read = isReadRequest(init);
  if (!read) return requestOnce(schema, path, init, false);
  const key = `${init?.method ?? 'GET'} ${path} ${typeof init?.body === 'string' ? init.body : ''}`;
  const existing = inFlightReads.get(key);
  if (existing) return existing as Promise<T>;
  const pending = requestOnce(schema, path, init, true).finally(() => {
    if (inFlightReads.get(key) === pending) inFlightReads.delete(key);
  });
  inFlightReads.set(key, pending);
  return pending;
}

/**
 * Reuse a successful read for `ttlMs` so route mounts stop re-downloading and re-validating
 * large, slow-moving payloads. Failures are never cached, and concurrent callers share the
 * in-flight request via the read coalescing above.
 */
function cachedRead<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let cached: { value: T; at: number } | null = null;
  return () => {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    return load().then((value) => {
      cached = { value, at: Date.now() };
      return value;
    });
  };
}

export const api = {
  markets: () => request(MarketSnapshotSchema, '/api/markets'),
  borosStrategies: () => request(BorosStrategiesResponseSchema, '/api/boros/strategies'),
  marketCatalog: () => request(MarketCatalogResponseSchema, '/api/markets/catalog'),
  publicMarketSnapshot: (symbol: string) => request(PublicMarketSnapshotResponseSchema, `/api/crossex/instruments/${encodeURIComponent(symbol)}/market-snapshot`),
  fundingOverview: () => request(FundingOverviewResponseSchema, '/api/markets/funding-overview'),
  fundingHistory: (symbols: string[], durationDays: 1 | 7 | 30) => request(FundingHistoryResponseSchema, '/api/markets/funding-history', {
    method: 'POST',
    headers: { 'x-gct-read-intent': 'funding-history' },
    body: JSON.stringify({ symbols, durationDays }),
  }),
  fundingRankings: (symbols: string[], durationDays: 1 | 7 | 30) => request(FundingHistoryResponseSchema, '/api/markets/funding-rankings', {
    method: 'POST',
    headers: { 'x-gct-read-intent': 'funding-history' },
    body: JSON.stringify({ symbols, durationDays }),
  }),
  fundingHistorySeries: (symbols: string[], durationDays: 1 | 7 | 30) =>
    request(FundingHistorySeriesResponseSchema, '/api/markets/funding-history/series', {
      method: 'POST',
      headers: { 'x-gct-read-intent': 'funding-history' },
      body: JSON.stringify({ symbols, durationDays }),
    }),
  tradingSnapshot: () => request(TradingSnapshotSchema, '/api/trading/snapshot'),
  positionsSnapshot: () => request(TradingSnapshotSchema, '/api/crossex/positions-snapshot', {
    headers: { 'x-gct-read-intent': 'positions-snapshot' },
  }),
  portfolioSnapshot: () => request(AuthenticatedPortfolioSnapshotSchema, '/api/crossex/portfolio-snapshot', {
    headers: { 'x-gct-read-intent': 'portfolio-snapshot' },
  }),
  transferCoins: () => request(CrossExTransferCoinsResponseSchema, '/api/crossex/transfer-coins'),
  transferBalances: () => request(CrossExTransferBalancesResponseSchema, '/api/crossex/transfer-balances', {
    headers: { 'x-gct-read-intent': 'transfer-balances' },
  }),
  portfolioActivity: (coin?: string) => {
    const params = new URLSearchParams({ limit: '100' });
    if (coin) params.set('coin', coin);
    return request(CrossExPortfolioActivityResponseSchema, `/api/crossex/portfolio-activity?${params}`, {
      headers: { 'x-gct-read-intent': 'portfolio-activity' },
    });
  },
  transferFunds: (body: CrossExTransferRequest) => request(CrossExTransferResponseSchema, '/api/crossex/transfers', {
    method: 'POST',
    headers: { 'x-gct-trading-intent': 'transfer-funds' },
    body: JSON.stringify(CrossExTransferRequestSchema.parse(body)),
  }),
  createOrder: (body: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET';
    timeInForce: string;
    quantity: string;
    price?: string;
    reduceOnly: boolean;
    positionSide?: 'NONE' | 'LONG' | 'SHORT';
  }) => request(ExecutionOrderSchema, '/api/trading/orders', {
    method: 'POST',
    headers: { 'x-gct-trading-intent': 'place-order' },
    body: JSON.stringify(body),
  }),
  cancelOrder: (id: string) => request(ExecutionOrderSchema, `/api/trading/orders/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-gct-trading-intent': 'cancel-order' },
  }),
  leverage: (symbol: string) => request(LeverageResponseSchema, `/api/trading/leverage/${encodeURIComponent(symbol)}`, {
    headers: { 'x-gct-read-intent': 'leverage' },
  }),
  setLeverage: (symbol: string, leverage: string) =>
    request(LeverageUpdateResponseSchema, `/api/trading/leverage/${encodeURIComponent(symbol)}`, {
      method: 'POST',
      headers: { 'x-gct-trading-intent': 'set-leverage' },
      body: JSON.stringify({ leverage }),
    }),
  strategies: () => request(StrategiesResponseSchema, '/api/strategies'),
  startStrategy: (config: StrategyConfig) => request(StrategyRecordSchema, '/api/strategies', {
    method: 'POST',
    headers: { 'x-gct-trading-intent': 'start-strategy' },
    body: JSON.stringify(config),
  }),
  updatePremiumTakeProfit: (id: string, takeProfitPremiumPct: string) =>
    request(StrategyRecordSchema, `/api/strategies/${encodeURIComponent(id)}/take-profit`, {
      method: 'PATCH',
      headers: { 'x-gct-trading-intent': 'update-strategy-take-profit' },
      body: JSON.stringify({ takeProfitPremiumPct }),
    }),
  stopStrategy: (id: string) => request(StrategyRecordSchema, `/api/strategies/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    headers: { 'x-gct-trading-intent': 'stop-strategy' },
  }),
  resumeStrategy: (id: string) => request(StrategyRecordSchema, `/api/strategies/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    headers: { 'x-gct-trading-intent': 'resume-strategy' },
  }),
  strategyLogs: (id: string) => request(StrategyLogsResponseSchema, `/api/strategies/${encodeURIComponent(id)}/logs`),
  candles: (
    symbol: string,
    interval: CandleInterval,
    options: { before?: number; limit?: number; fresh?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ interval });
    if (options.before !== undefined) params.set('before', String(options.before));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.fresh) params.set('fresh', '1');
    return request(CandleSeriesResponseSchema, `/api/markets/${encodeURIComponent(symbol)}/candles?${params}`);
  },
  sizeUnits: () => request(MarketSizeUnitsSchema, '/api/markets/size-units'),
  fees: () => request(VenueFeeRatesResponseSchema, '/api/crossex/fees', {
    headers: { 'x-gct-read-intent': 'fee-rates' },
  }),
  connection: () => request(CredentialConnectionStatusSchema, '/api/onboarding/connection'),
  switchAccount: (profileId: string, confirmPauseRunningStrategies = false) => request(
    CredentialConnectionStatusSchema,
    `/api/onboarding/accounts/${encodeURIComponent(profileId)}/activate`,
    {
      method: 'POST',
      headers: { 'x-gct-credential-intent': 'switch-account' },
      body: JSON.stringify({ confirmPauseRunningStrategies }),
    },
  ),
  renameAccount: (profileId: string, label: string) => request(
    CredentialConnectionStatusSchema,
    `/api/onboarding/accounts/${encodeURIComponent(profileId)}`,
    {
      method: 'PATCH',
      headers: { 'x-gct-credential-intent': 'rename-account' },
      body: JSON.stringify({ label }),
    },
  ),
  deleteAccount: (profileId: string) => request(
    CredentialConnectionStatusSchema,
    `/api/onboarding/accounts/${encodeURIComponent(profileId)}`,
    {
      method: 'DELETE',
      headers: { 'x-gct-credential-intent': 'delete-account' },
    },
  ),
  discovery: () => request(SystemDiscoverySchema, '/api/system/discovery'),
  tradingMode: () => request(TradingModeResponseSchema, '/api/trading-mode'),
  setTradingMode: (mode: 'readonly' | 'live', acceptDisclaimer: boolean) =>
    request(TradingModeResponseSchema, '/api/trading-mode', {
      method: 'POST',
      headers: { 'x-gct-trading-intent': 'set-trading-mode' },
      body: JSON.stringify({ mode, acceptDisclaimer }),
    }),
  // The instrument catalog is thousands of rows and changes on the backend's 5-minute cadence;
  // reusing it across route mounts avoids a large download + schema validation per tab switch.
  instruments: cachedRead(5 * 60_000, () => request(InstrumentsResponseSchema, '/api/crossex/instruments')),
  riskLimits: (symbol: string) =>
    request(CrossExRiskLimitResponseSchema, `/api/crossex/instruments/${encodeURIComponent(symbol)}/risk-limits`),
  preferences: () => request(UserPreferencesResponseSchema, '/api/preferences'),
  savePreferences: (preferences: UserPreferences) => request(UserPreferencesResponseSchema, '/api/preferences', {
    method: 'PUT',
    body: JSON.stringify(preferences),
  }),
};

export interface TerminalStreamHandle {
  close(): void;
  watchQuotes(symbols: string[]): void;
  watchKlines(watches: KlineWatch[]): void;
  watchMarket(symbol: string, interval: CandleInterval): void;
  clearWatch(): void;
}

export interface KlineWatch {
  symbol: string;
  interval: CandleInterval;
}

const STREAM_CONNECT_TIMEOUT_MS = 10_000;
const STREAM_STALE_TIMEOUT_MS = 30_000;

export function connectTerminalStream(
  onMessage: (message: TerminalStreamMessage) => void,
  onState: (state: 'connected' | 'reconnecting') => void,
): TerminalStreamHandle {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let quoteSymbols: string[] = [];
  let klineWatches: KlineWatch[] = [];
  let lastWatch: { symbol: string; interval: CandleInterval } | null = null;

  const clearSocketTimers = () => {
    if (connectTimer) clearTimeout(connectTimer);
    if (staleTimer) clearTimeout(staleTimer);
    connectTimer = null;
    staleTimer = null;
  };
  const armStaleTimer = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (!stopped && socket?.readyState === WebSocket.OPEN) socket.close(4000, 'stream_stale');
    }, STREAM_STALE_TIMEOUT_MS);
  };
  const sendQuoteWatch = () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'watch.quotes', symbols: quoteSymbols }));
    }
  };
  const sendKlineWatch = () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'watch.klines', watches: klineWatches }));
    }
  };
  const sendMarketWatch = () => {
    if (socket?.readyState === WebSocket.OPEN && lastWatch) {
      socket.send(JSON.stringify({ type: 'watch.market', symbol: lastWatch.symbol, interval: lastWatch.interval }));
    }
  };
  const scheduleReconnect = (connect: () => void) => {
    if (stopped || reconnectTimer) return;
    onState('reconnecting');
    const exponential = Math.min(15_000, 500 * 2 ** Math.min(5, retry++));
    const wait = Math.round(exponential * (0.85 + Math.random() * 0.3));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  };
  const connect = () => {
    if (stopped) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const nextSocket = new WebSocket(`${protocol}//${window.location.host}/ws/stream`);
    socket = nextSocket;
    connectTimer = setTimeout(() => {
      if (nextSocket.readyState !== WebSocket.OPEN) nextSocket.close();
    }, STREAM_CONNECT_TIMEOUT_MS);
    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket) return;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
      retry = 0;
      onState('connected');
      armStaleTimer();
      sendQuoteWatch();
      if (klineWatches.length > 0) sendKlineWatch();
      sendMarketWatch();
    });
    nextSocket.addEventListener('message', (event) => {
      if (socket !== nextSocket) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = TerminalStreamMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      armStaleTimer();
      onMessage(parsed.data);
    });
    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return;
      clearSocketTimers();
      socket = null;
      scheduleReconnect(connect);
    });
    nextSocket.addEventListener('error', () => {
      if (socket === nextSocket && nextSocket.readyState !== WebSocket.CLOSED) nextSocket.close();
    });
  };
  connect();

  return {
    close: () => {
      stopped = true;
      clearSocketTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
    },
    watchQuotes: (symbols) => {
      const next = [...new Set(symbols)].sort();
      if (next.length === quoteSymbols.length && next.every((symbol, index) => symbol === quoteSymbols[index])) return;
      quoteSymbols = next;
      sendQuoteWatch();
    },
    watchKlines: (watches) => {
      const unique = new Map(watches.map((watch) => [`${watch.symbol}:${watch.interval}`, watch]));
      const next = [...unique.values()].sort((left, right) =>
        left.symbol.localeCompare(right.symbol) || left.interval.localeCompare(right.interval));
      if (next.length === klineWatches.length
        && next.every((watch, index) => watch.symbol === klineWatches[index]?.symbol
          && watch.interval === klineWatches[index]?.interval)) return;
      klineWatches = next;
      sendKlineWatch();
    },
    watchMarket: (symbol, interval) => {
      if (lastWatch?.symbol === symbol && lastWatch.interval === interval) return;
      lastWatch = { symbol, interval };
      sendMarketWatch();
    },
    clearWatch: () => {
      lastWatch = null;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'watch.clear' }));
    },
  };
}
