import type { UnresolvedOrder } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';
import { describeUnresolvedReason } from './unresolved-order-reason.js';

interface UnresolvedOrdersNoticeProps {
  orders: UnresolvedOrder[];
  retrying: boolean;
  onRetry: () => void;
}

/** Shown inside the trading-mode dialog when live activation is blocked by unreconciled orders. */
export function UnresolvedOrdersNotice({ orders, retrying, onRetry }: UnresolvedOrdersNoticeProps) {
  const { t } = useLanguage();
  return <section className="recovery-step" role="alert" aria-labelledby="recovery-step-title">
    <p className="eyebrow">{t('Live trading blocked')}</p>
    <h3 id="recovery-step-title">{t('Open orders could not be reconciled')}</h3>
    <p>{t('Before strategies can resume, every locally tracked order must be confirmed cancelled or filled on Gate. These could not be confirmed:')}</p>
    <ul className="recovery-orders">
      {orders.map((order) => <li key={order.id}>
        <div className="recovery-order-head">
          <strong>{order.symbol}</strong>
          <span className={order.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(order.side === 'BUY' ? 'Buy' : 'Sell')}</span>
          <span>{order.executedQuantity !== '0' ? `${order.executedQuantity} / ${order.quantity}` : order.quantity}</span>
          <span className="recovery-order-state">{order.state}</span>
        </div>
        <p className="recovery-order-reason">{describeUnresolvedReason(order.reason, t)}</p>
        <small>{t('Order ID')}: {order.remoteOrderId ?? order.clientOrderId}</small>
      </li>)}
    </ul>
    <div className="recovery-actions">
      <button type="button" className="recovery-retry" disabled={retrying} onClick={onRetry}>
        {retrying ? t('Retrying…') : t('Retry reconciliation')}
      </button>
    </div>
    <small>{t('Retry sends the cancel requests again from this terminal. If Gate keeps reporting an order open after a few retries, wait a minute and retry; read-only mode stays available meanwhile.')}</small>
  </section>;
}
