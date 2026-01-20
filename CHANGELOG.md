# relatr

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
