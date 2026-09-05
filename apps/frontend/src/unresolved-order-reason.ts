/**
 * Translate the backend's quiesce reason tokens (`lookup_failed:<label>`, `cancel_failed:<label>`,
 * `cancel_not_confirmed:<state>`, `listed_open_on_gate`, `open_orders_unavailable`, joined by `;`)
 * into sentences a trader can act on. Unknown tokens are shown verbatim rather than hidden.
 */
export function describeUnresolvedReason(reason: string, t: (key: string) => string): string {
  const tokens = reason.split(';').map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return t('Cancellation not confirmed by Gate');
  return tokens.map((token) => {
    const separator = token.indexOf(':');
    const kind = separator === -1 ? token : token.slice(0, separator);
    const detail = separator === -1 ? '' : token.slice(separator + 1);
    switch (kind) {
      case 'cancel_not_confirmed':
        return detail ? `${t('Gate still reports this order as')} ${detail}` : t('Cancellation not confirmed by Gate');
      case 'lookup_failed':
        if (detail === 'TRADE_ORDER_NOT_FOUND_ERROR') return t('Gate reports no order with this id');
        return `${t('Order lookup failed')}${detail ? ` (${detail})` : ''}`;
      case 'cancel_failed':
        if (detail === 'TRADE_ORDER_NOT_FOUND_ERROR') return t('Gate refused the cancel: no order with this id');
        return `${t('Cancel request failed')}${detail ? ` (${detail})` : ''}`;
      case 'listed_open_on_gate':
        return t('Still listed among your open orders on Gate');
      case 'open_orders_unavailable':
        return t('Could not load your open orders from Gate');
      default:
        return token;
    }
  }).join('. ');
}
