# Changelog

All notable changes to ollama-cloud-provider are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), adheres to [SemVer 2.0.0](https://semver.org/).

## [Unreleased]

_No changes yet. Merged PRs add bullets here; the Git Workflow Specialist promotes this section to a dated release at cut time (see `git-workflow.instructions.md` versioning cadence)._

## [0.5.1] - 2026-07-23

### Changed
- README rewritten as professional public-facing page (Marketplace + GitHub). Removed internal/dev/CI noise. Marketplace install added as recommended path.

### Notes
- Docs-only release. No code changes. Version bump to refresh Marketplace README (Marketplace reads README from VSIX, not from GitHub).

## [0.5.0] - 2026-07-22

### Added
- Vision Fallback Pass-through (ADR 0004): when primary model cannot handle vision and user enables `ollamaCloud.visionFallback`, extension swaps to a user-configured vision-capable model for that turn. Settings: `visionFallback.enabled`, `visionFallback.model`, `visionFallback.connection` (all scope:application). Commands: `Ollama Cloud: Set Vision Fallback Model`, `Ollama Cloud: Set Vision Fallback Connection`.
- CancellationToken race fix in `ollamaClient.streamChat` (synchronous `isCancellationRequested` check before first await).

### Fixed
- `redactSensitive` now masks `data:image/*;base64,...` payloads (defense-in-depth, v0.4.0 security audit finding #1).
- Stale `visionFallback.connection` now logs a warning and falls back to primary (M2).
- QuickPick "Set Vision Fallback Connection" now offers a "Clear — use primary connection" option (M3).

### Security
- v0.4.0 security audit: PASS WITH NOTES, no regression vs v0.3.0. All 8 invariants hold on new code (multi-connection + vision).
- Vision Fallback code review: APPROVE WITH NOTES, all 10 ADR 0004 constraints verified.