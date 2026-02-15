# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [0.2.0] - 2026-02-15
### Added
- Screener page in React dashboard with custom criteria/date range scan.
- Screener presets: `Trend Breakout`, `RSI Pullback`, `High Volume Momentum`.
- CSV export for screener results.
- One-click handoff from Screener selected symbols to Morning Preview.
- Dedicated `Config (.env)` page in React dashboard.
- ESLint setup and CI lint workflow.

### Changed
- Morning Preview API supports optional symbol filter (`/api/morning/preview?symbols=...`).
- Backtest now uses warmup history for short explicit date windows.

## [0.1.0] - 2026-02-11
### Added
- Initial algo trading platform with live/paper engine, UI, and ops docs.

## Commit History (All Commits To Date)
- `6705c37` (2026-02-15): feat(ui): add screener workflows, config page split, and lint pipeline
- `367f740` (2026-02-13): Revert "fix(ui): send admin/tenant headers and surface action errors"
- `7ac5d6b` (2026-02-13): fix(ui): send admin/tenant headers and surface action errors
- `85ae0f1` (2026-02-13): revert(ui): restore previous single-page dashboard
- `4cac6fd` (2026-02-12): feat(billing): add tenant-aware subscriptions, gating, audit, and onboarding
- `f7e333d` (2026-02-12): feat(billing): add webhook event monitor with status and reasons
- `433be03` (2026-02-12): feat(billing): add verified webhook endpoints for stripe and razorpay
- `43623e5` (2026-02-12): feat(billing): add native stripe and razorpay checkout flow
- `1b09aab` (2026-02-12): feat(ui): redesign dashboard into saas multi-page experience
- `65cec56` (2026-02-12): feat(ui): add editable .env config panel
- `fd1c3b6` (2026-02-12): feat(sizing): add minimum capital deployment floor
- `527b3d2` (2026-02-12): feat(protection): add gtt retry diagnostics and failure log panel
- `7bf3330` (2026-02-12): feat(protection): add broker-native gtt oco lifecycle and ui controls
- `f4eca80` (2026-02-12): feat(ui): add clear reject guard action
- `41d94a2` (2026-02-12): fix(execution): use net/live balance for kite available funds
- `02871e9` (2026-02-11): feat(ui): add morning order preview, pnl attribution, and weekly pdf report
- `e268d30` (2026-02-11): Fix funds display and add one-click funds recompute in UI
- `d00525e` (2026-02-11): Fix Postgres pool reuse and expand allowed symbols to Nifty100
- `2a5da70` (2026-02-11): Add Strategy Lab with scheduler, APIs, persistence, and React UI
- `35d7b54` (2026-02-11): docs: add detailed trader guide and link from README
- `94284f4` (2026-02-11): feat: add preopen gate, token alerts, eod summary, and profile automation
- `73b0b07` (2026-02-11): feat: add funds-aware sizing and full React dashboard UI
- `ed43255` (2026-02-11): feat: add broker orderbook UI with diagnostics
- `176912c` (2026-02-11): fix: add AMO fallback for after-hours live orders
- `2903964` (2026-02-11): feat: show kite token time-left in live health
- `13d1dc4` (2026-02-11): feat: add UI scheduler automation controls
- `3d4cb44` (2026-02-11): feat: add trade journal analytics and export
- `0883f14` (2026-02-11): feat: add backtest engine and dashboard integration
- `ed079ae` (2026-02-11): feat: add live pre-trade checklist command
- `c1dee55` (2026-02-11): feat(reliability): add preflight, alerts, reconcile audit, and ops UI controls
- `30a0408` (2026-02-11): Initial algo trading platform with live/paper engine, UI, and ops docs
