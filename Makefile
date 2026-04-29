.PHONY: codegen test test-frontend test-py test-e2e lint format up down logs migrate seed

# Regenerate Pydantic types from Zod schemas across all Python services.
codegen:
	pnpm --filter @smart-supply/shared-types export-schema
	python3 services/scripts/generate_pydantic.py

# Run all unit tests.
test: test-frontend test-py

test-frontend:
	pnpm -r test

test-py:
	pytest services/ml-forecast services/ml-optimize services/ml-agent -q

test-e2e:
	pnpm --filter @smart-supply/frontend test:e2e

lint:
	pnpm -r lint
	ruff check services/

format:
	pnpm format
	ruff format services/

up:
	docker compose -f infra/docker-compose.yml up -d

down:
	docker compose -f infra/docker-compose.yml down -v

logs:
	docker compose -f infra/docker-compose.yml logs -f --tail=100

migrate:
	pnpm --filter @smart-supply/db migrate

seed:
	pnpm --filter @smart-supply/db seed
