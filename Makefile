.PHONY: local-ci local-release local-release-v local-release-dry-run

local-ci:
	@./scripts/local-ci/run-all.sh

## Full local release pipeline (10 steps: gates, build, sign, SBOM, tag, release).
## Version auto-detected from package.json. See scripts/local-ci/run-release-local.sh.
local-release:
	@./scripts/local-ci/run-release-local.sh

## Release with an explicit version: make local-release-v VERSION=v0.2.0
local-release-v:
	@if [ -z "$(VERSION)" ]; then echo "ERROR: VERSION not set. Usage: make local-release-v VERSION=v0.2.0"; exit 1; fi
	@./scripts/local-ci/run-release-local.sh "$(VERSION)"

## Dry-run the release pipeline — prints the plan, performs no mutations.
local-release-dry-run:
	@./scripts/local-ci/run-release-local.sh --dry-run
