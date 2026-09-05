import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageContext } from './i18n.js';
import { UnresolvedOrdersNotice } from './trading-mode-recovery.js';
import { describeUnresolvedReason } from './unresolved-order-reason.js';

const identity = (key: string) => key;

describe('describeUnresolvedReason', () => {
  it('turns quiesce reason tokens into readable sentences', () => {
    expect(describeUnresolvedReason('cancel_not_confirmed:OPEN', identity)).toBe('Gate still reports this order as OPEN');
    expect(describeUnresolvedReason('lookup_failed:NETWORK_ERROR; cancel_failed:NETWORK_ERROR', identity))
      .toBe('Order lookup failed (NETWORK_ERROR). Cancel request failed (NETWORK_ERROR)');
    expect(describeUnresolvedReason('lookup_failed:INVALID_ORDER_RESPONSE; listed_open_on_gate', identity))
      .toBe('Order lookup failed (INVALID_ORDER_RESPONSE). Still listed among your open orders on Gate');
    expect(describeUnresolvedReason('open_orders_unavailable', identity)).toBe('Could not load your open orders from Gate');
    expect(describeUnresolvedReason('', identity)).toBe('Cancellation not confirmed by Gate');
    expect(describeUnresolvedReason('something_else', identity)).toBe('something_else');
  });
});

describe('UnresolvedOrdersNotice', () => {
  it('lists each blocking order with its identity, quantity, state, and reason', () => {
    const markup = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: identity, setLanguage: vi.fn() }}>
        <UnresolvedOrdersNotice retrying={false} onRetry={vi.fn()} orders={[{
          id: 'order-1', remoteOrderId: 'live-1', clientOrderId: 'gct-1', symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE',
          side: 'BUY', quantity: '0.1', executedQuantity: '0.04', price: '100', state: 'PARTIALLY_FILLED', strategyId: null,
          reason: 'cancel_not_confirmed:PARTIALLY_FILLED',
        }]} />
      </LanguageContext.Provider>,
    );
    expect(markup).toContain('Open orders could not be reconciled');
    expect(markup).toContain('BINANCE_FUTURE_BTC_USDT');
    expect(markup).toContain('live-1');
    expect(markup).toContain('0.04 / 0.1');
    expect(markup).toContain('PARTIALLY_FILLED');
    expect(markup).toContain('Gate still reports this order as PARTIALLY_FILLED');
    expect(markup).toContain('Retry reconciliation');
  });
});
