# AGENTS.md

## Project Overview

[`relatr`](package.json) is a Bun/TypeScript service for computing personalized trust metrics for the Nostr ecosystem. It combines social graph traversal, profile validation, optional trusted assertions, and an MCP server interface. The default local entrypoint runs a browser-based configuration UI backed by [`manager.ts`](manager.ts).

### Main areas of the repository

- [`src/`](src): core service logic, MCP server, database, trust calculation, plugin runtime, and tests.
- [`config-ui/`](config-ui): browser UI served by the manager process for editing environment variables and controlling the service.
- [`plugins/elo/`](plugins/elo): portable plugin JSON events used by the Elo plugin engine.
- [`elo/`](elo): vendored sibling package for the Elo expression language used by the plugin system.

### Architecture notes

- The default runtime starts [`manager.ts`](manager.ts), which launches the config UI and then manages the compiled service process.
- The MCP server entrypoint is [`src/mcp/server.ts`](src/mcp/server.ts).
- Persistent storage uses DuckDB with schema file [`src/database/duckdb-schema.sql`](src/database/duckdb-schema.sql).
- The main service composition lives under [`src/service/`](src/service), with graph logic under [`src/graph/`](src/graph), capabilities under [`src/capabilities/`](src/capabilities), and plugin execution under [`src/plugins/`](src/plugins).

## Setup Commands

### Prerequisites

- Bun 1.x
- Docker and Docker Compose for containerized runs

### Install dependencies

```bash
bun install
```

### Initial environment setup

```bash
cp .env.example .env
openssl rand -hex 32
```

Set the generated key as `SERVER_SECRET_KEY` in [`.env`](.env.example). The canonical variable list and defaults live in [`.env.example`](.env.example).

## Development Workflow

### Default local development flow

Use the manager-based UI flow unless you specifically need the MCP server entrypoint:

```bash
bun start
```

This runs the [`start`](package.json:8) script from [`package.json`](package.json), which executes [`manager.ts`](manager.ts). The UI is intended to be available on port `3000` per [`README.md`](README.md:11).

### Run the MCP server directly

```bash
bun run mcp
```

This executes the [`mcp`](package.json:9) script and starts [`src/mcp/server.ts`](src/mcp/server.ts) directly.

### Useful maintenance commands

```bash
bun run lint
bun run typecheck
bun run format
bun run generate:version
bun run check:version
bun run build
bun run compile
```

- [`lint`](package.json:10): runs ESLint against [`src/`](src).
- [`typecheck`](package.json:11): runs the TypeScript compiler in no-emit mode to catch assignability and interface errors that ESLint alone will not report.
- [`format`](package.json:12): runs Prettier across the repository.
- [`generate:version`](package.json:13): regenerates [`src/version.ts`](src/version.ts) from [`package.json`](package.json) before builds.
- [`check:version`](package.json:14): regenerates [`src/version.ts`](src/version.ts) and fails if the tracked file would change, preventing version drift in CI.
- [`build`](package.json:15): builds the MCP server JS bundle into [`dist/`](dist).
- [`compile`](package.json:16): produces a standalone binary named [`relatr`](package.json:16).

### Docker workflow

The container flow is defined in [`docker-compose.yml`](docker-compose.yml) and [`Dockerfile`](Dockerfile).

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f
docker compose down
```

Notes:

- Port `3000` is exposed by [`docker-compose.yml`](docker-compose.yml:31).
- Data is persisted in the local [`data/`](docker-compose.yml:29) bind mount.
- The image compiles both [`src/mcp/server.ts`](src/mcp/server.ts) and [`manager.ts`](manager.ts) during the Docker build in [`Dockerfile`](Dockerfile:24).

## Testing Instructions

### Root project tests

The root [`package.json`](package.json) currently does **not** define a dedicated [`test`](package.json:7) script. Existing root tests live in [`src/tests/`](src/tests) and use Bun's test runner.

Run all root tests with:

```bash
bun test src/tests
```

Run a single test file with:

```bash
bun test src/tests/plugin-management.test.ts
```

Target a specific test name with:

```bash
bun test src/tests -t "plugin"
```

### Elo subproject tests

The vendored Elo package has its own scripts in [`elo/package.json`](elo/package.json).

```bash
cd elo && bun install
cd elo && bun test test/unit/
```

Important: treat [`elo/`](elo) as a nested package with its own dependency graph and scripts. Root commands do not automatically cover it.

### Expectations for changes

- Add or update tests when changing behavior in [`src/`](src) or [`elo/src/`](elo/src).
- Run lint before finalizing changes.
- If you change build, plugin, MCP, database, or trust logic, run the most relevant Bun tests in [`src/tests/`](src/tests).

## Code Style Guidelines

### Language and tooling

- TypeScript uses ESM style as indicated by [`"type": "module"`](package.json:5).
- Prefer static ESM imports such as `import { foo } from 'bar';` for runtime dependencies, and avoid dynamic `import('bar')` loading unless there is a documented, unavoidable runtime need.
- Avoid `import(...)` type-query style when a normal top-level `import type { Foo } from 'bar';` or static ESM import can express the dependency clearly.
- Linting is configured in [`eslint.config.mjs`](eslint.config.mjs).
- Formatting uses Prettier via the [`format`](package.json:11) script.

### ESLint conventions

From [`eslint.config.mjs`](eslint.config.mjs):

- prefer single quotes ([`quotes`](eslint.config.mjs:21))
- require semicolons ([`semi`](eslint.config.mjs:20))
- unused variables are errors unless prefixed with `_` ([`@typescript-eslint/no-unused-vars`](eslint.config.mjs:16))

### Repository organization

- Put production service code under [`src/`](src).
- Keep database-specific logic under [`src/database/`](src/database).
- Keep graph logic under [`src/graph/`](src/graph).
- Keep MCP-specific transport and rate-limiting code under [`src/mcp/`](src/mcp).
- Keep plugin runtime, planning, and loaders under [`src/plugins/`](src/plugins).
- Keep React UI files in [`config-ui/`](config-ui).

### Naming and edit guidance

- Match existing file naming patterns: PascalCase for service-style classes such as [`RelatrService`](src/service/RelatrService.ts) and [`DatabaseManager`](src/database/DatabaseManager.ts), camelCase for utility modules such as [`graphStats.ts`](src/capabilities/graph/graphStats.ts).
- Prefer extending existing modules instead of creating parallel abstractions.
- Avoid moving or renaming files unless necessary because several parts of the build and runtime reference concrete paths.

## Build and Deployment

### Local build outputs

```bash
bun run build
bun run compile
```

- [`build`](package.json:13) outputs bundled artifacts to [`dist/`](dist).
- [`compile`](package.json:14) creates a standalone executable for the MCP server.

### Docker publishing

GitHub Actions publishes images from [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml):

- runs on pushes to `master`
- runs on version tags matching `v*`
- publishes to GHCR using the repository name

When changing Docker packaging, verify consistency across [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml), and [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml).

## Security and Configuration Notes

- Never commit real secrets into [`.env`](.env.example) or test fixtures.
- `SERVER_SECRET_KEY` is required and must be a 64-character hex private key as documented in [`.env.example`](.env.example:8).
- Plugin execution limits are controlled by variables such as [`ELO_MAX_ROUNDS_PER_PLUGIN`](.env.example:56), [`ELO_MAX_REQUESTS_PER_ROUND`](.env.example:57), and [`ELO_MAX_TOTAL_REQUESTS_PER_PLUGIN`](.env.example:58).
- Plugin execution parallelism and degraded-mode fallback parallelism are controlled by [`ELO_PLUGIN_CONCURRENCY`](.env.example:62) and [`VALIDATION_FALLBACK_CONCURRENCY`](.env.example:151).
- Rate limiting is configurable through [`RATE_LIMIT_TOKENS`](.env.example:104) and [`RATE_LIMIT_REFILL_RATE`](.env.example:108).

## Monorepo / Nested Package Guidance

This repository is primarily a single Bun application with a nested package in [`elo/`](elo).

- Use root-level commands for the Relatr service.
- Use [`elo/package.json`](elo/package.json) scripts when working inside [`elo/`](elo).
- Keep changes scoped: do not assume root lint/build/test commands validate the Elo package.

## Pull Request Guidance

- Keep changes focused and small when possible.
- Before finalizing code changes, run at minimum [`bun run lint`](package.json:10) and [`bun run typecheck`](package.json:11) for root source changes.
- If version metadata can drift, run [`bun run check:version`](package.json:14) locally or in CI before merging.
- Run the most relevant Bun tests for the area you changed.
- If Docker packaging is affected, inspect [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml), and CI workflow alignment together.

## Debugging and Troubleshooting

- If the config UI starts but the managed service fails, inspect environment values first using [`.env.example`](.env.example) as the reference.
- If DuckDB-related errors occur, verify the configured [`DATABASE_PATH`](.env.example:164) and schema file path [`src/database/duckdb-schema.sql`](src/database/duckdb-schema.sql).
- If plugin behavior looks wrong, inspect fixtures in [`plugins/elo/`](plugins/elo) and the runtime modules in [`src/plugins/`](src/plugins).
- If containerized runs fail due to permissions, check `UID` and `GID` settings documented in [`.env.example`](.env.example:170) and used by [`docker-compose.yml`](docker-compose.yml:16).

## Agent Working Notes

- Prefer reading [`README.md`](README.md), [`.env.example`](.env.example), and [`package.json`](package.json) before making operational changes.
- When changing commands or runtime behavior, update this file as part of the same change.
- The closest `AGENTS.md` should govern future nested work; if [`elo/`](elo) starts diverging further, add a dedicated [`elo/AGENTS.md`](elo/AGENTS.md) later.
- The authoring-time capability name surface now lives in [`relo/src/catalog.ts`](relo/src/catalog.ts:138), including shared runtime-facing constants via [`RELATR_CAPABILITIES`](relo/src/catalog.ts:403).
- [`relatr`](package.json) should consume [`relo`](relo/package.json) for shared capability names and validation metadata, while keeping runtime handler wiring and policy local in [`src/capabilities/capability-catalog.ts`](src/capabilities/capability-catalog.ts:10), [`src/capabilities/registerBuiltInCapabilities.ts`](src/capabilities/registerBuiltInCapabilities.ts:33), and [`src/capabilities/CapabilityExecutor.ts`](src/capabilities/CapabilityExecutor.ts:27).
