export type StrategyRouteKind = 'position' | 'auto' | 'premium' | 'oil-spread' | 'boros';

export type FrontendRoute =
  | { workspace: 'Trade' }
  | { workspace: 'Strategy'; strategyKind: StrategyRouteKind }
  | { workspace: 'Funding Rates'; asset: string | null }
  | { workspace: 'Portfolio' }
  | { workspace: 'Trading Fees' };

export const DEFAULT_FRONTEND_ROUTE: FrontendRoute = { workspace: 'Trade' };

const STRATEGY_PATHS: Record<StrategyRouteKind, string> = {
  position: '/strategies/paired-position',
  auto: '/strategies/price-difference',
  premium: '/strategies/sk-hynix-premium',
  'oil-spread': '/strategies/bz-cl-spread',
  boros: '/strategies/boros',
};

/** Convert an application page into its canonical, reload-safe browser path. */
export function frontendPath(route: FrontendRoute): string {
  if (route.workspace === 'Trade') return '/';
  if (route.workspace === 'Strategy') return STRATEGY_PATHS[route.strategyKind];
  if (route.workspace === 'Portfolio') return '/portfolio';
  if (route.workspace === 'Trading Fees') return '/tools/trading-fees';
  return route.asset ? `/funding-rates/${encodeURIComponent(route.asset)}` : '/funding-rates';
}

/** Resolve only known frontend paths; API and secure backend paths must never become app pages. */
export function frontendRoute(pathname: string): FrontendRoute | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return DEFAULT_FRONTEND_ROUTE;
  if (path === '/portfolio') return { workspace: 'Portfolio' };
  if (path === '/tools/trading-fees') return { workspace: 'Trading Fees' };
  if (path === '/funding-rates') return { workspace: 'Funding Rates', asset: null };

  const strategyKind = (Object.entries(STRATEGY_PATHS) as Array<[StrategyRouteKind, string]>)
    .find(([, strategyPath]) => strategyPath === path)?.[0];
  if (strategyKind) return { workspace: 'Strategy', strategyKind };

  const fundingMatch = /^\/funding-rates\/([^/]+)$/.exec(path);
  if (!fundingMatch?.[1]) return null;
  try {
    const asset = decodeURIComponent(fundingMatch[1]).trim().toUpperCase();
    return asset && /^[A-Z0-9]+$/.test(asset) ? { workspace: 'Funding Rates', asset } : null;
  } catch {
    return null;
  }
}
