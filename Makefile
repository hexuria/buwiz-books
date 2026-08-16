# Buwiz Books application development commands.
#
# Production provisioning, migration, and deployment are owned by the separate
# canonical deployment repository. Historical target names remain as explicit
# fail-closed fuses so old runbooks cannot mutate infrastructure from here.

BOLD  := \033[1m
RESET := \033[0m
CYAN  := \033[36m
RED   := \033[31m

.PHONY: help run build check test docs-dev internal-docs-dev push deploy deploy-docker scheduler env logs url open db-prod rls-prod promote-prod provision migrate migration-status migration-verify domain

help:
	@echo ""
	@echo "$(BOLD)Buwiz Books — application repository$(RESET)"
	@echo ""
	@echo "  $(CYAN)make run$(RESET)               Start the local development server"
	@echo "  $(CYAN)make build$(RESET)             Build the application locally"
	@echo "  $(CYAN)make check$(RESET)             Run lint, formatting, and type checks"
	@echo "  $(CYAN)make test$(RESET)              Run the application test suite"
	@echo "  $(CYAN)make docs-dev$(RESET)          Start the client docs locally"
	@echo "  $(CYAN)make internal-docs-dev$(RESET) Start the internal docs locally"
	@echo ""
	@echo "$(RED)Production operations are disabled in this repository.$(RESET)"
	@echo "Use the canonical deployment repository and its approved runbook."
	@echo ""

run:
	bun run dev

build:
	bun run build

check:
	bun run check

test:
	bun run test

docs-dev:
	cd docs && bunx mintlify dev --port 3000

internal-docs-dev:
	cd internal-docs && bunx mintlify dev --port 3001

push:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

deploy:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

deploy-docker:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

scheduler:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

env:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

logs:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

url:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

open:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

db-prod:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

rls-prod:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

promote-prod:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

provision:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

migrate:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1

migration-status:
	@bun run scripts/migrate.ts status

migration-verify:
	@bun run scripts/migrate.ts verify

domain:
	@echo "$(RED)This production operation is disabled in this application repository.$(RESET)"
	@exit 1
