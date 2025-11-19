# DuckDB Migration Plan

## Overview

This document outlines the plan to migrate the Relatr service from a hybrid SQLite/DuckDB architecture to a unified DuckDB-based architecture. This change leverages the `nostr-social-duck` library's capabilities and DuckDB's analytical power to improve performance, simplify the codebase, and enable more sophisticated queries.

## Rationale

The current architecture maintains two separate databases:
1.  **SQLite (`bun:sqlite`):** Used for caching profile metrics, metadata, and application settings. It handles Full-Text Search (FTS5) for profile discovery.
2.  **DuckDB (`nostr-social-duck`):** Used exclusively for social graph analysis (shortest paths, distances).

**Problems with the current approach:**
*   **Inefficient Search:** `searchProfiles` queries SQLite for matching profiles (limit 500) and *then* calculates trust scores/distances for each. This "fetch-then-filter" approach is slow and arbitrary.
*   **Data Silos:** Metadata and social graph data reside in different engines, preventing efficient joins (e.g., "Find users named 'Alice' within 2 hops").
*   **Redundancy:** Managing two database connections and files increases complexity and resource usage.
*   **Performance Bottlenecks:** Single-row inserts in SQLite for metadata fetching are slower than DuckDB's columnar batch operations.

## Advantages of Unified DuckDB Architecture

1.  **Single Source of Truth:** All data (social graph, metadata, metrics) resides in one high-performance analytical database.
2.  **Optimized Queries:** We can perform complex queries that combine text search and graph traversal in a single SQL operation.
    *   *Example:* `SELECT * FROM metadata WHERE match_bm25(name, 'alice') AND pubkey IN (SELECT followed_pubkey FROM nsd_follows ...)`
3.  **High-Performance Batching:** DuckDB excels at bulk data ingestion, significantly speeding up metadata syncing.
4.  **Simplified Codebase:** Removes `bun:sqlite` dependency and associated boilerplate.
5.  **Future-Proofing:** DuckDB's analytical features (aggregations, window functions) enable advanced trust metric calculations that would be slow or impossible in SQLite.

## Implementation Plan

### 1. Centralized Connection Management

We will create a `DuckDBConnection` manager to handle the lifecycle of the DuckDB instance. This connection will be shared across the application.

*   **Action:** Create `src/database/duckdb-connection.ts`
*   **Responsibility:** Initialize the database, load extensions (FTS), and provide access to the raw connection.

### 2. Schema Migration

We will port the existing SQLite schema to DuckDB, utilizing its specific features.

*   **Action:** Create `src/database/duckdb-schema.sql`
*   **Changes:**
    *   `profile_metrics`: Standard table.
    *   `pubkey_metadata`: Use DuckDB's FTS extension (`PRAGMA create_fts_index`) instead of SQLite's FTS5 virtual table.
    *   `settings`: Standard table.

### 3. Component Updates

#### A. SocialGraph (`src/graph/SocialGraph.ts`)
*   **Change:** Update `initialize` to accept an existing DuckDB connection.
*   **Method:** Use `DuckDBSocialGraphAnalyzer.connect(connection)` instead of `create()`.

#### B. DataStore (`src/database/data-store.ts`)
*   **Change:** Rewrite to use `@duckdb/node-api` instead of `bun:sqlite`.
*   **Key Updates:**
    *   Replace `db.query().get()`/`run()` with DuckDB's prepared statements.
    *   Implement `match_bm25` queries for text search.
    *   Add `batchSet` method for efficient bulk inserts.

#### C. PubkeyMetadataFetcher (`src/graph/PubkeyMetadataFetcher.ts`)
*   **Change:** Update `storeProfileMetadata` to use the new `batchSet` method from `DataStore`.

#### D. RelatrService (`src/service/RelatrService.ts`)
*   **Change:**
    *   Initialize `DuckDBConnection` first.
    *   Pass connection to `SocialGraph` and `DataStore`.
    *   **Refactor `searchProfiles`:** Implement a single optimized query that joins metadata search results with social graph distance data (if possible via `nostr-social-duck` tables) or at least executes the search on the same connection to avoid overhead.

### 4. Search Optimization Strategy

Instead of the arbitrary 500 limit, we will leverage DuckDB's FTS and the existing social graph tables (`nsd_follows`) to perform a targeted search.

**Proposed Query Logic:**
```sql
SELECT
    m.pubkey,
    m.name,
    fts_main_pubkey_metadata.match_bm25(m.pubkey, ?) AS relevance_score
FROM pubkey_metadata m
WHERE relevance_score IS NOT NULL
-- Potential to join with graph data here for filtering by distance
ORDER BY relevance_score DESC
LIMIT ?
```
*Note: We will explore joining with `nsd_follows` to prioritize users within the social graph.*

## Migration Steps

1.  **Create Schema & Connection:** Set up the foundation.
2.  **Update SocialGraph:** Enable shared connection usage.
3.  **Refactor DataStore:** Port logic to DuckDB.
4.  **Update Service:** Wire everything together.
5.  **Optimize Search:** Implement the new query logic.
6.  **Cleanup:** Remove SQLite dependencies and old files.
