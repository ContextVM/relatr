# relatr

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
