import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contiguousCandleTail, type UnresolvedOrder } from '@gate-crossex/shared-types';
import {
  api,
  ApiError,
  connectTerminalStream,
  type AuthenticatedPortfolioSnapshot,
  type Candle,
  type CandleInterval,
  type CredentialConnectionStatus,
  type FundingHistoryEntry,
  type FundingOverviewResponse,
  type KlineWatch,
  type LiveBalance,
  type LiveMarket,
  type MarketCatalogAsset,
  type MarketSnapshot,
  type OrderBookSnapshot,
  type PrivateStreamStatus,
  type PublicTrade,
  type StrategyRecord,
  type TerminalStreamHandle,
  type TradingMode,
  type TradingSnapshot,
  type VenueFeeRate,
  unresolvedOrdersFromError,
} from './api.js';
import { parseStoredFavorites } from './local-preferences.js';
import { scopeStrategiesToAccount, strategyBelongsToAccount } from './strategy-accounts.js';
import { DEFAULT_FRONTEND_ROUTE, frontendPath, frontendRoute, type FrontendRoute, type StrategyRouteKind } from './frontend-routes.js';
import { LanguageContext, translate, useLanguage, type Language, type Theme } from './i18n.js';
import type { FundingMetric, PairedPositionPrefill } from './route-shared.js';
import { UnresolvedOrdersNotice } from './trading-mode-recovery.js';
import brandMark from './assets/brand-mark.svg';
import borosMark from './assets/boros-mark.svg';

const TradingView = lazy(() => import('./trade-route.js').then((module) => ({ default: module.TradingView })));
const StrategyView = lazy(() => import('./strategy-route.js').then((module) => ({ default: module.StrategyView })));
const PremiumStrategyView = lazy(() => import('./strategy-route.js').then((module) => ({ default: module.PremiumStrategyView })));
const BorosStrategyView = lazy(() => import('./boros-route.js').then((module) => ({ default: module.BorosStrategyView })));
const FundingDetailView = lazy(() => import('./funding-route.js').then((module) => ({ default: module.FundingDetailView })));
const FundingRatesView = lazy(() => import('./funding-route.js').then((module) => ({ default: module.FundingRatesView })));
const PortfolioView = lazy(() => import('./portfolio-route.js').then((module) => ({ default: module.PortfolioView })));
const FeeComparisonView = lazy(() => import('./fee-comparison-route.js').then((module) => ({ default: module.FeeComparisonView })));
const SOURCE_CODE_URL = 'https://github.com/your-quantguy/gate-crossex';
const LICENSE_URL = `${SOURCE_CODE_URL}/blob/main/LICENSE`;
const RELEASE_VERSION = `v${import.meta.env.VITE_APP_VERSION}`;

type Workspace = 'Trade' | 'Strategy' | 'Funding Rates' | 'Portfolio' | 'Trading Fees';
type NavigationLabel = Workspace | 'Boros by Pendle';
type StrategyKind = StrategyRouteKind;
/** Matches the backend's market-catalog freshness window; switches inside it reuse client state. */
const CATALOG_CLIENT_REFRESH_MS = 5 * 60_000;
type FundingHistoryDuration = 1 | 7 | 30;
type FundingHistoryCache = Record<FundingHistoryDuration, Record<string, FundingHistoryEntry>>;

const navItems: { label: NavigationLabel; glyph: string }[] = [
  { label: 'Trade', glyph: '⌁' },
  { label: 'Strategy', glyph: '⇄' },
  { label: 'Funding Rates', glyph: '%' },
  { label: 'Boros by Pendle', glyph: '◐' },
];

function TopbarNavigationContent({ label, glyph, iconSrc }: { label: string; glyph: string; iconSrc?: string }) {
  const { t } = useLanguage();
  return <>{iconSrc
    ? <span className="nav-boros-mark" aria-hidden="true"><img src={iconSrc} alt="" /></span>
    : <span className="topbar-nav-glyph" aria-hidden="true">{glyph}</span>}{t(label)}</>;
}

const strategyPages: Array<{ kind: StrategyKind; glyph: string; label: string; detail: string }> = [
  { kind: 'position', glyph: '◎', label: 'Cross-exchange hedge', detail: 'Execute a fixed two-venue position, then stop' },
  { kind: 'premium', glyph: '≒', label: 'SK hynix premium bot', detail: 'Trade the SK hynix ADR premium vs the Korean listing' },
];

const DIALOG_FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function openCredentialWindow(path: string): void {
  window.open(
    path,
    '_blank',
    'popup=yes,noopener,noreferrer,width=720,height=820,resizable=yes,scrollbars=yes',
  );
}

function useDialogFocus(open: boolean, onClose?: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const initialFocus = dialog.querySelector<HTMLElement>('[data-dialog-autofocus]')
      ?? dialog.querySelector<HTMLElement>(DIALOG_FOCUSABLE)
      ?? dialog;
    initialFocus.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)]
        .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  return dialogRef;
}

type AccountAction = { profileId: string; kind: 'switch' | 'delete' } | null;
type PendingAccountSwitch = { profileId: string; strategies: StrategyRecord[] } | null;

function accountStorageLabel(
  storage: CredentialConnectionStatus['storage'],
  t: (key: string) => string,
): string {
  if (storage === 'os_keychain') return t('OS keychain');
  if (storage === 'env_file') return t('Local .env file');
  return storage;
}

function AccountManagerDialog({
  open,
  connection,
  language,
  action,
  pendingSwitch,
  deleteConfirmationId,
  error,
  editingAccountName,
  accountNameDraft,
  accountRenameSaving,
  accountRenameError,
  onClose,
  onSwitch,
  onCancelSwitch,
  onConfirmSwitch,
  onRequestDelete,
  onCancelDelete,
  onDelete,
  onBeginRename,
  onAccountNameChange,
  onCancelRename,
  onRename,
  onAdd,
}: {
  open: boolean;
  connection: CredentialConnectionStatus | null;
  language: Language;
  action: AccountAction;
  pendingSwitch: PendingAccountSwitch;
  deleteConfirmationId: string | null;
  error: string | null;
  editingAccountName: boolean;
  accountNameDraft: string;
  accountRenameSaving: boolean;
  accountRenameError: string | null;
  onClose: () => void;
  onSwitch: (profileId: string) => void;
  onCancelSwitch: () => void;
  onConfirmSwitch: (profileId: string) => void;
  onRequestDelete: (profileId: string) => void;
  onCancelDelete: () => void;
  onDelete: (profileId: string) => void;
  onBeginRename: () => void;
  onAccountNameChange: (label: string) => void;
  onCancelRename: () => void;
  onRename: () => void;
  onAdd: () => void;
}) {
  const { t } = useLanguage();
  const dialogRef = useDialogFocus(open, onClose);
  if (!open) return null;
  const sourceAccount = connection?.profiles.find((profile) => profile.active) ?? null;
  const targetAccount = pendingSwitch
    ? connection?.profiles.find((profile) => profile.id === pendingSwitch.profileId) ?? null
    : null;
  const switchBusy = pendingSwitch !== null
    && action?.kind === 'switch'
    && action.profileId === pendingSwitch.profileId;

  return <div className="modal-backdrop account-manager-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialogRef} className="account-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="account-manager-title" tabIndex={-1}>
      <header>
        <div><p>{t(pendingSwitch ? 'Action required' : 'Account settings')}</p><h2 id="account-manager-title">{t(pendingSwitch ? 'Pause strategies and switch account?' : 'Manage and switch accounts')}</h2></div>
        <button className="account-manager-close" onClick={pendingSwitch ? onCancelSwitch : onClose} disabled={switchBusy || accountRenameSaving} aria-label={t('Close')}>×</button>
      </header>
      {pendingSwitch ? <>
        <div className="account-switch-warning">
          <span className="account-switch-warning-icon" aria-hidden="true">!</span>
          <div>
            <strong>{t('Running strategies are attached to the current account.')}</strong>
            <p>{t('To switch accounts safely, the strategies below will be paused and live trading will be locked. You can review them before enabling trading again.')}</p>
          </div>
        </div>
        <div className="account-switch-route" aria-label={t('Account switch')}>
          <span><small>{t('Current account')}</small><strong>{sourceAccount?.label ?? '—'}</strong></span>
          <b aria-hidden="true">→</b>
          <span><small>{t('Switch to')}</small><strong>{targetAccount?.label ?? '—'}</strong></span>
        </div>
        <section className="account-switch-strategies" aria-labelledby="affected-strategies-title">
          <h3 id="affected-strategies-title">{t('Strategies that will be paused')} <span>{pendingSwitch.strategies.length || '—'}</span></h3>
          {pendingSwitch.strategies.length > 0 ? pendingSwitch.strategies.map((strategy) => <div key={strategy.id}>
            <span><strong>{strategy.id}</strong><small>{strategy.config.asset} · {t(strategy.kind === 'auto' ? 'Price-difference bot' : strategy.kind === 'premium' ? 'SK hynix premium bot' : 'Cross-exchange hedge')}</small></span>
            <em>{t('Running')}</em>
          </div>) : <p>{t('The backend detected a newly running strategy. Confirm to pause all affected strategies before switching.')}</p>}
        </section>
        {error && <p className="account-manager-error" role="alert">{t(error)}</p>}
        <footer className="account-switch-footer">
          <button onClick={onCancelSwitch} disabled={switchBusy}>{t('Keep current account')}</button>
          <button className="confirm-account-switch" data-dialog-autofocus onClick={() => onConfirmSwitch(pendingSwitch.profileId)} disabled={switchBusy}>
            {switchBusy ? t('Pausing and switching…') : t('Pause strategies and switch')}
          </button>
        </footer>
      </> : <>
      <p className="account-manager-intro">{t('Switching the active account locks live trading until you enable it again.')}</p>
      {error && <p className="account-manager-error" role="alert">{t(error)}</p>}
      <div className="account-manager-list" aria-label={t('Available accounts')}>
        {(connection?.profiles ?? []).map((profile) => {
          const deleting = deleteConfirmationId === profile.id;
          const renaming = profile.active && editingAccountName;
          const busy = action?.profileId === profile.id;
          const verified = profile.lastVerifiedAt
            ? `${t('Verified')} ${new Date(profile.lastVerifiedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}`
            : t('Never verified');
          return <article className={`account-manager-row${profile.active ? ' active' : ''}${deleting ? ' deleting' : ''}`} key={profile.id}>
            <div className="account-manager-avatar" aria-hidden="true">{profile.label.trim().charAt(0).toUpperCase() || 'G'}</div>
            {renaming ? <form className="account-manager-rename-form" onSubmit={(event) => {
              event.preventDefault();
              onRename();
            }}>
              <input
                autoFocus
                value={accountNameDraft}
                maxLength={80}
                onChange={(event) => onAccountNameChange(event.target.value)}
                disabled={accountRenameSaving}
                aria-label={t('Account name')}
              />
              <div>
                <button type="button" onClick={onCancelRename} disabled={accountRenameSaving}>{t('Cancel edit')}</button>
                <button type="submit" className="primary" disabled={accountRenameSaving || !accountNameDraft.trim()}>{t(accountRenameSaving ? 'Saving…' : 'Save')}</button>
              </div>
              {accountRenameError && <small role="alert">{t(accountRenameError)}</small>}
            </form> : <><div className="account-manager-identity">
              <strong>{profile.label}</strong>
              <small>{accountStorageLabel(profile.storage, t)} · {verified}</small>
            </div>
            {deleting ? <div className="account-delete-confirmation">
              <strong>{t('Delete this account?')}</strong>
              <small>{t('This removes its saved API credentials from this device.')}</small>
              <span>
                <button onClick={onCancelDelete} disabled={busy}>{t('Keep account')}</button>
                <button className="danger" onClick={() => onDelete(profile.id)} disabled={busy}>
                  {busy ? t('Deleting…') : t('Delete account')}
                </button>
              </span>
            </div> : <div className="account-manager-actions">
              {profile.active
                ? <span className="account-active-pill">● {t('Active')}</span>
                : <button onClick={() => onSwitch(profile.id)} disabled={action !== null || editingAccountName}>
                  {busy && action?.kind === 'switch' ? t('Switching…') : t('Switch')}
                </button>}
              {profile.active && <button className="account-rename-button" onClick={onBeginRename} disabled={action !== null}>{t('Edit account name')}</button>}
              <button className="account-delete-button" onClick={() => onRequestDelete(profile.id)} disabled={action !== null || editingAccountName} aria-label={`${t('Delete account')}: ${profile.label}`} title={t('Delete account')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" /></svg>
              </button>
            </div>}</>}
          </article>;
        })}
        {connection && connection.profiles.length === 0 && <div className="account-manager-empty">
          <strong>{t('No accounts saved yet.')}</strong>
          <small>{t('Add an account to connect Gate CrossEx.')}</small>
        </div>}
      </div>
      <footer>
        <button className="add-account-button" data-dialog-autofocus onClick={onAdd} disabled={editingAccountName || accountRenameSaving}>+ {t('Add a new account')}</button>
      </footer>
      </>}
    </section>
  </div>;
}

function symbolParts(symbol: string) {
  const parts = symbol.split('_');
  return { venue: parts[0] ?? '', asset: parts[2] ?? symbol, quote: parts[3] ?? 'USDT' };
}

/** Isolated so the once-per-second tick re-renders only this span, never the whole app shell. */
function UtcClock() {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>UTC {clock}</span>;
}

function fallbackCatalogFromSnapshot(snapshot: MarketSnapshot | null): MarketCatalogAsset[] | null {
  if (!snapshot) return null;
  const byAsset = new Map<string, MarketCatalogAsset>();
  for (const market of snapshot.markets) {
    const entry = byAsset.get(market.asset) ?? {
      asset: market.asset,
      streamed: false,
      venues: [],
    };
    entry.streamed ||= market.source === 'gate_crossex_websocket';
    if (!entry.venues.some((venue) => venue.venue === market.venue)) {
      entry.venues.push({
        venue: market.venue,
        symbol: market.symbol,
        quote: market.symbol.split('_').at(-1) ?? 'USDT',
      });
    }
    byAsset.set(market.asset, entry);
  }
  return [...byAsset.values()].sort((left, right) => left.asset.localeCompare(right.asset));
}

interface TradingModeGateProps {
  mode: TradingMode;
  onApplied: (mode: TradingMode) => void;
  credentialEntryPath: CredentialConnectionStatus['secureEntryPath'];
  onCredentialStatus: (status: CredentialConnectionStatus) => void;
  /** null renders the forced startup gate: no close affordance until a mode is chosen. */
  onClose: (() => void) | null;
}

function TradingModeGate({ mode, onApplied, credentialEntryPath, onCredentialStatus, onClose }: TradingModeGateProps) {
  const { language, setLanguage, t } = useLanguage();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState<'readonly' | 'live' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unresolvedOrders, setUnresolvedOrders] = useState<UnresolvedOrder[]>([]);
  const [needsCredentials, setNeedsCredentials] = useState(false);
  const [checkingCredentials, setCheckingCredentials] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const forced = onClose === null;
  const dialogRef = useDialogFocus(true, onClose ?? undefined);
  const credentialSetupButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (needsCredentials) credentialSetupButtonRef.current?.focus();
  }, [needsCredentials]);

  async function choose(next: 'readonly' | 'live') {
    if (submitting) return;
    setSubmitting(next);
    setError(null);
    try {
      const response = await api.setTradingMode(next, agreed);
      setNeedsCredentials(false);
      setUnresolvedOrders([]);
      onApplied(response.mode);
      onClose?.();
    } catch (cause) {
      // Orders that could not be proven cancelled get their own panel with per-order reasons; a
      // bare "mode change failed" line would leave the user guessing what to fix.
      const blocking = unresolvedOrdersFromError(cause);
      setUnresolvedOrders(blocking);
      if (cause instanceof ApiError && cause.code === 'credential_not_configured') {
        setNeedsCredentials(true);
        setCredentialError(null);
      } else if (blocking.length === 0) {
        setError(cause instanceof ApiError ? cause.message : t('Backend unavailable'));
      }
    } finally {
      setSubmitting(null);
    }
  }

  function openCredentialSetup() {
    const separator = credentialEntryPath.includes('?') ? '&' : '?';
    openCredentialWindow(`${credentialEntryPath}${separator}intent=live-trading&lang=${language}`);
  }

  async function finishCredentialSetup() {
    if (checkingCredentials || submitting) return;
    setCheckingCredentials(true);
    setCredentialError(null);
    setError(null);
    try {
      const status = await api.connection();
      onCredentialStatus(status);
      if (!status.configured) {
        setCredentialError(t('Credentials are still not configured. Complete secure setup, then try again.'));
        return;
      }
      await choose('live');
    } catch (cause) {
      setCredentialError(cause instanceof ApiError ? cause.message : t('Backend unavailable'));
    } finally {
      setCheckingCredentials(false);
    }
  }

  return <div className="modal-backdrop disclaimer-backdrop" role="presentation" onMouseDown={() => onClose?.()}>
    <section ref={dialogRef} tabIndex={-1} className="disclaimer-modal" role="dialog" aria-modal="true" aria-labelledby="risk-disclaimer-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><p className="eyebrow">{t('Trading mode')}</p><h2 id="risk-disclaimer-title">{t('Risk disclaimer')}</h2></div>
        <div className="disclaimer-header-actions">
          <div className="disclaimer-lang" role="group" aria-label={t('Language')}>
            <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')} aria-pressed={language === 'en'}>EN</button>
            <button className={language === 'zh' ? 'active' : ''} onClick={() => setLanguage('zh')} aria-pressed={language === 'zh'}>中文</button>
          </div>
          {!forced && <button className="disclaimer-close" aria-label={t('Close')} onClick={() => onClose?.()}>×</button>}
        </div>
      </header>
      <p className="disclaimer-lead">{t('Before using this terminal, please read and accept the following:')}</p>
      <ul className="disclaimer-points">
        <li>{t('This is open-source software provided “as is”, without warranty of any kind. The authors and contributors are not liable for any losses arising from its use.')}</li>
        <li>{t('When live trading is enabled, this terminal places real orders on your live exchange account. Software bugs, network failures, or exchange behavior can cause unexpected orders, positions, or losses.')}</li>
        <li>{t('Enabling live trading re-activates running strategies attached to the current account.')}</li>
        <li>{t('Trading derivatives involves substantial risk of loss. You alone are responsible for all activity on your API keys and for compliance with local regulations. Nothing in this application is investment advice.')}</li>
      </ul>
      <label className="disclaimer-agree">
        <input data-dialog-autofocus type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>{t('I have read and understand the risks above.')}</span>
      </label>
      <div className="disclaimer-actions">
        {/* Leaving 'unset' always needs the acknowledgement; dropping live → readonly never does. */}
        <button className="mode-choice readonly" disabled={submitting !== null || mode === 'readonly' || (mode === 'unset' && !agreed)} onClick={() => void choose('readonly')}>
          <strong>{submitting === 'readonly' ? t('Applying…') : t('Continue in read-only mode')}</strong>
          <span>{t('Market data and account reads only; order entry stays locked.')}</span>
        </button>
        <button className="mode-choice live" disabled={submitting !== null || mode === 'live' || !agreed || needsCredentials} onClick={() => void choose('live')}>
          <strong>{submitting === 'live' ? t('Applying…') : t('Enable live trading')}</strong>
          <span>{t('Real orders will be placed on your live account.')}</span>
        </button>
      </div>
      {needsCredentials && <section className="credential-setup-step" aria-live="polite" aria-labelledby="credential-setup-title">
        <p className="eyebrow">{t('Credentials required')}</p>
        <h3 id="credential-setup-title">{t('Add your Gate API credentials')}</h3>
        <p>{t('Live trading needs a Gate APIv4 key with CrossEx read and trade permissions. Store it in your OS keychain or the protected local .env file.')}</p>
        <div className="credential-setup-actions">
          <button ref={credentialSetupButtonRef} className="credential-setup-open" onClick={openCredentialSetup}>{t('Open secure credential setup')}<span aria-hidden="true">↗</span></button>
          <button className="credential-setup-finish" disabled={checkingCredentials} onClick={() => void finishCredentialSetup()}>
            {checkingCredentials ? t('Checking credentials…') : t("I've saved credentials — enable live trading")}
          </button>
        </div>
        {credentialError && <p className="credential-setup-error" role="alert">{credentialError}</p>}
        <small>{t('Your API key and secret stay on the local backend and are never stored by this interface.')}</small>
      </section>}
      {unresolvedOrders.length > 0 && <UnresolvedOrdersNotice orders={unresolvedOrders} retrying={submitting === 'live'} onRetry={() => void choose('live')} />}
      {error && <p className="disclaimer-error" role="alert">{t('Mode change failed')}: {error}</p>}
      <p className="disclaimer-note">{t('Your choice applies to this backend session only; restarting the backend locks trading again.')}</p>
    </section>
  </div>;
}

function App() {
  const [language, setLanguage] = useState<Language>(() => window.localStorage.getItem('crossex-language') === 'zh' ? 'zh' : 'en');
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem('crossex-theme') === 'light' ? 'light' : 'dark');
  const [route, setRoute] = useState<FrontendRoute>(() => frontendRoute(window.location.pathname) ?? DEFAULT_FRONTEND_ROUTE);
  const workspace: Workspace = route.workspace;
  const fundingDetailAsset = route.workspace === 'Funding Rates' ? route.asset : null;
  const strategyKind: StrategyKind = route.workspace === 'Strategy' ? route.strategyKind : 'position';
  const workspaceRef = useRef<Workspace>(workspace);
  workspaceRef.current = workspace;
  // Open state doubles as the menu's fixed-position anchor, measured from the trigger. The topbar
  // is the menu's containing block (backdrop-filter) and spans the viewport from (0,0), so trigger
  // viewport coordinates apply as-is; fixed positioning also escapes the nav's overflow clipping.
  const [strategyMenuAt, setStrategyMenuAt] = useState<{ top: number; left: number } | null>(null);
  const [moreMenuAt, setMoreMenuAt] = useState<{ top: number; left: number } | null>(null);
  const strategyNavRef = useRef<HTMLDivElement | null>(null);
  const strategyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const strategyMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moreNavRef = useRef<HTMLDivElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [selectedAsset, setSelectedAsset] = useState('BTC');
  const [fundingMetric, setFundingMetric] = useState<FundingMetric>('Per interval');
  const [fundingOverview, setFundingOverview] = useState<FundingOverviewResponse | null>(null);
  const [fundingHistoryCache, setFundingHistoryCache] = useState<FundingHistoryCache>(() => ({ 1: {}, 7: {}, 30: {} }));
  const [positionPrefill, setPositionPrefill] = useState<PairedPositionPrefill | null>(null);
  const [catalog, setCatalog] = useState<MarketCatalogAsset[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsSeenAt, setNotificationsSeenAt] = useState(() => window.localStorage.getItem('crossex-notifications-seen') ?? new Date(0).toISOString());
  const [favorites, setFavorites] = useState<string[]>(() => parseStoredFavorites(window.localStorage.getItem('crossex-favorites')));
  const [confirmOrders, setConfirmOrders] = useState(() => window.localStorage.getItem('crossex-confirm-orders') !== 'off');
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const [tradingSnapshot, setTradingSnapshot] = useState<TradingSnapshot | null>(null);
  const [authenticatedPortfolio, setAuthenticatedPortfolio] = useState<AuthenticatedPortfolioSnapshot | null>(null);
  const [accountStream, setAccountStream] = useState<PrivateStreamStatus | null>(null);
  const [strategies, setStrategies] = useState<StrategyRecord[]>([]);
  const [balances, setBalances] = useState<Record<string, LiveBalance>>({});
  const [fees, setFees] = useState<VenueFeeRate[]>([]);
  const [feesReady, setFeesReady] = useState(false);
  const [feesError, setFeesError] = useState<string | null>(null);
  const [tradingMode, setTradingMode] = useState<TradingMode | null>(null);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [connection, setConnection] = useState<CredentialConnectionStatus | null>(null);
  const [editingAccountName, setEditingAccountName] = useState(false);
  const [accountNameDraft, setAccountNameDraft] = useState('');
  const [accountRenameSaving, setAccountRenameSaving] = useState(false);
  const [accountRenameError, setAccountRenameError] = useState<string | null>(null);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [accountAction, setAccountAction] = useState<AccountAction>(null);
  const [pendingAccountSwitch, setPendingAccountSwitch] = useState<PendingAccountSwitch>(null);
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const [accountManagerError, setAccountManagerError] = useState<string | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBookSnapshot | null>(null);
  const [publicTrades, setPublicTrades] = useState<{ symbol: string; trades: PublicTrade[] }>({ symbol: '', trades: [] });
  const [candleSeries, setCandleSeries] = useState<Record<string, Candle[]>>({});
  const [candleBackfilling, setCandleBackfilling] = useState<Record<string, boolean>>({});
  const [streamState, setStreamState] = useState<'connected' | 'reconnecting'>('reconnecting');
  const [backendUnavailableSince, setBackendUnavailableSince] = useState<number | null>(null);
  const [showBackendOffline, setShowBackendOffline] = useState(false);
  const streamRef = useRef<TerminalStreamHandle | null>(null);
  const pendingWatchRef = useRef<{ symbol: string; interval: CandleInterval } | null>(null);
  const pendingQuoteSymbolsRef = useRef<string[]>([]);
  const pendingKlineWatchesRef = useRef<KlineWatch[]>([]);
  const marketBufferRef = useRef<Map<string, LiveMarket>>(new Map());
  const lastMarketFlushAtRef = useRef(0);
  const tradeBufferRef = useRef<{ symbol: string; trades: PublicTrade[] } | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const notificationsRef = useRef<HTMLDivElement | null>(null);
  // localStorage paints the last-known settings instantly; the backend row is the durable copy.
  // Until the boot fetch lands, the persistence effects must not push this browser's cached
  // values back over the server's, so writes stay disabled until then.
  const preferencesReadyRef = useRef(false);
  const catalogFetchedAtRef = useRef(0);
  const feesLoadedRef = useRef(false);
  const feeRequestGenerationRef = useRef(0);
  const feeProfileRef = useRef<string | null | undefined>(undefined);
  const tradingSnapshotRef = useRef<TradingSnapshot | null>(null);
  tradingSnapshotRef.current = tradingSnapshot;
  const t = useMemo(() => (key: string) => translate(language, key), [language]);
  const markBackendUnavailable = useCallback(() => {
    setBackendUnavailableSince((current) => current ?? Date.now());
  }, []);
  const reportBackendConnectivityError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.code === 'backend_unavailable') {
      markBackendUnavailable();
    }
  }, [markBackendUnavailable]);
  const refreshConnection = useCallback(async () => {
    const next = await api.connection();
    setConnection(next);
    return next;
  }, []);

  useEffect(() => {
    if (backendUnavailableSince === null) {
      setShowBackendOffline(false);
      return;
    }
    const remaining = Math.max(0, 5_000 - (Date.now() - backendUnavailableSince));
    const timer = window.setTimeout(() => setShowBackendOffline(true), remaining);
    return () => window.clearTimeout(timer);
  }, [backendUnavailableSince]);

  const navigate = useCallback((nextRoute: FrontendRoute) => {
    const path = frontendPath(nextRoute);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    // Canonicalize a trailing slash and recover unknown frontend URLs to the landing page.
    const initialRoute = frontendRoute(window.location.pathname) ?? DEFAULT_FRONTEND_ROUTE;
    const initialPath = frontendPath(initialRoute);
    if (window.location.pathname !== initialPath) window.history.replaceState(null, '', initialPath);
    const onPopState = () => setRoute(frontendRoute(window.location.pathname) ?? DEFAULT_FRONTEND_ROUTE);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    void api.preferences().then(({ preferences }) => {
      if (preferences.language) setLanguage(preferences.language);
      if (preferences.theme) setTheme(preferences.theme);
      if (preferences.favorites) setFavorites(preferences.favorites);
      if (preferences.lastAsset) setSelectedAsset(preferences.lastAsset);
      if (preferences.confirmOrders !== undefined) setConfirmOrders(preferences.confirmOrders);
      const seenAt = preferences.notificationsSeenAt;
      if (seenAt) setNotificationsSeenAt((current) => seenAt > current ? seenAt : current);
    }).catch(() => undefined).finally(() => { preferencesReadyRef.current = true; });
  }, []);

  const selectAsset = useCallback((asset: string) => {
    setSelectedAsset(asset);
    if (preferencesReadyRef.current) void api.savePreferences({ lastAsset: asset }).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem('crossex-theme', theme);
    if (preferencesReadyRef.current) void api.savePreferences({ theme }).catch(() => undefined);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    window.localStorage.setItem('crossex-language', language);
    if (preferencesReadyRef.current) void api.savePreferences({ language }).catch(() => undefined);
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem('crossex-favorites', JSON.stringify(favorites));
    if (preferencesReadyRef.current) void api.savePreferences({ favorites }).catch(() => undefined);
  }, [favorites]);

  useEffect(() => {
    window.localStorage.setItem('crossex-notifications-seen', notificationsSeenAt);
    if (preferencesReadyRef.current) void api.savePreferences({ notificationsSeenAt }).catch(() => undefined);
  }, [notificationsSeenAt]);

  useEffect(() => {
    window.localStorage.setItem('crossex-confirm-orders', confirmOrders ? 'on' : 'off');
    if (preferencesReadyRef.current) void api.savePreferences({ confirmOrders }).catch(() => undefined);
  }, [confirmOrders]);

  const toggleFavorite = useCallback((symbol: string) => {
    setFavorites((current) => current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]);
  }, []);

  const refreshTrading = useCallback(async () => {
    const snapshot = await api.tradingSnapshot();
    setTradingSnapshot(snapshot);
    setBalances((current) => {
      const next = { ...current };
      for (const balance of snapshot.balances) next[`${balance.venue}:${balance.coin}`] = balance;
      return next;
    });
  }, []);
  const refreshPositions = useCallback(async () => {
    setTradingSnapshot(await api.positionsSnapshot());
  }, []);
  async function refreshAuthenticatedPortfolio() {
    const next = await api.portfolioSnapshot();
    setAuthenticatedPortfolio(next);
    if (next.live?.stream) setAccountStream(next.live.stream);
  }
  const refreshStrategies = useCallback(async () => {
    setStrategies((await api.strategies()).strategies);
  }, []);
  const refreshFees = useCallback(() => {
    const requestGeneration = ++feeRequestGenerationRef.current;
    setFeesReady(false);
    setFeesError(null);
    void api.fees()
      .then((response) => {
        if (requestGeneration !== feeRequestGenerationRef.current) return;
        feesLoadedRef.current = true;
        setFees(response.fees);
      })
      .catch((error: unknown) => {
        if (requestGeneration !== feeRequestGenerationRef.current) return;
        setFeesError(error instanceof ApiError ? error.code : 'fee_rates_unavailable');
        reportBackendConnectivityError(error);
      })
      .finally(() => {
        if (requestGeneration === feeRequestGenerationRef.current) setFeesReady(true);
      });
  }, [reportBackendConnectivityError]);

  const watchMarket = useCallback((symbol: string, interval: CandleInterval) => {
    // The trade view can request a watch before the stream handle exists; remember it for the
    // connect effect to flush.
    pendingQuoteSymbolsRef.current = [symbol];
    pendingWatchRef.current = { symbol, interval };
    streamRef.current?.watchQuotes([symbol]);
    streamRef.current?.watchMarket(symbol, interval);
  }, []);

  const watchQuotes = useCallback((symbols: string[]) => {
    pendingQuoteSymbolsRef.current = symbols;
    streamRef.current?.watchQuotes(symbols);
  }, []);

  const watchKlines = useCallback((watches: KlineWatch[]) => {
    pendingKlineWatchesRef.current = watches;
    streamRef.current?.watchKlines(watches);
  }, []);

  useEffect(() => {
    if (workspace !== 'Strategy') {
      pendingKlineWatchesRef.current = [];
      streamRef.current?.watchKlines([]);
    }
    if (workspace === 'Trade') return;
    pendingWatchRef.current = null;
    streamRef.current?.clearWatch();
    setOrderBook(null);
    tradeBufferRef.current = null;
    setPublicTrades({ symbol: '', trades: [] });
    if (workspace !== 'Strategy') {
      pendingQuoteSymbolsRef.current = [];
      streamRef.current?.watchQuotes([]);
    }
  }, [workspace]);

  const seedCandles = useCallback((key: string, incoming: Candle[], building: boolean, replace = false) => {
    const interval = key.slice(key.lastIndexOf(':') + 1) as CandleInterval;
    setCandleBackfilling((current) => ({ ...current, [key]: building }));
    setCandleSeries((current) => {
      const merged = new Map<number, Candle>();
      for (const candle of incoming) merged.set(candle.startTime, candle);
      const newestIncoming = incoming.reduce((newest, candle) => Math.max(newest, candle.startTime), -1);
      for (const candle of current[key] ?? []) {
        if (!replace || incoming.length === 0 || candle.startTime >= newestIncoming) {
          merged.set(candle.startTime, candle);
        }
      }
      return { ...current, [key]: contiguousCandleTail([...merged.values()], interval) };
    });
  }, []);

  useEffect(() => {
    void api.tradingMode().then((response) => setTradingMode(response.mode)).catch(reportBackendConnectivityError);
  }, [reportBackendConnectivityError]);

  useEffect(() => {
    if (workspace === 'Funding Rates') return;
    // The terminal stream keeps the trading snapshot and strategy list current while connected,
    // and the catalog/fee payloads move on multi-minute backend cadences, so workspace switches
    // refetch only what is missing or stale instead of re-requesting everything per navigation.
    if (workspace === 'Trade' || workspace === 'Strategy' || workspace === 'Trading Fees') {
      if (Date.now() - catalogFetchedAtRef.current > CATALOG_CLIENT_REFRESH_MS) {
        void api.marketCatalog().then((response) => {
          catalogFetchedAtRef.current = Date.now();
          setCatalog(response.assets);
        }).catch(reportBackendConnectivityError);
      }
      if (!feesLoadedRef.current) refreshFees();
    }
    if (tradingSnapshotRef.current === null) void refreshTrading().catch(reportBackendConnectivityError);
  }, [workspace, refreshTrading, refreshFees, reportBackendConnectivityError]);

  const terminalStreamEnabled = workspace !== 'Funding Rates';
  useEffect(() => {
    if (!terminalStreamEnabled) return;
    const handle = connectTerminalStream((message) => {
      if (message.type === 'market.snapshot') setMarketSnapshot((current) => {
        if (!current) return message.payload;
        const markets = new Map(current.markets.map((market) => [market.symbol, market]));
        for (const market of message.payload.markets) markets.set(market.symbol, market);
        return { ...message.payload, markets: [...markets.values()] };
      });
      if (message.type === 'market.status') setMarketSnapshot((current) => current
        ? { ...current, connectionState: message.payload.connectionState }
        : { connectionState: message.payload.connectionState, updatedAt: message.payload.checkedAt, markets: [] });
      // Scoped market and trade pushes can still arrive many times per second, so they are buffered
      // and flushed on an interval instead of re-rendering per tick.
      if (message.type === 'market.update') marketBufferRef.current.set(message.payload.symbol, message.payload);
      if (message.type === 'market.batch') {
        for (const market of message.payload.markets) marketBufferRef.current.set(market.symbol, market);
      }
      if (message.type === 'execution.snapshot') {
        setTradingSnapshot(message.payload);
        setBalances(Object.fromEntries(
          (message.payload.balances ?? []).map((balance) => [`${balance.venue}:${balance.coin}`, balance]),
        ));
      }
      if (message.type === 'execution.update') setTradingSnapshot((current) => {
        if (!current) return current;
        const exists = current.orders.some((order) => order.id === message.payload.id);
        return {
          ...current,
          orders: exists
            ? current.orders.map((order) => order.id === message.payload.id ? message.payload : order)
            : [message.payload, ...current.orders],
        };
      });
      if (message.type === 'portfolio.snapshot') {
        setAuthenticatedPortfolio(message.payload);
        setAccountStream(message.payload.live?.stream ?? null);
      }
      if (message.type === 'portfolio.cleared') {
        setAuthenticatedPortfolio(null);
        setBalances({});
      }
      if (message.type === 'private-stream.status') setAccountStream(message.payload);
      if (message.type === 'strategy.snapshot') setStrategies(message.payload.strategies);
      if (message.type === 'strategy.update') setStrategies((current) => {
        const exists = current.some((strategy) => strategy.id === message.payload.id);
        return exists ? current.map((strategy) => strategy.id === message.payload.id ? message.payload : strategy) : [message.payload, ...current];
      });
      if (message.type === 'balance.update') setBalances((current) => ({ ...current, [`${message.payload.venue}:${message.payload.coin}`]: message.payload }));
      if (message.type === 'mode.update') setTradingMode(message.payload.mode);
      // Book and trade state hold a single symbol, so accept only the market this client watches:
      // the stream can carry other symbols (an in-flight message after a market switch, or an
      // older backend relaying every client's watch) and each would blank the panel.
      const watchedSymbol = pendingWatchRef.current?.symbol;
      if (message.type === 'orderbook.update' && message.payload.symbol === watchedSymbol) setOrderBook(message.payload);
      if (message.type === 'trade.snapshot' && message.payload.symbol === watchedSymbol) {
        tradeBufferRef.current = { symbol: message.payload.symbol, trades: message.payload.trades };
        setPublicTrades(tradeBufferRef.current);
      }
      if (message.type === 'trade.update' && message.payload.symbol === watchedSymbol) {
        const buffer = tradeBufferRef.current;
        tradeBufferRef.current = buffer && buffer.symbol === message.payload.symbol
          ? { symbol: buffer.symbol, trades: [message.payload.trade, ...buffer.trades].slice(0, 80) }
          : { symbol: message.payload.symbol, trades: [message.payload.trade] };
      }
      if (message.type === 'trade.batch' && message.payload.symbol === watchedSymbol) {
        const buffer = tradeBufferRef.current;
        const existing = buffer?.symbol === message.payload.symbol ? buffer.trades : [];
        const seen = new Set<string>();
        const trades = [...message.payload.trades].reverse().concat(existing).filter((trade) => {
          if (seen.has(trade.id)) return false;
          seen.add(trade.id);
          return true;
        }).slice(0, 80);
        tradeBufferRef.current = { symbol: message.payload.symbol, trades };
      }
      const watchedInterval = pendingWatchRef.current?.interval;
      const isAdditionalKlineWatch = (symbol: string, interval: CandleInterval) =>
        pendingKlineWatchesRef.current.some((watch) => watch.symbol === symbol && watch.interval === interval);
      if (message.type === 'kline.snapshot'
        && ((message.payload.symbol === watchedSymbol && message.payload.interval === watchedInterval)
          || isAdditionalKlineWatch(message.payload.symbol, message.payload.interval))) {
        const key = `${message.payload.symbol}:${message.payload.interval}`;
        setCandleSeries((current) => ({
          ...current,
          [key]: contiguousCandleTail(message.payload.candles, message.payload.interval),
        }));
      }
      if (message.type === 'kline.update'
        && ((message.payload.symbol === watchedSymbol && message.payload.interval === watchedInterval)
          || isAdditionalKlineWatch(message.payload.symbol, message.payload.interval))) {
        const key = `${message.payload.symbol}:${message.payload.interval}`;
        const candle = message.payload.candle;
        setCandleSeries((current) => {
          const series = current[key] ?? [];
          const index = series.findIndex((existing) => existing.startTime === candle.startTime);
          const next = index >= 0 ? series.map((existing, position) => position === index ? candle : existing) : [...series, candle].sort((a, b) => a.startTime - b.startTime);
          return { ...current, [key]: contiguousCandleTail(next, message.payload.interval) };
        });
      }
    }, (state) => {
      setStreamState(state);
      if (state === 'connected') {
        setBackendUnavailableSince(null);
        setShowBackendOffline(false);
      } else {
        markBackendUnavailable();
      }
    });
    streamRef.current = handle;
    handle.watchQuotes(pendingQuoteSymbolsRef.current);
    handle.watchKlines(pendingKlineWatchesRef.current);
    if (pendingWatchRef.current) handle.watchMarket(pendingWatchRef.current.symbol, pendingWatchRef.current.interval);
    const flushTimer = window.setInterval(() => {
      const buffered = marketBufferRef.current;
      const now = Date.now();
      const marketFlushInterval = workspaceRef.current === 'Trade' || workspaceRef.current === 'Strategy' ? 300 : 2_000;
      if (buffered.size > 0 && now - lastMarketFlushAtRef.current >= marketFlushInterval) {
        lastMarketFlushAtRef.current = now;
        marketBufferRef.current = new Map();
        const updates = [...buffered.values()];
        setMarketSnapshot((current) => {
          if (!current) return { connectionState: 'healthy', updatedAt: updates[updates.length - 1].updatedAt, markets: updates };
          const bySymbol = new Map(current.markets.map((market) => [market.symbol, market]));
          for (const update of updates) bySymbol.set(update.symbol, update);
          return { connectionState: 'healthy', updatedAt: updates[updates.length - 1].updatedAt, markets: [...bySymbol.values()] };
        });
      }
      const bufferedTrades = tradeBufferRef.current;
      if (bufferedTrades) {
        setPublicTrades((current) => current === bufferedTrades ? current : bufferedTrades);
      }
    }, 300);
    return () => {
      handle.close();
      window.clearInterval(flushTimer);
    };
     
  }, [terminalStreamEnabled, markBackendUnavailable, reportBackendConnectivityError]);

  const refreshMarketSnapshot = useCallback(async () => {
    const snapshot = await api.markets();
    setMarketSnapshot(snapshot);
  }, []);

  useEffect(() => {
    if (workspace !== 'Trade' && workspace !== 'Strategy') return;
    void refreshMarketSnapshot().catch(reportBackendConnectivityError);
  }, [workspace, refreshMarketSnapshot, reportBackendConnectivityError]);

  useEffect(() => {
    if (settingsOpen || accountManagerOpen) void refreshConnection().catch(() => undefined);
  }, [settingsOpen, accountManagerOpen, refreshConnection]);

  useEffect(() => {
    if (accountManagerOpen) void refreshStrategies().catch(reportBackendConnectivityError);
  }, [accountManagerOpen, refreshStrategies, reportBackendConnectivityError]);

  useEffect(() => {
    const refreshConnectionAfterCredentialWindow = () => {
      void refreshConnection().catch(() => undefined);
    };
    window.addEventListener('focus', refreshConnectionAfterCredentialWindow);
    return () => window.removeEventListener('focus', refreshConnectionAfterCredentialWindow);
  }, [refreshConnection]);

  useEffect(() => {
    if (!settingsOpen && !notificationsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (settingsOpen && settingsRef.current && !settingsRef.current.contains(target)) setSettingsOpen(false);
      if (notificationsOpen && notificationsRef.current && !notificationsRef.current.contains(target)) setNotificationsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
        setNotificationsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen, notificationsOpen]);

  useEffect(() => {
    if (!strategyMenuAt && !moreMenuAt) return;
    const onPointerDown = (event: MouseEvent) => {
      if (strategyNavRef.current && !strategyNavRef.current.contains(event.target as Node)) setStrategyMenuAt(null);
      if (moreNavRef.current && !moreNavRef.current.contains(event.target as Node)) setMoreMenuAt(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const moreWasOpen = moreMenuAt !== null;
        setStrategyMenuAt(null);
        setMoreMenuAt(null);
        (moreWasOpen ? moreTriggerRef.current : strategyTriggerRef.current)?.focus();
      }
    };
    // The stored anchor goes stale if the trigger moves, so a resize simply closes the menu.
    const onResize = () => { setStrategyMenuAt(null); setMoreMenuAt(null); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); window.removeEventListener('resize', onResize); };
  }, [strategyMenuAt, moreMenuAt]);

  const openStrategyPage = useCallback((kind: StrategyKind) => {
    navigate({ workspace: 'Strategy', strategyKind: kind });
    setStrategyMenuAt(null);
    strategyTriggerRef.current?.focus();
  }, [navigate]);

  const openStrategyMenu = (trigger: HTMLButtonElement) => {
    const rect = trigger.getBoundingClientRect();
    setMoreMenuAt(null);
    setStrategyMenuAt({ top: rect.bottom + 6, left: rect.left });
    const selectedIndex = Math.max(0, strategyPages.findIndex((page) => page.kind === strategyKind));
    requestAnimationFrame(() => strategyMenuItemRefs.current[selectedIndex]?.focus());
  };

  const openMoreMenu = (trigger: HTMLButtonElement) => {
    const rect = trigger.getBoundingClientRect();
    setStrategyMenuAt(null);
    setMoreMenuAt({ top: rect.bottom + 6, left: rect.left });
  };

  const onStrategyMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const current = strategyMenuItemRefs.current.findIndex((item) => item === document.activeElement);
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(strategyPages.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = strategyPages.length - 1;
    else if (event.key === 'Tab') {
      setStrategyMenuAt(null);
      return;
    } else return;
    event.preventDefault();
    strategyMenuItemRefs.current[next]?.focus();
  };

  const orderEvents = useMemo(() => (tradingSnapshot?.orders ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8), [tradingSnapshot]);
  const unseenCount = orderEvents.filter((order) => order.updatedAt > notificationsSeenAt).length;

  function openNotifications() {
    const next = !notificationsOpen;
    setStrategyMenuAt(null);
    setMoreMenuAt(null);
    setSettingsOpen(false);
    setNotificationsOpen(next);
    if (next) setNotificationsSeenAt(new Date().toISOString());
  }

  const openModeDialog = useCallback(() => setModeDialogOpen(true), []);
  const mergeFundingHistory = useCallback((duration: FundingHistoryDuration, entries: FundingHistoryEntry[]) => {
    setFundingHistoryCache((current) => {
      if (entries.length === 0) return current;
      const nextDuration = { ...current[duration] };
      for (const entry of entries) nextDuration[entry.symbol] = entry;
      return { ...current, [duration]: nextDuration };
    });
  }, []);
  const openFundingDetail = useCallback((asset: string) => {
    navigate({ workspace: 'Funding Rates', asset });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [navigate]);
  const openFundingStrategy = useCallback((prefill: PairedPositionPrefill) => {
    setPositionPrefill(prefill);
    navigate({ workspace: 'Strategy', strategyKind: 'position' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [navigate]);

  useEffect(() => {
    if (route.workspace !== 'Strategy' || route.strategyKind !== 'position') setPositionPrefill(null);
  }, [route]);
  const availableCatalog = useMemo(
    () => catalog ?? fallbackCatalogFromSnapshot(marketSnapshot),
    [catalog, marketSnapshot],
  );
  const activeAccountStrategies = useMemo(
    () => scopeStrategiesToAccount(strategies, connection),
    [strategies, connection],
  );

  const content = useMemo(() => {
    if (workspace === 'Trade') return <TradingView asset={selectedAsset} catalog={availableCatalog} onSelectAsset={selectAsset} marketSnapshot={marketSnapshot} tradingSnapshot={tradingSnapshot} authenticatedPortfolio={authenticatedPortfolio} balances={balances} fees={fees} orderBook={orderBook} publicTrades={publicTrades} candleSeries={candleSeries} candleBackfilling={candleBackfilling} watchMarket={watchMarket} seedCandles={seedCandles} onTradingChanged={refreshTrading} onPositionsRefresh={refreshPositions} tradingMode={tradingMode} onOpenModeDialog={openModeDialog} favorites={favorites} onToggleFavorite={toggleFavorite} confirmOrders={confirmOrders} onSetConfirmOrders={setConfirmOrders} />;
    if (workspace === 'Strategy') {
      if (strategyKind === 'premium') return <PremiumStrategyView marketSnapshot={marketSnapshot} catalog={availableCatalog} strategies={activeAccountStrategies} balances={balances} authenticatedPortfolio={authenticatedPortfolio} tradingSnapshot={tradingSnapshot} tradingMode={tradingMode} onOpenModeDialog={openModeDialog} onStrategiesChanged={refreshStrategies} onPositionsRefresh={refreshPositions} candleSeries={candleSeries} watchQuotes={watchQuotes} watchKlines={watchKlines} />;
      if (strategyKind === 'boros') return <BorosStrategyView marketSnapshot={marketSnapshot} catalog={availableCatalog} balances={balances} fees={fees} feesReady={feesReady} strategies={activeAccountStrategies} authenticatedPortfolio={authenticatedPortfolio} tradingSnapshot={tradingSnapshot} tradingMode={tradingMode} onOpenModeDialog={openModeDialog} onStrategiesChanged={refreshStrategies} onPositionsRefresh={refreshPositions} watchQuotes={watchQuotes} />;
      return <StrategyView mode={strategyKind} prefill={positionPrefill} marketSnapshot={marketSnapshot} catalog={availableCatalog} fees={fees} strategies={activeAccountStrategies} balances={balances} authenticatedPortfolio={authenticatedPortfolio} tradingSnapshot={tradingSnapshot} tradingMode={tradingMode} onOpenModeDialog={openModeDialog} onStrategiesChanged={refreshStrategies} onPositionsRefresh={refreshPositions} watchQuotes={watchQuotes} />;
    }
    if (workspace === 'Funding Rates') return fundingDetailAsset
      ? <FundingDetailView asset={fundingDetailAsset} fundingOverview={fundingOverview} onFundingOverview={setFundingOverview} onBack={() => navigate({ workspace: 'Funding Rates', asset: null })} />
      : <FundingRatesView metric={fundingMetric} onMetricChange={setFundingMetric} marketSnapshot={marketSnapshot} onMarketFallback={refreshMarketSnapshot} onOpenAsset={openFundingDetail} onOpenStrategy={openFundingStrategy} fundingOverview={fundingOverview} onFundingOverview={setFundingOverview} fundingHistoryCache={fundingHistoryCache} onFundingHistoryEntries={mergeFundingHistory} />;
    if (workspace === 'Portfolio') return <PortfolioView key={connection?.activeProfileId ?? 'no-active-account'} tradingSnapshot={tradingSnapshot} balances={balances} portfolio={authenticatedPortfolio} accountStream={accountStream} tradingMode={tradingMode} onOpenModeDialog={openModeDialog} onRefresh={refreshAuthenticatedPortfolio} />;
    if (workspace === 'Trading Fees') return <FeeComparisonView catalog={availableCatalog} marketSnapshot={marketSnapshot} favorites={favorites} fees={fees} feesReady={feesReady} error={feesError} onRefresh={refreshFees} />;
    return null;

  }, [workspace, strategyKind, positionPrefill, selectedAsset, fundingMetric, fundingOverview, fundingHistoryCache, availableCatalog, selectAsset, marketSnapshot, tradingSnapshot, authenticatedPortfolio, accountStream, activeAccountStrategies, balances, fees, feesReady, feesError, orderBook, publicTrades, candleSeries, candleBackfilling, tradingMode, openModeDialog, watchMarket, watchQuotes, watchKlines, seedCandles, refreshTrading, refreshStrategies, refreshPositions, refreshMarketSnapshot, refreshFees, favorites, toggleFavorite, confirmOrders, fundingDetailAsset, openFundingDetail, openFundingStrategy, mergeFundingHistory, navigate, connection?.activeProfileId]);

  const storageLabel = connection?.storage === 'os_keychain' ? t('OS keychain') : connection?.storage === 'env_file' ? t('Local .env file') : connection?.storage ?? '—';
  const accountStatusLabel = accountStream?.state === 'live' ? t('Account live')
    : accountStream?.state === 'credentials_missing' ? t('Account credentials needed')
    : accountStream?.state === 'authentication_failed' ? t('Account authentication failed')
    : t('Account reconnecting');
  const accountStatusConnected = accountStream?.state === 'live';

  const applyAccountConnection = useCallback((next: CredentialConnectionStatus) => {
    setConnection(next);
    if (next.readOnly) {
      setTradingMode((current) => current === 'unset' ? current : 'readonly');
    }
  }, []);

  const beginAccountNameEdit = useCallback(() => {
    if (!connection?.activeProfileId || !connection.label) return;
    setDeleteConfirmationId(null);
    setAccountNameDraft(connection.label);
    setAccountRenameError(null);
    setEditingAccountName(true);
  }, [connection?.activeProfileId, connection?.label]);

  const cancelAccountNameEdit = useCallback(() => {
    if (accountRenameSaving) return;
    setEditingAccountName(false);
    setAccountRenameError(null);
  }, [accountRenameSaving]);

  const renameCurrentAccount = useCallback(async () => {
    const profileId = connection?.activeProfileId;
    const label = accountNameDraft.trim();
    if (!profileId || !label) {
      setAccountRenameError('Enter an account name.');
      return;
    }
    if (label === connection.label) {
      setEditingAccountName(false);
      setAccountRenameError(null);
      return;
    }

    setAccountRenameSaving(true);
    setAccountRenameError(null);
    try {
      const next = await api.renameAccount(profileId, label);
      applyAccountConnection(next);
      setStrategies((current) => current.map((strategy) => strategy.accountProfileId === profileId
        ? { ...strategy, accountLabel: next.label }
        : strategy));
      setEditingAccountName(false);
    } catch (error) {
      reportBackendConnectivityError(error);
      setAccountRenameError('Unable to rename this account. Try again.');
    } finally {
      setAccountRenameSaving(false);
    }
  }, [accountNameDraft, applyAccountConnection, connection?.activeProfileId, connection?.label, reportBackendConnectivityError]);

  useLayoutEffect(() => {
    const activeProfileId = connection?.activeProfileId ?? null;
    if (feeProfileRef.current === undefined) {
      feeProfileRef.current = activeProfileId;
      return;
    }
    if (feeProfileRef.current === activeProfileId) return;
    feeProfileRef.current = activeProfileId;
    feeRequestGenerationRef.current += 1;
    feesLoadedRef.current = false;
    setFees([]);
    setFeesReady(false);
    setFeesError(null);
    if (workspace === 'Trade' || workspace === 'Strategy' || workspace === 'Trading Fees') refreshFees();
    setEditingAccountName(false);
    setAccountRenameError(null);
  }, [connection?.activeProfileId, refreshFees, workspace]);

  useEffect(() => {
    if (settingsOpen) return;
    setEditingAccountName(false);
    setAccountRenameError(null);
  }, [settingsOpen]);

  const openAccountManager = useCallback(() => {
    setSettingsOpen(false);
    setEditingAccountName(false);
    setAccountRenameError(null);
    setAccountManagerError(null);
    setDeleteConfirmationId(null);
    setPendingAccountSwitch(null);
    setAccountManagerOpen(true);
  }, []);

  const closeAccountManager = useCallback(() => {
    if (accountAction || accountRenameSaving) return;
    setAccountManagerOpen(false);
    setEditingAccountName(false);
    setAccountRenameError(null);
    setDeleteConfirmationId(null);
    setPendingAccountSwitch(null);
    setAccountManagerError(null);
  }, [accountAction, accountRenameSaving]);

  const switchAccount = useCallback(async (profileId: string, confirmPauseRunningStrategies: boolean) => {
    setAccountAction({ profileId, kind: 'switch' });
    setAccountManagerError(null);
    try {
      applyAccountConnection(await api.switchAccount(profileId, confirmPauseRunningStrategies));
      await refreshStrategies();
      setPendingAccountSwitch(null);
    } catch (error) {
      reportBackendConnectivityError(error);
      if (error instanceof ApiError && error.code === 'running_strategies_require_confirmation') {
        const affected = strategies.filter((strategy) => strategy.status === 'RUNNING'
          && strategyBelongsToAccount(strategy, connection?.activeProfileId ?? null));
        setPendingAccountSwitch({ profileId, strategies: affected });
      } else {
        setAccountManagerError('Unable to switch accounts. Try again.');
      }
    } finally {
      setAccountAction(null);
    }
  }, [applyAccountConnection, connection?.activeProfileId, refreshStrategies, reportBackendConnectivityError, strategies]);

  const requestAccountSwitch = useCallback((profileId: string) => {
    const affected = strategies.filter((strategy) => strategy.status === 'RUNNING'
      && strategyBelongsToAccount(strategy, connection?.activeProfileId ?? null));
    if (affected.length > 0) {
      setPendingAccountSwitch({ profileId, strategies: affected });
      setAccountManagerError(null);
      return;
    }
    void switchAccount(profileId, false);
  }, [connection?.activeProfileId, strategies, switchAccount]);

  const deleteAccount = useCallback(async (profileId: string) => {
    setAccountAction({ profileId, kind: 'delete' });
    setAccountManagerError(null);
    try {
      applyAccountConnection(await api.deleteAccount(profileId));
      setDeleteConfirmationId(null);
    } catch (error) {
      reportBackendConnectivityError(error);
      setAccountManagerError('Unable to delete this account. Try again.');
    } finally {
      setAccountAction(null);
    }
  }, [applyAccountConnection, reportBackendConnectivityError]);

  useEffect(() => {
    if (tradingMode !== 'unset' && !modeDialogOpen) return;
    setStrategyMenuAt(null);
    setMoreMenuAt(null);
    setNotificationsOpen(false);
    setSettingsOpen(false);
    setAccountManagerOpen(false);
    setPendingAccountSwitch(null);
  }, [modeDialogOpen, tradingMode]);

  return <LanguageContext.Provider value={{ language, theme, t, setLanguage }}><div className={`app-shell${workspace === 'Trade' ? ' trading-page' : ''}`}>
    <header className="topbar">
      <button
        className="brand"
        aria-label="All In One by yourQuantGuy — Gate CrossEx"
        onClick={() => navigate({ workspace: 'Trade' })}
      >
        <span className="brand-symbol" aria-hidden="true">
          <img src={brandMark} alt="" />
        </span>
        <span className="brand-copy">
          <span className="brand-title">
            <strong>All In One</strong>
            <small>by yourQuantGuy</small>
          </span>
          <span className="brand-edition">Gate CrossEx</span>
        </span>
      </button>
      <nav aria-label={t('Main navigation')}>{navItems.map((item) => item.label === 'Strategy'
        ? <div className="nav-strategy" key={item.label} ref={strategyNavRef}>
          <button ref={strategyTriggerRef} className={`topbar-navigation-button ${workspace === 'Strategy' && strategyKind !== 'boros' ? 'active' : ''}${strategyMenuAt ? ' menu-open' : ''}`}
            aria-haspopup="menu" aria-expanded={strategyMenuAt !== null}
            onClick={(event) => { if (strategyMenuAt) setStrategyMenuAt(null); else openStrategyMenu(event.currentTarget); }}
            onKeyDown={(event) => {
              if (!strategyMenuAt && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                openStrategyMenu(event.currentTarget);
              }
            }}>
            <TopbarNavigationContent label={item.label} glyph={item.glyph} /><svg className="nav-caret" viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" /></svg>
          </button>
          {strategyMenuAt && <ul className="nav-strategy-menu" role="menu" aria-label={t('Strategy mode')}
            style={strategyMenuAt} onKeyDown={onStrategyMenuKeyDown}>
            {strategyPages.map((page) => <li key={page.kind} role="none">
              <button ref={(node) => { strategyMenuItemRefs.current[strategyPages.indexOf(page)] = node; }}
                role="menuitem" className={workspace === 'Strategy' && strategyKind === page.kind ? 'selected' : ''}
                onClick={() => openStrategyPage(page.kind)}>
                <strong>{t(page.label)}</strong><small>{t(page.detail)}</small>
              </button>
            </li>)}
          </ul>}
        </div>
        : <button key={item.label} className={`topbar-navigation-button ${item.label === 'Boros by Pendle' ? workspace === 'Strategy' && strategyKind === 'boros' ? 'active' : '' : workspace === item.label ? 'active' : ''}`} onClick={() => {
          navigate(item.label === 'Trade'
            ? { workspace: 'Trade' }
            : item.label === 'Boros by Pendle'
              ? { workspace: 'Strategy', strategyKind: 'boros' }
            : item.label === 'Funding Rates'
              ? { workspace: 'Funding Rates', asset: null }
              : { workspace: 'Portfolio' });
        }}><TopbarNavigationContent label={item.label} glyph={item.glyph} iconSrc={item.label === 'Boros by Pendle' ? borosMark : undefined} /></button>)}
        <div className="nav-strategy nav-more" ref={moreNavRef}>
          <button ref={moreTriggerRef} className={`topbar-navigation-button ${workspace === 'Trading Fees' ? 'active' : ''}${moreMenuAt ? ' menu-open' : ''}`}
            aria-label={t('More')} aria-haspopup="menu" aria-expanded={moreMenuAt !== null}
            onClick={(event) => { if (moreMenuAt) setMoreMenuAt(null); else openMoreMenu(event.currentTarget); }}
            onKeyDown={(event) => {
              if (!moreMenuAt && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                openMoreMenu(event.currentTarget);
                requestAnimationFrame(() => moreNavRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
              }
            }}>
            <TopbarNavigationContent label="More" glyph="⋯" /><svg className="nav-caret" viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" /></svg>
          </button>
          {moreMenuAt && <ul className="nav-strategy-menu nav-more-menu" role="menu" aria-label={t('More tools')} style={moreMenuAt}>
            <li role="none"><button role="menuitem" className={workspace === 'Trading Fees' ? 'selected' : ''} onClick={() => {
              navigate({ workspace: 'Trading Fees' });
              setMoreMenuAt(null);
              moreTriggerRef.current?.focus();
            }}><strong>{t('Trading fee comparison')}</strong><small>{t('Compare account fees by ticker')}</small></button></li>
          </ul>}
        </div>
      </nav>
      <div className="top-actions">
        {tradingMode !== null && tradingMode !== 'unset' && <button className={`topbar-navigation-button mode-badge ${tradingMode}`} onClick={openModeDialog} title={t('Switch trading mode')} aria-label={t('Switch trading mode')}>
          <i />{t(tradingMode === 'live' ? 'Live trading' : 'Read-only')}
        </button>}
        <button className={`topbar-navigation-button portfolio-shortcut${workspace === 'Portfolio' ? ' active' : ''}`} onClick={() => navigate({ workspace: 'Portfolio' })}>
          <TopbarNavigationContent label="Portfolio" glyph="◒" />
        </button>
        <div className="profile-wrap" ref={notificationsRef}>
          <button className="utility" aria-label={t('Notifications')} aria-haspopup="dialog" aria-expanded={notificationsOpen} onClick={openNotifications}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
            {unseenCount > 0 && <i />}
          </button>
          {notificationsOpen && <div className="profile-menu notifications-menu" role="dialog" aria-label={t('Notifications')}>
            <strong>{t('Notifications')}</strong>
            <small>{unseenCount > 0 ? `${unseenCount} new` : t('Mark all read')}</small>
            {orderEvents.length === 0 && <p className="notifications-empty">{t('No notifications yet')}<br />{t('Order events will appear here.')}</p>}
            {orderEvents.map((order) => { const part = symbolParts(order.symbol); return <div className="notification-row" key={`${order.id}-${order.updatedAt}`}><span className={order.side === 'BUY' ? 'positive' : 'negative'}>{t(order.side === 'BUY' ? 'Buy' : 'Sell')}</span><span>{order.quantity} {part.asset} · {part.venue}</span><em>{order.state}</em></div>; })}
          </div>}
        </div>
        <div className="profile-wrap settings-wrap" ref={settingsRef}>
          <button className="settings-button" aria-label={t('Settings')} title={t('Settings')} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => {
            setStrategyMenuAt(null);
            setMoreMenuAt(null);
            setNotificationsOpen(false);
            setSettingsOpen((current) => !current);
          }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.38.33.72.6 1 .3.29.68.43 1.1.4h.09v4h-.09a1.7 1.7 0 0 0-1.7.6Z" /></svg>
          </button>
          {settingsOpen && <section className="settings-panel" role="dialog" aria-label={t('Preferences')}>
            <p className="settings-section">{t('Account settings')}</p>
            <div className="settings-account">
              <small>{t('Current account')}</small>
              <strong>{connection?.label ?? (connection?.configured ? t('Live account') : t('Credentials not configured'))}</strong>
              <small>{connection?.configured
                ? `${storageLabel} · ${connection.lastVerifiedAt ? `${t('Verified')} ${new Date(connection.lastVerifiedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}` : t('Never verified')}`
                : t('Credentials not configured')}</small>
              {connection?.readOnly && <small className="readonly-flag">{t('Read-only until enabled')}</small>}
              {connection && connection.profiles.length > 1 && <small>{connection.profiles.length} {t('saved accounts')}</small>}
            </div>
            <button className="settings-link" onClick={openAccountManager}>{t('Manage and switch accounts')}<span>›</span></button>
            <p className="settings-section">{t('Trading')}</p>
            <div className="settings-row">
              <div><strong>{t('Order confirmation')}</strong><small>{t(confirmOrders ? 'Show a confirmation popup before submitting an order' : 'Orders submit immediately without confirmation')}</small></div>
              <label className="preference-switch">
                <input type="checkbox" checked={confirmOrders} onChange={(event) => setConfirmOrders(event.target.checked)} aria-label={t('Order confirmation')} />
                <i />
              </label>
            </div>
            <p className="settings-section">{t('Display')}</p>
            <div className="settings-row">
              <strong>{t('Language')}</strong>
              <div className="settings-options" role="group" aria-label={t('Language')}>
                <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')} aria-pressed={language === 'en'}>EN</button>
                <button className={language === 'zh' ? 'active' : ''} onClick={() => setLanguage('zh')} aria-pressed={language === 'zh'}>中文</button>
              </div>
            </div>
            <div className="settings-row">
              <strong>{t('Theme')}</strong>
              <div className="settings-options" role="group" aria-label={t('Theme')}>
                <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')} aria-pressed={theme === 'dark'}>{t('Dark mode')}</button>
                <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')} aria-pressed={theme === 'light'}>{t('Light mode')}</button>
              </div>
            </div>
            <button className="settings-link" onClick={() => window.open('/api/system/discovery', '_blank', 'noopener')}>API<span>›</span></button>
            <p className="settings-section">{t('Open source')}</p>
            <div className="settings-account">
              <strong>© 2026 yourQuantGuy and contributors</strong>
              <small>{t('Licensed under AGPL-3.0-only · no warranty')}</small>
            </div>
            <button className="settings-link" onClick={() => window.open(SOURCE_CODE_URL, '_blank', 'noopener')}>{t('Source code')}<span>›</span></button>
            <button className="settings-link" onClick={() => window.open(LICENSE_URL, '_blank', 'noopener')}>{t('AGPL-3.0 license')}<span>›</span></button>
          </section>}
        </div>
      </div>
    </header>
    {showBackendOffline && <section className="system-banner offline-banner" role="alert">
      <div><strong>{t('Backend is offline')}</strong><span>{t('The local backend has not responded. Run ./run doctor, then restart it with ./run.')}</span></div>
      <button onClick={() => window.location.reload()}>{t('Retry')}</button>
    </section>}
    <main className="workspace">
      <Suspense fallback={<div className="route-loading" role="status">{t('Loading workspace…')}</div>}>
        {content}
      </Suspense>
    </main>
    <footer className="statusbar"><div>{terminalStreamEnabled ? <><span className={streamState === 'connected' ? 'connected' : ''}><i /> {t(streamState === 'connected' ? 'Backend stream connected' : 'Reconnecting backend stream')}</span><span>LIVE {t('environment')}</span><span className={marketSnapshot?.connectionState === 'healthy' ? 'connected' : ''}><i /> {t('Market data')} {t(marketSnapshot?.connectionState ?? 'connecting')}</span><span className={accountStatusConnected ? 'connected' : ''}><i /> {accountStatusLabel}</span></> : <span className={fundingOverview ? 'connected' : ''}><i /> {t('Funding Rates')}</span>}</div><div><UtcClock /><button onClick={() => window.open(`${SOURCE_CODE_URL}/issues`, '_blank', 'noopener')}>{t('Support')}</button><button onClick={() => window.open(SOURCE_CODE_URL, '_blank', 'noopener')}>{t('Source code')}</button><button onClick={() => window.open(LICENSE_URL, '_blank', 'noopener')}>AGPL-3.0</button><span title={`Release ${RELEASE_VERSION}`}>{RELEASE_VERSION}</span></div></footer>
    <AccountManagerDialog
      open={accountManagerOpen}
      connection={connection}
      language={language}
      action={accountAction}
      pendingSwitch={pendingAccountSwitch}
      deleteConfirmationId={deleteConfirmationId}
      error={accountManagerError}
      editingAccountName={editingAccountName}
      accountNameDraft={accountNameDraft}
      accountRenameSaving={accountRenameSaving}
      accountRenameError={accountRenameError}
      onClose={closeAccountManager}
      onSwitch={requestAccountSwitch}
      onCancelSwitch={() => { if (!accountAction) { setPendingAccountSwitch(null); setAccountManagerError(null); } }}
      onConfirmSwitch={(profileId) => { void switchAccount(profileId, true); }}
      onRequestDelete={(profileId) => { setDeleteConfirmationId(profileId); setAccountManagerError(null); }}
      onCancelDelete={() => setDeleteConfirmationId(null)}
      onDelete={(profileId) => { void deleteAccount(profileId); }}
      onBeginRename={beginAccountNameEdit}
      onAccountNameChange={setAccountNameDraft}
      onCancelRename={cancelAccountNameEdit}
      onRename={() => { void renameCurrentAccount(); }}
      onAdd={() => openCredentialWindow(`/secure/credentials?action=add&lang=${language}`)}
    />
    {tradingMode !== null && (tradingMode === 'unset' || modeDialogOpen) && <TradingModeGate
      mode={tradingMode}
      credentialEntryPath={connection?.secureEntryPath ?? '/secure/credentials'}
      onCredentialStatus={setConnection}
      onApplied={(mode) => {
        setTradingMode(mode);
        setConnection((current) => current ? { ...current, readOnly: mode !== 'live' } : current);
      }}
      onClose={tradingMode === 'unset' ? null : () => setModeDialogOpen(false)}
    />}
  </div></LanguageContext.Provider>;
}

export default App;
