.PHONY: local-ci local-release

local-ci:
	@./scripts/local-ci/run-all.sh

local-release:
	@./scripts/local-ci/run-release-local.sh