# Low-Level Design: Caching and Update Strategy

## Overview

Relatr implements a multi-layer caching strategy to minimize expensive operations (relay queries, graph recalculations) while maintaining data freshness.

## Cache Layers

### Layer 1: In-Memory Social Graph
**Component:** `SocialGraphManager`
- **Data:** Complete social graph structure
- **Source:** Pre-computed binary file (`socialGraph.bin`)
- **Refresh:** External process (daily/weekly)
- **Access Time:** < 1ms
- **No TTL:** Persistent in memory until restart

### Layer 2: Profile Metrics (SQLite)
**Component:** `MetricsCache`
- **Data:** NIP-05, Lightning, Event Kind 10002, Reciprocity
- **Key:** `pubkey`
- **TTL:** 1 hour (configurable)
- **Invalidation:** Time-based, manual

**Schema:**
```sql
profile_metrics(pubkey_id, metric_id, value, computed_at, expires_at)
```

### Layer 3: Trust Scores (SQLite)
**Component:** `TrustScoreCache`
- **Data:** Final trust scores with metric snapshots
- **Key:** `(source_pubkey, target_pubkey, formula_version)`
- **TTL:** 1 hour (configurable)
- **Invalidation:** Time-based, profile update, formula change

**Schema:**
```sql
trust_scores(source_pubkey_id, target_pubkey_id, score, metric_weights, metric_values, expires_at)
```

## Cache Decision Tree

```
Request for trust score
    │
    ├─ Check TrustScoreCache
    │   ├─ Hit & Valid → Return cached score ✅
    │   └─ Miss/Expired → Continue
    │
    ├─ Check ProfileMetricsCache
    │   ├─ Hit & Valid → Use cached metrics
    │   └─ Miss/Expired → Fetch from relays
    │
    ├─ Query SocialGraph (always fresh, in-memory)
    │
    ├─ Calculate trust score
    │
    └─ Save to both caches
```

## TTL Configuration

```typescript
// src/config/cache.ts
export const CacheConfig = {
    profileMetrics: {
        ttl: parseInt(process.env.PROFILE_METRICS_TTL || '3600', 10), // 1 hour
        maxAge: 86400, // 24 hours absolute max
    },
    trustScores: {
        ttl: parseInt(process.env.TRUST_SCORES_TTL || '3600', 10), // 1 hour
        maxAge: 86400,
    },
};
```

## Cache Invalidation Strategies

### 1. Time-Based (Passive)
Automatically expire after TTL. Database query filters:
```sql
WHERE expires_at IS NULL OR expires_at > unixepoch()
```

### 2. Event-Based (Active)
Invalidate when relevant Nostr events detected:
```typescript
// Optional: Listen for profile updates
pool.subscribe(relays, { kinds: [0], authors: [pubkey] }, {
    onevent: async (event) => {
        await metricsCache.invalidate(event.pubkey);
        await trustScoreCache.invalidateAll(event.pubkey);
    }
});
```

### 3. Manual (API)
Force refresh via `forceRefresh` parameter:
```typescript
await relatrService.calculateTrustScore({
    targetPubkey,
    sourcePubkey,
    forceRefresh: true  // Bypass all caches
});
```

## Cleanup Strategy

### Periodic Cleanup (Background Task)
```typescript
// scripts/cleanup-cache.ts
setInterval(async () => {
    // Remove expired entries
    db.exec("DELETE FROM profile_metrics WHERE expires_at < unixepoch()");
    db.exec("DELETE FROM trust_scores WHERE expires_at < unixepoch()");
    
    // Vacuum to reclaim space
    db.exec("VACUUM");
}, 3600000); // Every hour
```

### Max Age Enforcement
```sql
-- Remove entries older than 24 hours regardless of expiry
DELETE FROM profile_metrics 
WHERE computed_at < unixepoch() - 86400;
```

## Cache Warming

### On-Demand Warming
```typescript
// Warm cache for important pubkeys
async function warmCache(pubkeys: string[], sourcePubkey: string) {
    for (const targetPubkey of pubkeys) {
        await relatrService.calculateTrustScore({
            targetPubkey,
            sourcePubkey,
        });
    }
}
```

### Predictive Warming
```typescript
// Warm based on social graph proximity
async function warmFollows(sourcePubkey: string) {
    const follows = graphManager.getFollowedBy(sourcePubkey);
    await warmCache(follows, sourcePubkey);
}
```

## Social Graph Updates

### Option 1: Periodic Re-generation (Recommended)
```bash
# Cron job (daily at 2 AM)
0 2 * * * bun run scripts/crawl-graph.ts
```

**Script:** `scripts/crawl-graph.ts`
```typescript
import { SocialGraph } from 'nostr-social-graph';
import { SimplePool } from 'nostr-tools/pool';

const pool = new SimplePool();
const graph = new SocialGraph(process.env.DEFAULT_SOURCE_PUBKEY!);

// Fetch recent follow events
const events = await pool.querySync(relays, {
    kinds: [3],
    since: Math.floor(Date.now() / 1000) - 86400 * 7, // Last week
});

// Update graph
for (const event of events) {
    graph.handleEvent(event, false);
}
await graph.recalculateFollowDistances();

// Save new binary
const binary = await graph.toBinary();
await Bun.write('data/socialGraph.bin', binary);
```

### Option 2: Real-time Updates (Optional)
```typescript
// Subscribe to follow events
pool.subscribe(relays, { kinds: [3] }, {
    onevent: async (event) => {
        await graphManager.handleFollowEvent(event);
    }
});

// Auto-save periodically
setInterval(() => graphManager.persist(), 300000); // 5 min
```

## Cache Performance Metrics

### Monitoring
```typescript
class CacheStats {
    hits = 0;
    misses = 0;
    
    recordHit() { this.hits++; }
    recordMiss() { this.misses++; }
    
    getHitRate() {
        const total = this.hits + this.misses;
        return total > 0 ? this.hits / total : 0;
    }
}

// Usage in cache
if (cached) {
    stats.recordHit();
    return cached;
}
stats.recordMiss();
```

### Target Metrics
- **Profile Metrics Hit Rate:** > 70%
- **Trust Score Hit Rate:** > 60%
- **Average Query Time (warm):** < 10ms
- **Average Query Time (cold):** < 500ms

## Database Indexing for Cache Performance

```sql
-- Critical indexes for cache lookups
CREATE INDEX idx_profile_metrics_expires ON profile_metrics(expires_at);
CREATE INDEX idx_trust_scores_expires ON trust_scores(expires_at);
CREATE INDEX idx_pubkeys_pubkey ON pubkeys(pubkey);

-- Composite indexes for common queries
CREATE INDEX idx_trust_scores_lookup 
ON trust_scores(source_pubkey_id, target_pubkey_id, formula_version);
```

## Cache Size Management

### Estimated Sizes
- **Social Graph:** 50-200 MB (in-memory)
- **Profile Metrics:** ~100 bytes × cached pubkeys
- **Trust Scores:** ~200 bytes × cached pairs

### Limits
```typescript
const CacheLimits = {
    maxCachedPubkeys: 10000,
    maxCachedScores: 50000,
    maxDatabaseSize: 500 * 1024 * 1024, // 500 MB
};
```

### Eviction Policy
LRU (Least Recently Used) based on `updated_at`:
```sql
-- Keep only most recent 10k pubkeys
DELETE FROM profile_metrics 
WHERE pubkey_id IN (
    SELECT pubkey_id FROM profile_metrics 
    ORDER BY updated_at ASC 
    LIMIT (SELECT COUNT(*) - 10000 FROM profile_metrics)
);
```

## Summary

**Cache Strategy:**
- ✅ 3-layer caching (in-memory graph, SQLite metrics, SQLite scores)
- ✅ Time-based TTL (1 hour default)
- ✅ Optional event-based invalidation
- ✅ Manual force-refresh capability
- ✅ Periodic cleanup and vacuum
- ✅ Social graph updates via external process

**Benefits:**
- 🚀 50× faster responses (warm cache)
- 💰 Reduced relay load
- 📊 Predictable performance
- 🔄 Fresh data within TTL window