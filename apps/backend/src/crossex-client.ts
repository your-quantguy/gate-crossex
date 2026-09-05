import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  CrossExTransferAccountSchema,
  CrossExTransferRequestSchema,
  type CrossExTransferRequest,
} from '@gate-crossex/shared-types';
import type { GateCredentials } from './credential-vault.js';

const PRODUCTION_BASE_URL = 'https://api.gateio.ws/api/v4';
const ACCOUNT_ENDPOINT = '/crossex/accounts';
const SYMBOLS_ENDPOINT = '/crossex/rule/symbols';
const RISK_LIMITS_ENDPOINT = '/crossex/rule/risk_limits';
const POSITIONS_ENDPOINT = '/crossex/positions';
const ADL_RANK_ENDPOINT = '/crossex/adl_rank';
const MARGIN_POSITIONS_ENDPOINT = '/crossex/margin_positions';
const OPEN_ORDERS_ENDPOINT = '/crossex/open_orders';
const HISTORY_TRADES_ENDPOINT = '/crossex/history_trades';
const ORDERS_ENDPOINT = '/crossex/orders';
const LEVERAGE_ENDPOINT = '/crossex/positions/leverage';
const FEE_ENDPOINT = '/crossex/fee';
const TRANSFER_COINS_ENDPOINT = '/crossex/transfers/coin';
const TRANSFERS_ENDPOINT = '/crossex/transfers';
const ACCOUNT_BOOK_ENDPOINT = '/crossex/account_book';
const SPOT_ACCOUNTS_ENDPOINT = '/spot/accounts';
const ADL_ENRICHMENT_BUDGET_MS = 1_500;
const ADL_ENRICHMENT_REQUEST_TIMEOUT_MS = 1_000;
const MAX_ADL_ENRICHMENT_SYMBOLS = 20;
const IsolatedExchangeTypeSchema = z.enum([
  'BINANCE', 'OKX', 'GATE', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT',
]);

// Gate API Broker attribution for orders placed through this terminal. Gate requires
// lowercase letters/digits, under 20 chars. Do not send this order-specific header on
// account-setting requests such as leverage updates.
const BROKER_CHANNEL_ID = 'yourquantguy';

const GateAccountAssetSchema = z.object({
  coin: z.string(),
  exchange_type: z.string(),
  balance: z.string(),
  upnl: z.string(),
  equity: z.string(),
  futures_initial_margin: z.string(),
  futures_maintenance_margin: z.string(),
  borrowing_initial_margin: z.string(),
  borrowing_maintenance_margin: z.string(),
  available_balance: z.string(),
  liability: z.string(),
});

const GateAccountSchema = z.object({
  available_margin: z.string(),
  margin_balance: z.string(),
  initial_margin: z.string(),
  maintenance_margin: z.string(),
  initial_margin_rate: z.string(),
  maintenance_margin_rate: z.string(),
  position_mode: z.string(),
  account_mode: z.string(),
  exchange_type: z.string(),
  update_time: z.string(),
  assets: z.array(GateAccountAssetSchema),
});

export type GateCrossExAccount = z.infer<typeof GateAccountSchema>;

const GateSpotAccountSchema = z.object({
  currency: z.string(),
  available: z.string(),
  locked: z.string(),
});
export type GateSpotAccount = z.infer<typeof GateSpotAccountSchema>;

const GateSymbolSchema = z.object({
  symbol: z.string(),
  exchange_type: z.string(),
  business_type: z.string(),
  state: z.string(),
  min_size: z.string(),
  min_notional: z.string().nullable(),
  lot_size: z.string(),
  tick_size: z.string(),
  max_num_orders: z.string(),
  max_market_size: z.string().nullable(),
  max_limit_size: z.string().nullable(),
  contract_size: z.string().nullable(),
  liquidation_fee: z.string().nullable(),
  default_leverage: z.string().nullable().optional(),
  delist_time: z.string(),
});
export type GateCrossExSymbol = z.infer<typeof GateSymbolSchema>;

const GateRiskLimitSchema = z.object({
  symbol: z.string(),
  tiers: z.array(z.object({
    min_risk_limit_value: z.string(),
    max_risk_limit_value: z.string(),
    quick_cal_amount: z.string(),
    leverage_max: z.string(),
    maintenance_rate: z.string(),
    tier: z.string(),
  })),
});
export type GateCrossExRiskLimit = z.infer<typeof GateRiskLimitSchema>;

const GatePositionSchema = z.object({
  position_id: z.string(), symbol: z.string(), position_side: z.string(), initial_margin: z.string(),
  maintenance_margin: z.string(), position_qty: z.string(), position_value: z.string(), upnl: z.string(),
  upnl_rate: z.string(), entry_price: z.string(), mark_price: z.string(), leverage: z.string(),
  max_leverage: z.string(), risk_limit: z.string(), fee: z.string(), funding_fee: z.string(),
  funding_time: z.string(), create_time: z.string(), update_time: z.string(), closed_pnl: z.string(),
});
export type GateCrossExPosition = z.infer<typeof GatePositionSchema>;

const GateAdlRankSchema = z.object({
  user_id: z.string().optional(),
  symbol: z.string(),
  crossex_adl_rank: z.string(),
  exchange_adl_rank: z.string(),
});
export type GateCrossExAdlRank = z.infer<typeof GateAdlRankSchema>;

// Gate's live endpoint returns one object for the required symbol, while older/documented
// responses have also appeared as an array. Normalize both shapes at the API boundary.
const GateAdlRankResponseSchema = z.union([
  GateAdlRankSchema,
  z.array(GateAdlRankSchema),
]).transform((response) => Array.isArray(response) ? response : [response]);

const GateMarginPositionSchema = z.object({
  position_id: z.string(), symbol: z.string(), position_side: z.string(), initial_margin: z.string(),
  maintenance_margin: z.string(), asset_qty: z.string(), asset_coin: z.string(), position_value: z.string(),
  liability: z.string(), liability_coin: z.string(), interest: z.string(), max_position_qty: z.string(),
  entry_price: z.string(), index_price: z.string(), upnl: z.string(), upnl_rate: z.string(),
  leverage: z.string(), max_leverage: z.string(), create_time: z.string(), update_time: z.string(),
});
export type GateCrossExMarginPosition = z.infer<typeof GateMarginPositionSchema>;

// Descriptive order fields are tolerated when Gate omits or nulls them (finished orders can carry a
// sparser payload than open ones). Reconciliation relies only on identity, state, and executed
// figures, and one missing cosmetic field must never leave a local order impossible to settle.
const lenientOrderText = z.string().nullish().transform((value) => value ?? '');
const GateOrderSchema = z.object({
  order_id: z.string(), text: z.string().optional(), client_order_id: z.string().optional(), state: z.string(),
  symbol: z.string(), side: z.string(), type: z.string(), attribute: lenientOrderText, exchange_type: lenientOrderText,
  business_type: lenientOrderText, qty: z.string(), quote_qty: lenientOrderText, price: lenientOrderText,
  time_in_force: lenientOrderText, executed_qty: z.string(), executed_amount: lenientOrderText,
  executed_avg_price: z.string(), fee_coin: lenientOrderText, fee: lenientOrderText, reduce_only: lenientOrderText,
  leverage: lenientOrderText, reason: lenientOrderText, last_executed_qty: lenientOrderText, last_executed_price: lenientOrderText,
  last_executed_amount: lenientOrderText, position_side: lenientOrderText, create_time: lenientOrderText, update_time: z.string(),
}).refine((order) => order.text !== undefined || order.client_order_id !== undefined);
export type GateCrossExOrder = z.infer<typeof GateOrderSchema>;

const GateTradeSchema = z.object({
  transaction_id: z.string(), order_id: z.string(), text: z.string(), symbol: z.string(),
  exchange_type: z.string(), business_type: z.string(), side: z.string(), qty: z.string(), price: z.string(),
  fee: z.string(), fee_coin: z.string(), fee_rate: z.string(), match_role: z.string(), rpnl: z.string(),
  position_mode: z.string(), position_side: z.string(), create_time: z.string(),
});
export type GateCrossExTrade = z.infer<typeof GateTradeSchema>;

export interface GateCrossExPortfolio {
  account: GateCrossExAccount;
  positions: GateCrossExPosition[];
  adlRanks?: GateCrossExAdlRank[];
  marginPositions: GateCrossExMarginPosition[];
  openOrders: GateCrossExOrder[];
  recentTrades: GateCrossExTrade[];
}

export interface ReadOnlyCrossExGateway {
  queryAccount(credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount>;
  querySymbols(): Promise<GateCrossExSymbol[]>;
  queryRiskLimits(symbols: string[]): Promise<GateCrossExRiskLimit[]>;
  queryPositions(credentials: GateCredentials): Promise<GateCrossExPosition[]>;
  queryPortfolio(credentials: GateCredentials): Promise<GateCrossExPortfolio>;
}

export const CrossExOrderRequestSchema = z.object({
  text: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET']).default('LIMIT'),
  time_in_force: z.enum(['GTC', 'IOC', 'FOK', 'POC']).default('GTC'),
  qty: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  price: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  quote_qty: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  reduce_only: z.enum(['true', 'false']).optional(),
  position_side: z.enum(['NONE', 'LONG', 'SHORT']).optional(),
}).superRefine((value, context) => {
  if (value.type === 'LIMIT' && !value.price) context.addIssue({ code: 'custom', message: 'price is required for limit orders', path: ['price'] });
  if (!value.qty && !value.quote_qty) context.addIssue({ code: 'custom', message: 'qty or quote_qty is required', path: ['qty'] });
});
export type CrossExOrderRequest = z.infer<typeof CrossExOrderRequestSchema>;

const GateOrderActionResponseSchema = z.object({ order_id: z.string(), text: z.string() });
export type GateOrderActionResponse = z.infer<typeof GateOrderActionResponseSchema>;

const GateLeverageMapSchema = z.record(z.string(), z.string());
const GateLeverageResponseSchema = z.object({ symbol: z.string(), leverage: z.string() });
export type GateLeverageResponse = z.infer<typeof GateLeverageResponseSchema>;

const GateFeeRateSchema = z.object({
  exchange_type: z.string(),
  spot_maker_fee: z.string(),
  spot_taker_fee: z.string(),
  future_maker_fee: z.string(),
  future_taker_fee: z.string(),
  special_fee_list: z.array(z.object({
    symbol: z.string(),
    taker_fee_rate: z.string(),
    maker_fee_rate: z.string(),
  })).optional(),
});
export type GateFeeRate = z.infer<typeof GateFeeRateSchema>;

const GateTransferCoinSchema = z.object({
  coin: z.string(),
  min_trans_amount: z.string().regex(/^\d+(?:\.\d+)?$/),
  est_fee: z.string().regex(/^\d+(?:\.\d+)?$/),
  precision: z.number().int().nonnegative(),
  is_disabled: z.number().int(),
});
export type GateTransferCoin = z.infer<typeof GateTransferCoinSchema>;

const GateTransferResponseSchema = z.object({ tx_id: z.string(), text: z.string() });
export type GateTransferResponse = z.infer<typeof GateTransferResponseSchema>;

const GateTransferRecordSchema = z.object({
  id: z.string(),
  text: z.string(),
  from_account_type: CrossExTransferAccountSchema,
  to_account_type: CrossExTransferAccountSchema,
  coin: z.string(),
  amount: z.string(),
  actual_receive: z.string().nullable(),
  status: z.enum(['FAIL', 'SUCCESS', 'PENDING']),
  fail_reason: z.string().nullable(),
  create_time: z.number().int().nonnegative(),
  update_time: z.number().int().nonnegative(),
});
export type GateTransferRecord = z.infer<typeof GateTransferRecordSchema>;

const GateAccountBookRecordSchema = z.object({
  id: z.string(),
  business_id: z.string(),
  statement_type: z.string(),
  exchange_type: z.string(),
  coin: z.string(),
  symbol: z.string().nullable().optional(),
  change: z.string(),
  balance: z.string(),
  create_time: z.string(),
});
export type GateAccountBookRecord = z.infer<typeof GateAccountBookRecordSchema>;

export interface TradingCrossExGateway extends ReadOnlyCrossExGateway {
  createOrder(credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse>;
  cancelOrder(credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse>;
  queryOrder(credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder>;
  /**
   * Account-wide open-order list. Optional so scripted gateways may omit it; when present, order
   * quiescence uses it to settle local rows that the order-details endpoint refuses to describe.
   */
  queryOpenOrders?(credentials: GateCredentials): Promise<GateCrossExOrder[]>;
  queryLeverages(credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>>;
  setLeverage(credentials: GateCredentials, symbol: string, leverage: string): Promise<GateLeverageResponse>;
  queryFeeRates(credentials: GateCredentials): Promise<GateFeeRate[]>;
}

export interface PortfolioOperationsCrossExGateway {
  queryAccount(credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount>;
  querySpotAccounts(credentials: GateCredentials): Promise<GateSpotAccount[]>;
  queryTransferCoins(coin?: string): Promise<GateTransferCoin[]>;
  createTransfer(credentials: GateCredentials, transfer: CrossExTransferRequest): Promise<GateTransferResponse>;
  queryTransfers(credentials: GateCredentials, query: { coin?: string; limit: number }): Promise<GateTransferRecord[]>;
  queryAccountBook(credentials: GateCredentials, query: { coin?: string; limit: number; statementType?: string }): Promise<GateAccountBookRecord[]>;
}

export class GateApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly label: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Gate API request failed with ${label}`);
    this.name = 'GateApiError';
  }
}

export interface SignGateRequestInput {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  requestPath: string;
  queryString: string;
  body: string;
  timestamp: string;
  secret: string;
}

export function signGateRequest(input: SignGateRequestInput): string {
  const bodyHash = createHash('sha512').update(input.body).digest('hex');
  const signatureString = [
    input.method,
    input.requestPath,
    input.queryString,
    bodyHash,
    input.timestamp,
  ].join('\n');
  return createHmac('sha512', input.secret).update(signatureString).digest('hex');
}

type AuthenticatedRequestPriority = 'urgent' | 'high' | 'normal' | 'low';

const AUTHENTICATED_REQUEST_PRIORITY: Record<AuthenticatedRequestPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

interface QueuedAuthenticatedRequest {
  priority: number;
  sequence: number;
  work: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new GateApiError(response.status, 'RESPONSE_TOO_LARGE');
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new GateApiError(response.status, 'RESPONSE_TOO_LARGE');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GateApiError(response.status, 'RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof GateApiError) throw error;
    throw new GateApiError(response.status, 'NETWORK_ERROR');
  } finally {
    reader.releaseLock();
  }
}

export class GateCrossExClient implements TradingCrossExGateway, PortfolioOperationsCrossExGateway {
  private readonly authenticatedRequestQueue: QueuedAuthenticatedRequest[] = [];
  private authenticatedRequestActive = false;
  private authenticatedRequestSequence = 0;
  private nextAuthenticatedRequestAt = 0;
  private authenticatedCooldownUntil = 0;

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly baseUrl: string = PRODUCTION_BASE_URL,
    private readonly authenticatedRequestSpacingMs = 100,
  ) {}

  async queryAccount(credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount> {
    const parsedExchange = exchangeType === undefined
      ? null
      : IsolatedExchangeTypeSchema.safeParse(exchangeType.toUpperCase());
    if (parsedExchange !== null && !parsedExchange.success) throw new GateApiError(0, 'INVALID_EXCHANGE_TYPE');
    const queryString = parsedExchange?.success
      ? new URLSearchParams({ exchange_type: parsedExchange.data }).toString()
      : '';
    return this.signedRequest('GET', ACCOUNT_ENDPOINT, queryString, '', credentials, GateAccountSchema, 'INVALID_ACCOUNT_RESPONSE');
  }

  async querySpotAccounts(credentials: GateCredentials): Promise<GateSpotAccount[]> {
    return this.signedRequest(
      'GET', SPOT_ACCOUNTS_ENDPOINT, '', '', credentials,
      z.array(GateSpotAccountSchema), 'INVALID_SPOT_ACCOUNTS_RESPONSE', false, 'normal',
    );
  }

  async queryPositions(credentials: GateCredentials): Promise<GateCrossExPosition[]> {
    return this.signedRequest('GET', POSITIONS_ENDPOINT, '', '', credentials, z.array(GatePositionSchema), 'INVALID_POSITIONS_RESPONSE');
  }

  async queryAdlRanks(credentials: GateCredentials, symbols: string[]): Promise<GateCrossExAdlRank[]> {
    const uniqueSymbols = [...new Set(symbols.filter((symbol) => /^[A-Z0-9_]{3,120}$/.test(symbol)))]
      .slice(0, MAX_ADL_ENRICHMENT_SYMBOLS);
    const deadline = Date.now() + ADL_ENRICHMENT_BUDGET_MS;
    const responses: GateCrossExAdlRank[][] = [];
    for (const symbol of uniqueSymbols) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const queryString = new URLSearchParams({ symbol }).toString();
      try {
        responses.push(await this.signedRequest(
          'GET', ADL_RANK_ENDPOINT, queryString, '', credentials,
          GateAdlRankResponseSchema, 'INVALID_ADL_RANK_RESPONSE', false, 'low',
          Math.max(1, Math.min(ADL_ENRICHMENT_REQUEST_TIMEOUT_MS, remainingMs)),
        ));
      } catch (error) {
        // ADL is supplemental risk metadata. A venue that does not publish a rank must not make
        // the full account snapshot unavailable; the UI renders an explicit unavailable state.
        // Stop immediately on rate limiting so one optional endpoint cannot apply its cooldown once
        // per remaining open symbol and delay all authenticated account work for minutes.
        if (error instanceof GateApiError && error.statusCode === 429) break;
      }
    }
    return responses.flat();
  }

  async queryPortfolio(credentials: GateCredentials): Promise<GateCrossExPortfolio> {
    const historyQuery = new URLSearchParams({ page: '1', limit: '100' }).toString();
    const [account, positions, marginPositions, openOrders, recentTrades] = await Promise.all([
      this.signedRequest('GET', ACCOUNT_ENDPOINT, '', '', credentials, GateAccountSchema, 'INVALID_ACCOUNT_RESPONSE', false, 'low'),
      this.signedRequest('GET', POSITIONS_ENDPOINT, '', '', credentials, z.array(GatePositionSchema), 'INVALID_POSITIONS_RESPONSE', false, 'low'),
      this.signedRequest('GET', MARGIN_POSITIONS_ENDPOINT, '', '', credentials, z.array(GateMarginPositionSchema), 'INVALID_MARGIN_POSITIONS_RESPONSE', false, 'low'),
      this.signedRequest('GET', OPEN_ORDERS_ENDPOINT, '', '', credentials, z.array(GateOrderSchema), 'INVALID_OPEN_ORDERS_RESPONSE', false, 'low'),
      this.signedRequest('GET', HISTORY_TRADES_ENDPOINT, historyQuery, '', credentials, z.array(GateTradeSchema), 'INVALID_TRADES_RESPONSE', false, 'low'),
    ]);
    const adlRanks = await this.queryAdlRanks(
      credentials,
      positions.filter((position) => Number(position.position_qty) !== 0).map((position) => position.symbol),
    );
    return { account, positions, adlRanks, marginPositions, openOrders, recentTrades };
  }

  async createOrder(credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    const validated = CrossExOrderRequestSchema.parse(order);
    const body = JSON.stringify(validated);
    return this.signedRequest(
      'POST',
      ORDERS_ENDPOINT,
      '',
      body,
      credentials,
      GateOrderActionResponseSchema,
      'INVALID_ORDER_ACTION_RESPONSE',
      true,
      'urgent',
    );
  }

  async cancelOrder(credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) throw new GateApiError(0, 'INVALID_ORDER_ID');
    return this.signedRequest('DELETE', `${ORDERS_ENDPOINT}/${encodeURIComponent(orderId)}`, '', '', credentials, GateOrderActionResponseSchema, 'INVALID_ORDER_ACTION_RESPONSE', false, 'urgent');
  }

  async queryOrder(credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) throw new GateApiError(0, 'INVALID_ORDER_ID');
    return this.signedRequest('GET', `${ORDERS_ENDPOINT}/${encodeURIComponent(orderId)}`, '', '', credentials, GateOrderSchema, 'INVALID_ORDER_RESPONSE', false, 'high');
  }

  async queryOpenOrders(credentials: GateCredentials): Promise<GateCrossExOrder[]> {
    return this.signedRequest('GET', OPEN_ORDERS_ENDPOINT, '', '', credentials, z.array(GateOrderSchema), 'INVALID_OPEN_ORDERS_RESPONSE', false, 'high');
  }

  async queryLeverages(credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>> {
    const queryString = symbols.length ? new URLSearchParams({ symbols: symbols.join(',') }).toString() : '';
    return this.signedRequest('GET', LEVERAGE_ENDPOINT, queryString, '', credentials, GateLeverageMapSchema, 'INVALID_LEVERAGE_RESPONSE');
  }

  async setLeverage(credentials: GateCredentials, symbol: string, leverage: string): Promise<GateLeverageResponse> {
    const body = JSON.stringify({ symbol, leverage });
    return this.signedRequest('POST', LEVERAGE_ENDPOINT, '', body, credentials, GateLeverageResponseSchema, 'INVALID_LEVERAGE_RESPONSE');
  }

  async queryFeeRates(credentials: GateCredentials): Promise<GateFeeRate[]> {
    return this.signedRequest('GET', FEE_ENDPOINT, '', '', credentials, z.array(GateFeeRateSchema), 'INVALID_FEE_RESPONSE');
  }

  async createTransfer(credentials: GateCredentials, transfer: CrossExTransferRequest): Promise<GateTransferResponse> {
    const body = JSON.stringify(CrossExTransferRequestSchema.parse(transfer));
    return this.signedRequest(
      'POST',
      TRANSFERS_ENDPOINT,
      '',
      body,
      credentials,
      GateTransferResponseSchema,
      'INVALID_TRANSFER_RESPONSE',
      false,
      'high',
    );
  }

  async queryTransfers(
    credentials: GateCredentials,
    query: { coin?: string; limit: number },
  ): Promise<GateTransferRecord[]> {
    const queryString = new URLSearchParams({
      ...(query.coin ? { coin: query.coin } : {}),
      page: '1',
      limit: String(query.limit),
    }).toString();
    return this.signedRequest(
      'GET', TRANSFERS_ENDPOINT, queryString, '', credentials,
      z.array(GateTransferRecordSchema), 'INVALID_TRANSFERS_RESPONSE', false, 'normal',
    );
  }

  async queryAccountBook(
    credentials: GateCredentials,
    query: { coin?: string; limit: number; statementType?: string },
  ): Promise<GateAccountBookRecord[]> {
    const queryString = new URLSearchParams({
      ...(query.coin ? { coin: query.coin } : {}),
      ...(query.statementType ? { statement_type: query.statementType } : {}),
      page: '1',
      limit: String(query.limit),
    }).toString();
    return this.signedRequest(
      'GET', ACCOUNT_BOOK_ENDPOINT, queryString, '', credentials,
      z.array(GateAccountBookRecordSchema), 'INVALID_ACCOUNT_BOOK_RESPONSE', false, 'normal',
    );
  }

  private async signedRequest<T>(
    method: SignGateRequestInput['method'],
    endpoint: string,
    queryString: string,
    body: string,
    credentials: GateCredentials,
    schema: z.ZodType<T>,
    invalidSchemaLabel: string,
    attributeBrokerOrder = false,
    priority: AuthenticatedRequestPriority = 'normal',
    timeoutMs = 10_000,
  ): Promise<T> {
    const requestPath = `/api/v4${endpoint}`;

    const response = await this.scheduleAuthenticatedRequest(async () => {
      try {
        // Sign only after this request reaches the front of the queue: a Retry-After cooldown can
        // otherwise leave a timestamp stale before the request is sent.
        const timestamp = Math.floor(this.now() / 1_000).toString();
        const signature = signGateRequest({
          method,
          requestPath,
          queryString,
          body,
          timestamp,
          secret: credentials.apiSecret,
        });
        const suffix = queryString ? `?${queryString}` : '';
        const received = await this.fetchImplementation(`${this.baseUrl}${endpoint}${suffix}`, {
          method,
          headers: {
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            KEY: credentials.apiKey,
            Timestamp: timestamp,
            SIGN: signature,
            ...(attributeBrokerOrder ? { 'X-Gate-Channel-Id': BROKER_CHANNEL_ID } : {}),
          },
          ...(body ? { body } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (received.status === 429) {
          this.authenticatedCooldownUntil = Math.max(
            this.authenticatedCooldownUntil,
            Date.now() + this.retryAfterMs(received.headers.get('Retry-After')),
          );
        }
        return received;
      } catch {
        throw new GateApiError(0, 'NETWORK_ERROR');
      }
    }, priority);

    const responseText = await readBoundedResponseText(response, 1_000_000);

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new GateApiError(response.status, 'INVALID_JSON_RESPONSE');
    }

    if (!response.ok) {
      const errorPayload = z.object({ label: z.string() }).safeParse(payload);
      const label = errorPayload.success && /^[A-Z0-9_]{1,80}$/.test(errorPayload.data.label)
        ? errorPayload.data.label
        : 'UNKNOWN_GATE_ERROR';
      const retryAfterMs = response.status === 429 ? this.retryAfterMs(response.headers.get('Retry-After')) : undefined;
      if (retryAfterMs !== undefined) {
        this.authenticatedCooldownUntil = Math.max(this.authenticatedCooldownUntil, Date.now() + retryAfterMs);
      }
      throw new GateApiError(response.status, label, retryAfterMs);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new GateApiError(response.status, invalidSchemaLabel);
    }
    return parsed.data;
  }

  /**
   * One queue protects every authenticated Gate call—orders, leverage, account reads, and order
   * reconciliation alike. Serializing these low-volume control-plane calls prevents independent
   * UI and strategy workflows from combining into an upstream burst.
   */
  private scheduleAuthenticatedRequest<T>(
    work: () => Promise<T>,
    priority: AuthenticatedRequestPriority,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.authenticatedRequestQueue.push({
        priority: AUTHENTICATED_REQUEST_PRIORITY[priority],
        sequence: this.authenticatedRequestSequence++,
        work,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.authenticatedRequestQueue.sort((left, right) =>
        left.priority - right.priority || left.sequence - right.sequence);
      void this.drainAuthenticatedRequestQueue();
    });
  }

  private async drainAuthenticatedRequestQueue(): Promise<void> {
    if (this.authenticatedRequestActive) return;
    this.authenticatedRequestActive = true;
    try {
      while (this.authenticatedRequestQueue.length > 0) {
        const queued = this.authenticatedRequestQueue.shift();
        if (!queued) continue;
        const now = Date.now();
        const waitMs = Math.max(0, this.nextAuthenticatedRequestAt - now, this.authenticatedCooldownUntil - now);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.nextAuthenticatedRequestAt = Date.now() + this.authenticatedRequestSpacingMs;
        try {
          queued.resolve(await queued.work());
        } catch (error) {
          queued.reject(error);
        }
      }
    } finally {
      this.authenticatedRequestActive = false;
      // A request can be enqueued between the last length check and clearing the active flag.
      if (this.authenticatedRequestQueue.length > 0) void this.drainAuthenticatedRequestQueue();
    }
  }

  private retryAfterMs(value: string | null): number {
    if (!value) return 30_000;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : 30_000;
  }

  async querySymbols(): Promise<GateCrossExSymbol[]> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${SYMBOLS_ENDPOINT}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GateApiError(0, 'NETWORK_ERROR');
    }

    const responseText = await readBoundedResponseText(response, 10_000_000);

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new GateApiError(response.status, 'INVALID_JSON_RESPONSE');
    }
    if (!response.ok) {
      throw new GateApiError(response.status, 'PUBLIC_SYMBOLS_REQUEST_FAILED');
    }

    const symbols = z.array(GateSymbolSchema).safeParse(payload);
    if (!symbols.success) {
      throw new GateApiError(response.status, 'INVALID_SYMBOLS_RESPONSE');
    }
    return symbols.data;
  }

  async queryRiskLimits(symbols: string[]): Promise<GateCrossExRiskLimit[]> {
    if (symbols.length < 1 || symbols.length > 50 || symbols.some((symbol) => !/^[A-Z0-9_]{3,120}$/.test(symbol))) {
      throw new GateApiError(0, 'INVALID_RISK_LIMIT_SYMBOLS');
    }
    const query = new URLSearchParams({ symbols: symbols.join(',') }).toString();
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${RISK_LIMITS_ENDPOINT}?${query}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GateApiError(0, 'NETWORK_ERROR');
    }

    const responseText = await readBoundedResponseText(response, 2_000_000);
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new GateApiError(response.status, 'INVALID_JSON_RESPONSE');
    }
    if (!response.ok) throw new GateApiError(response.status, 'PUBLIC_RISK_LIMITS_REQUEST_FAILED');
    const limits = z.array(GateRiskLimitSchema).safeParse(payload);
    if (!limits.success) throw new GateApiError(response.status, 'INVALID_RISK_LIMITS_RESPONSE');
    return limits.data;
  }

  async queryTransferCoins(coin?: string): Promise<GateTransferCoin[]> {
    if (coin !== undefined && !/^[A-Z0-9]{1,20}$/.test(coin)) {
      throw new GateApiError(0, 'INVALID_TRANSFER_COIN');
    }
    const query = coin ? new URLSearchParams({ coin }).toString() : '';
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${TRANSFER_COINS_ENDPOINT}${query ? `?${query}` : ''}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GateApiError(0, 'NETWORK_ERROR');
    }

    const responseText = await readBoundedResponseText(response, 1_000_000);
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new GateApiError(response.status, 'INVALID_JSON_RESPONSE');
    }
    if (!response.ok) throw new GateApiError(response.status, 'PUBLIC_TRANSFER_COINS_REQUEST_FAILED');
    const coins = z.array(GateTransferCoinSchema).safeParse(payload);
    if (!coins.success) throw new GateApiError(response.status, 'INVALID_TRANSFER_COINS_RESPONSE');
    return coins.data;
  }
}

/** @deprecated Use GateCrossExClient. Kept as a source-compatible alias for existing callers. */
