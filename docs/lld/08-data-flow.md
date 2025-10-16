# Low-Level Design: Data Flow and Module Interactions

## Overview

This document describes how data flows through Relatr's modules when computing a trust score, from MCP request to final response.

## High-Level Flow

```
MCP Request → RelatrService → [Social Graph + Metrics + Distance] → Trust Calculator → Response
```

## Detailed Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ MCP Client                                                              │
│ calculate_trust_score(targetPubkey, sourcePubkey?, scheme?)            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ MCP Server (server.ts)                                                  │
│ • Validates input schema                                                │
│ • Calls RelatrService                                                   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ RelatrService                                                           │
│ • Orchestrates all modules                                              │
│ • Manages service lifecycle                                             │
└────────┬────────────┬────────────┬────────────┬─────────────────────────┘
         │            │            │            │
         ▼            ▼            ▼            ▼
    ┌────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐
    │ Graph  │  │Distance │  │ Metrics │  │  Trust   │
    │Manager │  │Normalizer│ │Collector│  │Calculator│
    └────────┘  └─────────┘  └─────────┘  └──────────┘
```

## Step-by-Step Flow

### 1. Request Reception
**Input:** MCP tool call with `targetPubkey`, optional `sourcePubkey`, `scheme`
```typescript
{
  targetPubkey: "84dee6e676...",
  sourcePubkey: "020f2d21ae...",  // Optional, defaults to env var
  scheme: "default"
}
```

### 2. Service Initialization (One-time)
```
RelatrService.initialize()
├── Load social graph binary → SocialGraphManager
├── Initialize distance normalizer → DistanceNormalizer  
├── Connect to Nostr relays → ProfileMetricsCollector
└── Open SQLite database → MetricsCache + TrustScoreCache
```

### 3. Social Graph Distance
```
SocialGraphManager
├── Switch root if needed: setRoot(sourcePubkey)
├── Query distance: getFollowDistance(targetPubkey)
└── Returns: integer hop count (0, 1, 2, ..., 1000)
```

**Output:** `distance = 3` (example)

### 4. Distance Normalization
```
DistanceNormalizer
├── Input: distance = 3
├── Apply formula: weight = max(0, 1 - 0.1 × (3 - 1))
└── Returns: 0.8
```

**Output:** `distanceWeight = 0.8`

### 5. Profile Metrics Collection
```
ProfileMetricsCollector
├── Check cache (MetricsCache.get(targetPubkey))
│   └── If valid cache: return cached metrics
├── If not cached or expired:
│   ├── Fetch profile (kind 0) from relays
│   ├── Nip05Validator.validate(profile) → 0.0 or 1.0
│   ├── LightningValidator.validate(profile) → 0.0 or 1.0
│   ├── EventValidator.hasEventKind(10002) → 0.0 or 1.0
│   └── ReciprocityValidator.check(source, target) → 0.0 or 1.0
└── Save to cache (MetricsCache.save())
```

**Output:**
```typescript
{
  nip05Valid: 1.0,
  lightningAddress: 1.0,
  eventKind10002: 0.0,
  reciprocity: 1.0
}
```

### 6. Trust Score Calculation
```
TrustScoreCalculator
├── Check cache (TrustScoreCache.get(source, target))
│   └── If valid cache: return cached score
├── If not cached:
│   ├── Apply weighting scheme (default/conservative/etc)
│   ├── Compute: Σ(w_i × v_i^p_i) / Σ(w_i)
│   │   ├── distanceWeight: 0.8 × weight(0.5) = 0.40
│   │   ├── nip05Valid: 1.0 × weight(0.15) = 0.15
│   │   ├── lightning: 1.0 × weight(0.10) = 0.10
│   │   ├── kind10002: 0.0 × weight(0.10) = 0.00
│   │   └── reciprocity: 1.0 × weight(0.15) = 0.15
│   ├── Sum: (0.40 + 0.15 + 0.10 + 0.00 + 0.15) / 1.0 = 0.80
│   └── Save to cache (TrustScoreCache.save())
└── Return: score = 0.80
```

### 7. Response Formation
```
RelatrService
├── Aggregate all results
└── Format response
```

**Output:**
```typescript
{
  score: 0.80,
  sourcePubkey: "020f2d21ae...",
  targetPubkey: "84dee6e676...",
  metrics: {
    distance: 3,
    distanceWeight: 0.8,
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    eventKind10002: 0.0,
    reciprocity: 1.0
  },
  computedAt: 1734354789,
  cached: false
}
```

## Data Dependencies

```
Trust Score
    ├─ Distance Weight (from Social Graph)
    │   └─ Requires: Social graph binary file
    │
    └─ Profile Metrics (from Nostr relays)
        ├─ NIP-05 (from profile kind 0)
        ├─ Lightning (from profile kind 0)
        ├─ Event Kind 10002 (from relay query)
        └─ Reciprocity (from social graph OR relay query)
```

## Caching Strategy

### Level 1: Profile Metrics Cache (SQLite)
- **TTL:** 1 hour (configurable)
- **Key:** `targetPubkey`
- **Invalidation:** Time-based or manual

### Level 2: Trust Score Cache (SQLite)
- **TTL:** 1 hour (configurable)
- **Key:** `(sourcePubkey, targetPubkey)`
- **Invalidation:** Time-based, profile update, or manual

### Level 3: Social Graph (In-Memory + File)
- **Persistence:** Binary file
- **Updates:** Periodic re-generation (external process)
- **Hot Reload:** Optional event streaming

## Error Handling Flow

```
Any Module Error
    ↓
Propagate to RelatrService
    ↓
Catch and format error
    ↓
Return to MCP Server
    ↓
{
  isError: true,
  content: "Error description"
}
```

## Performance Characteristics

| Operation | Typical Latency | Cache Hit |
|-----------|----------------|-----------|
| Social graph distance | < 1ms | N/A (in-memory) |
| Distance normalization | < 0.1ms | N/A (pure function) |
| Profile metrics | 100-500ms | < 5ms |
| Trust score | 1-5ms | < 5ms |
| **Total (cold)** | **~500ms** | - |
| **Total (warm)** | **~10ms** | ✅ |

## Parallel vs Sequential Operations

### Parallel (within ProfileMetricsCollector)
- NIP-05 validation
- Lightning validation  
- Event kind check
- Reciprocity check

**Benefit:** 4× faster than sequential

### Sequential (between modules)
1. Social graph distance
2. Distance normalization
3. Profile metrics (parallel internally)
4. Trust score calculation

## Module Communication

All modules are **loosely coupled** via:
- **Interfaces:** TypeScript type definitions
- **Service Layer:** RelatrService orchestrates
- **No Direct Calls:** Modules don't import each other
- **Dependency Injection:** Configuration passed at initialization

## State Management

### Stateful Components
- `SocialGraphManager`: Holds graph in memory
- `Database`: Persistent cache
- `SimplePool`: Nostr relay connections

### Stateless Components
- `DistanceNormalizer`: Pure functions
- `TrustScoreCalculator`: Pure calculation
- All validators: No internal state

## Initialization Sequence

```
1. Load .env configuration
2. Open SQLite database
3. Initialize schema (if needed)
4. Load social graph binary
5. Initialize Nostr relay pool
6. Create service instances
7. Start MCP server
8. Ready to accept requests
```

## Cleanup Sequence

```
1. Stop accepting new requests
2. Close Nostr relay connections
3. Save social graph (if modified)
4. Close database connections
5. Exit process
```

## Summary

The data flow is **linear with caching layers**:
1. Request → Service orchestration
2. Parallel metric collection (with caching)
3. Sequential computation (distance → metrics → score)
4. Response with comprehensive breakdown

**Key Design Principles:**
- ✅ Modular: Each component has single responsibility
- ✅ Cacheable: Multiple caching layers for performance
- ✅ Parallel: Metrics collected concurrently
- ✅ Resilient: Graceful error handling at each layer
- ✅ Observable: Complete metric breakdown in response