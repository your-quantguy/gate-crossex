# Changelog

All notable changes to Gate CrossEx are documented in this file.

## [0.2.3] - 2026-09-05

### Fixed

- Live-mode activation and credential changes no longer stay blocked by stale local orders: order reconciliation now cross-checks Gate's open-order list when the order endpoint refuses an id, closes rows Gate no longer lists, and tolerates sparse order payloads.
- Blocked activations now report each unconfirmed order with its symbol, side, state, and reason in the trading-mode dialog, the backend log, and the audit trail, with a retry action instead of a bare list of ids.

### Changed

- Refreshed the transitive `browserslist` and `fast-uri` dependencies to clear the high-severity advisories that gate releases.

## [0.2.2] - 2026-08-14

### Added

- Added secure multi-account credential profiles with switching, renaming, deletion, and account-aware strategy ownership.
- Added a shared grouped-position view across Trade, Strategies, and Portfolio, including live ADL risk indicators and position-closing controls.
- Added direction-aware realized funding analytics and streamed premium-history data for paired strategies.

### Changed

- Strengthened strategy launch, execution, recovery, and ticker-delivery checks while reducing redundant authenticated and market-data work.
- Improved venue selectors, responsive layouts, light-theme coverage, typography, translations, and accessibility checks.

### Fixed

- Serialized credential mutations against live orders, leverage changes, strategy operations, and transfers.
- Prevented stale positions, fee schedules, portfolio activity, and transfer state from leaking across account switches.
- Bounded supplemental ADL enrichment so unavailable or rate-limited rank data cannot stall portfolio refreshes.

## [0.2.1] - 2026-08-10

### Added

- Added a bilingual interactive CLI update check that detects newer published GitHub releases and offers to run the existing update workflow before startup.

### Changed

- Update checks now skip non-interactive launches, development branches, pinned source refs, offline failures, and sessions with `GCT_SKIP_UPDATE_CHECK=1`.
- Source bootstraps now validate that the update-check helper is present before activating a downloaded source tree.

## [0.2.0] - 2026-08-10

### Added

- Added a Boros by Pendle fixed-rate workflow for comparing and executing fixed funding-rate opportunities.
- Added asset-grouped positions with immediate or scheduled, batched reduce-only closing.
- Added account trading-fee comparison by market.

### Changed

- Funding rates now use each venue's native settlement interval, with normalized comparisons, more efficient refreshes, and last-known-good data retention.
- Strategy launches and direct orders now validate margin requirements and leverage-tier position limits before execution.
- Strategy reconciliation and recovery now handle maker/taker execution and residual hedge repair more robustly.

### Fixed

- Added stop and log support for close-position strategies.
- Kept funding data available when optional Gate or Binance market metadata cannot be loaded.
- Updated the transitive `nanoid` dependency to a release without high-severity audit findings.
