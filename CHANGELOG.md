# relatr

## 0.2.8

### Patch Changes

- feat(validation): add force refresh for metric keys when plugin revisions change

## 0.2.7

### Patch Changes

- feat: add graph.degree_histogram to catalog

## 0.2.6

### Patch Changes

- feat(graph): add degree capability to get in/out follower counts

  Add graph.degree capability that returns outDegree and inDegree counts
  for a given pubkey. Includes implementation in SocialGraph, capability
  registration, argument contracts, and documentation.

## 0.2.5

### Patch Changes

- refactor(search): decouple trust scores from text relevance in ranking

  Separate trust score calculation from text relevance scoring to ensure
  search results are primarily ranked by trust. The trust score now remains
  independent while a separate rankingScore incorporates relevance for
  tie-breaking. Also stabilizes the candidate window to a fixed limit
  regardless of output limit, ensuring consistent ranking behavior.

## 0.2.4

### Patch Changes

- feat(search): enhance search with lud16/about fields and capped plugin scoring

- Add lud16 and about fields to search relevance scoring with configurable weights
- Refactor MetadataRepository to extract search score constants and improve exact match detection
- Cap plugin contribution to non-distance score budget in TrustCalculator (0.4 weight)
- Reduce exact match boost from 1.15x to 1.05x to prevent over-ranking
- Add new search-service.test.ts with comprehensive test coverage
- Update @contextvm/sdk to ^0.8.0 and @noble/hashes to 2.0.1
- Disable oversizedTransfer in MCP server config

## 0.2.3

### Patch Changes

- feat(plugins): add official ELO scoring plugins and auto-create directory

  Add nine new official ELO scoring plugins (activity_notes, inbound_zaps, nip05_valid, nostr_native_identity, outbound_zaps, reciprocity_mutual, relay_list_kind10002, root_nip05) that score based on Nostr events and profile data. Also fix PortablePluginLoader to gracefully handle missing plugin directories by creating them automatically instead of throwing ENOENT errors. Updated tests to use dynamic HOST_VERSION for compatibility.

## 0.2.2

### Patch Changes

- feat(plugins): add configurable plugin execution concurrency and in-flight request deduplication

Adds ELO_PLUGIN_CONCURRENCY and VALIDATION_FALLBACK_CONCURRENCY environment variables to control parallelism. Plugins now run concurrently up to the configured limit, and in-flight capability requests are deduplicated across concurrent plugins to avoid redundant execution. Also optimizes validation batch execution with O(1) profile lookups and caches metric fact dependencies in the engine runtime.

## 0.2.1

### Patch Changes

- feat(metrics): add getStoredMetrics method for returning cached metrics without recomputing
  - Add new getStoredMetrics method to MetricsValidator that returns cached metrics when plugin coverage is partial without triggering recomputation
  - Make validation sync non-blocking in SchedulerService to prevent blocking service startup
  - Reduce cache TTL from 168h (1 week) to 72h (3 days) in configuration
  - Update SearchService to return zeroed scores on batch failure instead of falling back to individual scoring
  - Remove expires_at filtering from MetricsRepository queries to always return stored metrics
  - Update version to 0.2.0 and plugin version tags to ^0.2.0

## 0.2.0

### Minor Changes

This release introduces **Elo Plugins**, a portable plugin system for extending relatr's trust metric calculation with custom validation logic written in the Elo expression language.

- feat(plugins): replace TypeScript validators with Elo portable plugins
  - Add new plugin architecture using kind 765 Nostr events for plugin distribution
  - Implement `EloPluginEngine` for runtime execution of Elo-based validators
  - Add `PluginManager` for plugin lifecycle management (install, uninstall, enable/disable)
  - Introduce `PortablePluginLoader` for loading plugins from Nostr relays or local filesystem
  - Add `PlanningStore` for caching plugin planning results
  - Implement plugin deduplication and namespaced metrics to avoid collisions across authors

- feat(plugins): implement v1 plugin program format with multi-round chaining
  - Replace v0 RELATR blocks with explicit `plan`/`then` rounds and `do` syntax
  - Add host policy limits (max rounds, requests per round, total requests per plugin)
  - Enforce strict JSON boundary for capability arguments with clear failure semantics
  - Add capability run cache for cross-pubkey deduplication during validation runs
  - Support semver range for plugin host compatibility checks

- feat(plugins): implement Nostr event format with single-letter 'n' tag
  - Plugin names use the 'n' tag for better relay indexing (kind 765 events)
  - Add comprehensive event format, tag schema, and versioning documentation

- feat(relo): introduce @contextvm/relo package for shared capability definitions
  - New workspace package providing authoring-time capability definitions
  - Exposes `RELATR_CAPABILITIES`, `RELATR_CAPABILITY_DEFINITIONS`, and validation functions
  - Runtime imports capability names from this shared package for consistency

- feat(relo): add CLI for building, checking, and publishing Relatr plugins
  - `relo build`: Create canonical plugin artifacts from source or event JSON, with optional signing
  - `relo check`: Validate raw ELO source or plugin event JSON artifacts
  - `relo publish`: Publish signed plugin events to Nostr relays

- feat(validation): implement persistent NIP-05 caching and batch evaluation
  - Add `Nip05CacheStore` for persistent resolution caching with configurable TTL
  - Add domain cooldown tracking for failed NIP-05 lookups
  - Implement batch evaluation in `EloPluginEngine` for concurrent pubkey processing
  - Add `ValidationPipeline` with explicit fact refresh and scoring stages
  - New config options: `nip05ResolveTimeoutMs`, `nip05CacheTtlSeconds`, `nip05DomainCooldownSeconds`

- feat: add graph distance capabilities and validation pipeline improvements
  - Add three new graph capabilities: `graph.distance_from_root`, `graph.distance_between`, `graph.users_within_distance`
  - Implement graph bootstrap signature tracking to reuse existing graphs
  - Add fact-dependencies system to skip unnecessary refresh stages
  - Add batch operations to NIP-05 cache store

- feat: add validator warm-up system and relatr-web submodule
  - Validator warm-up triggers metric validation when plugins are enabled
  - Add validation coalescing and early exit when no validators are configured
  - New `relatr-web` Svelte 5 UI package for configuration management

- feat(mcp): add version tracking and admin check to stats tool
  - Add `HOST_VERSION` to stats output
  - Include `isAdmin` flag based on client pubkey matching admin pubkeys
  - Auto-generated `src/version.ts` from package.json

- refactor: consolidate validation pipeline and metrics validation
  - Add `ValidationRunContext` for shared execution state
  - Refactor `ValidationBatchExecution` with improved scheduling
  - Move metrics validation logic into dedicated `MetricsValidator`
  - Extract `RelayProfileFetcher` for profile fetching concerns

- build(deps): update elo dependency from @enspirit to @contextvm
  - Updated `@contextvm/elo` package with improved type safety
  - Updated `@contextvm/sdk` to v0.7.x
  - Updated TypeScript to 5.x with stricter compiler options
  - Updated react/react-dom to 19.x, prettier to 3.x, nostr-tools to 2.20.0

### Breaking Changes

- Plugin name tag changed from `name` to `n` for relay indexing
- Plugin format changed from v0 RELATR blocks to v1 multi-round programs with `plan`/`then` syntax
- Old TypeScript-based validators are no longer supported; plugins must use Elo expression language
- The `relatr-version` manifest field now requires a caret semver range (e.g., `^0.2.0`)

## 0.1.22

### Patch Changes

- chore: bump deps

## 0.1.20

### Patch Changes

- build(deps): update dependencies including @contextvm/sdk major version bump

## 0.1.19

### Patch Changes

- chore(deps): update dependencies

## 0.1.18

### Patch Changes

- chore(deps): update @contextvm/sdk to 0.2.7

## 0.1.17

### Patch Changes

- fix(ta): skip TA publish for rank 0

## 0.1.16

### Patch Changes

- feat: add capping config and update rate limit defaults

## 0.1.15

### Patch Changes

- 51af2ba: chore: bump cvm version

## 0.1.14

### Patch Changes

- chore(deps): bump dependencies, adapt code

## 0.1.13

### Patch Changes

- feat(ta): add support for extra relays in TA configuration

## 0.1.12

### Patch Changes

- f4dcb50: chore: bump versions
- refactor(service): consolidate trust score calculation with lazy refresh control

Remove calculateTrustScoreInternal method and add enableLazyRefresh parameter

## 0.1.5

### Patch Changes

- feat: streaming data patterns
  - This change introduces streaming to fetch pubkey metadata, avoiding memory accumulation and enabling scaling to larger network sizes. Events are processed immediately via onBatch callback and stored in database, preventing O(n) memory scaling with network size.

## 0.1.4

### Patch Changes

- fix(deps): update nostr-social-duck to v0.1.24

## 0.1.3

### Patch Changes

- fix: init performance

## 0.1.2

### Patch Changes

- feat(db): batch save and validate profile metadata

## 0.1.1

### Patch Changes

- refactor: improve error handling, initialization and logging

## 0.1.0

### Minor Changes

- feat: duckdb migration init

  refactor(database): replace data-store with repository pattern and singleton manager
  - Replace monolithic DataStore class with specialized repositories:
    - MetadataRepository for pubkey metadata operations
    - MetricsRepository for profile metrics with TTL support
    - SettingsRepository for configuration storage
  - Implement DatabaseManager singleton for centralized database lifecycle management
  - Update all dependent services to use new repository pattern:
    - RelatrService now uses repositories instead of direct DataStore access
    - PubkeyMetadataFetcher uses MetadataRepository for profile storage
    - MetricsValidator uses MetricsRepository with proper TTL handling
    - Tests updated to use DatabaseManager singleton
  - Remove legacy data-store.ts file and its complex caching logic
  - Improve error handling with specific DatabaseError types
  - Add proper connection lifecycle management with graceful shutdown
  - Maintain backward compatibility while modernizing architecture

  feat: implement multi-connection database management for transaction isolation
  - Add connection tracking with Set to manage multiple DuckDB connections
  - Create createConnection() method for isolated transaction contexts
  - Update initialization logic to use separate connections for different components
  - Improve connection cleanup in close() method to handle all tracked connections
  - Maintain backward compatibility with existing getConnection() method

  feat: implement multi-connection database management for transaction isolation
  - Add connection tracking with Set to manage multiple DuckDB connections
  - Create createConnection() method for isolated transaction contexts
  - Update initialization logic to use separate connections for different components
  - Improve connection cleanup in close() method to handle all tracked connections
  - Maintain backward compatibility with existing getConnection() method

  refactor: use shared DuckDB connection for all components, improved search algorithm

  feat(core): optimize batch validation and distance calculation

  Improves performance by batching validation and distance calculations,
  leveraging DuckDB's capabilities for efficiency. Includes caching
  of weights and distances to reduce redundant computations.

  feat(graph): add areMutualFollows method, cleanup types

  feat(relatr): improve performance and reliability

  refactor(relatr): increase batch size for validation sync

  refactor: extract services and update dependencies
  - Extract scheduling and background tasks into SchedulerService
  - Extract search functionality into SearchService
  - Define service interfaces for better separation of concerns
  - Refactor MetricsRepository for improved performance
  - Update dependencies: nostr-social-duck, nostr-tools, @types/react
  - Remove @modelcontextprotocol/sdk dependency
  - Clean up RelatrService by delegating to specialized services

  chore: add ESLint configuration and TypeScript support

  This commit introduces ESLint with TypeScript support to the project. The changes include:
  - Adding ESLint, TypeScript ESLint, and related dependencies
  - Creating an ESLint configuration file that extends recommended rules and integrates with Prettier
  - Adding a lint script to package.json
  - Fixing code issues identified by ESLint (unused variables, type safety, error handling, etc.)
  - Updating dependencies to their latest versions

## 0.0.12

### Patch Changes

- fix(service): adjust db result limit and remove top relevant profiles slicing

## 0.0.11

### Patch Changes

- fix: limit to 700 results from db

## 0.0.10

### Patch Changes

- fix: revert validation ttl

## 0.0.9

### Patch Changes

- feat(service): add relevance scoring to profile search

  Introduces relevance scoring based on profile fields, refactors scoring logic to include relevance multipliers, and adjusts queries to remove TTL checks. Also makes extendToNostr optional in parameters and adds validation sync interval to test config

## 0.0.8

### Patch Changes

- fix: improve docker tag naming convention

## 0.0.7

### Patch Changes

- feat(service): optimize Nostr search and caching logic

## 0.0.6

### Patch Changes

- feat(service): add validation sync straight on initialization

## 0.0.5

### Patch Changes

- feat(backend): add validation sync and social graph improvements
  - Add periodic validation sync for pubkeys missing validation scores
  - Implement discovery queue system for processing contact events
  - Add binary graph persistence functionality
  - Update configuration with validation sync interval (3 hours default)
  - Add sizeByDistance stats to social graph tracking
  - Enhance relay configuration with additional relay URLs
  - Update build targets and entry points in package.json

  This enables background validation processing and improves social graph management through new async processes and persistence capabilities.

## 0.0.4

### Patch Changes

- refactor(server): refactor server public key retrieval, remove precomputed social graph
- 0b98a40: Fix stats tool returning extra fields
- Add a http config UI ([#4](https://github.com/ContextVM/relatr/issues/4))

## 0.0.3

### Patch Changes

- feat(nostr): add support for npub/nprofile pubkey formats and reorganize utils

## 0.0.2

### Patch Changes

- feat(mcp): replace health check with comprehensive stats tool

  This change replaces the basic health check functionality with a detailed statistics tool that provides comprehensive information about the service including database metrics, social graph statistics, and source public key. The new stats tool offers more insight into service health and performance than the previous health check endpoint.
