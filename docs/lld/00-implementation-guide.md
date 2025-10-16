# Implementation Entry Point: Relatr

## Overview

This document provides a sprint-based implementation roadmap for Relatr. Each sprint delivers a testable, demoable feature while building progressively toward the complete system.

## Prerequisites

Before starting implementation:
1. Review the [High-Level Design](../hdd.md)
2. Set up development environment with Bun.js
3. Install dependencies: `nostr-tools`, `nostr-social-graph`, `@modelcontextprotocol/sdk`
4. Prepare a sample social graph binary file for testing

## Implementation Sprints

### Sprint 0: Project Foundation
**Goal:** Set up project structure and configuration

**Tasks:**
1. Create directory structure per [07-project-structure.md](./07-project-structure.md)
2. Initialize `package.json` with dependencies
3. Set up TypeScript configuration
4. Implement environment configuration loader per [10-configuration.md](./10-configuration.md)
5. Create `.env.example` template

**Testable Output:**
- Configuration loads successfully
- Environment validation works
- Project builds without errors

**Demo:**
```bash
bun run src/config/environment.ts
# Should output: "Configuration loaded successfully"
```

---

### Sprint 1: Database Layer
**Goal:** Implement SQLite database with schema

**Reference:** [01-database-schema.md](./01-database-schema.md)

**Tasks:**
1. Create `src/database/schema.sql` with all table definitions
2. Implement database initialization script in `scripts/init-db.ts`
3. Create helper utilities for common database operations
4. Write unit tests for database operations

**Testable Output:**
- Database creates successfully with all tables
- Indexes are created
- Sample data can be inserted and queried

**Demo:**
```bash
bun run scripts/init-db.ts
# Then verify tables exist:
sqlite3 data/relatr.db ".tables"
```

---

### Sprint 2: Distance Normalization (Standalone)
**Goal:** Implement distance-to-weight conversion

**Reference:** [03-distance-normalization.md](./03-distance-normalization.md)

**Tasks:**
1. Implement `DistanceNormalizer` class
2. Implement `DecayProfiles` with pre-defined configurations
3. Write comprehensive unit tests
4. Create visualization script for decay curves

**Testable Output:**
- Distance normalization with different decay factors
- Edge cases handled (distance 0, 1, 1000)
- All decay profiles work correctly

**Demo:**
```typescript
const normalizer = new DistanceNormalizer();
console.log(normalizer.normalize(3)); // Should output: 0.8
console.log(normalizer.generateDecayCurve(10));
```

---

### Sprint 3: Social Graph Integration
**Goal:** Load and query pre-computed social graph

**Reference:** [02-social-graph-integration.md](./02-social-graph-integration.md)

**Tasks:**
1. Implement `GraphPersistence` for binary loading
2. Implement `SocialGraphManager` with initialization
3. Add distance query methods
4. Test with sample graph binary
5. Write unit tests

**Testable Output:**
- Load pre-computed social graph from binary
- Query distances between pubkeys
- Switch root and recalculate distances
- Serialize/deserialize graph

**Demo:**
```typescript
const manager = new SocialGraphManager({
    rootPubkey: 'test-pubkey',
    graphBinaryPath: 'test-data/graph.bin'
});
await manager.initialize();
const distance = manager.getFollowDistance('target-pubkey');
console.log(`Distance: ${distance} hops`);
```

---

### Sprint 4: Profile Metrics - NIP-05 & Lightning
**Goal:** Implement basic profile validation

**Reference:** [04-profile-validation-metrics.md](./04-profile-validation-metrics.md)

**Tasks:**
1. Implement `Nip05Validator` using `nostr-tools/nip05`
2. Implement `LightningValidator`
3. Implement `MetricsCache` for database caching
4. Write unit tests with mock relays
5. Test with real Nostr relays

**Testable Output:**
- Validate NIP-05 identifiers
- Detect Lightning addresses
- Cache results in database
- TTL expiration works

**Demo:**
```typescript
const validator = new Nip05Validator();
const isValid = await validator.validateWithPubkey('user@domain.com', 'pubkey');
console.log(`NIP-05 valid: ${isValid}`);
```

---

### Sprint 5: Profile Metrics - Events & Reciprocity
**Goal:** Complete profile metrics collection

**Reference:** [04-profile-validation-metrics.md](./04-profile-validation-metrics.md)

**Tasks:**
1. Implement `EventValidator` for kind 10002
2. Implement `ReciprocityValidator`
3. Implement `ProfileMetricsCollector` orchestrator
4. Integrate with social graph for reciprocity optimization
5. Write integration tests

**Testable Output:**
- Check for event kind 10002
- Verify reciprocal follows
- Collect all metrics in parallel
- Cache complete metric set

**Demo:**
```typescript
const collector = new ProfileMetricsCollector(db, config);
const metrics = await collector.collectMetrics('target-pubkey', 'source-pubkey');
console.log(metrics);
// {
//   nip05Valid: 1.0,
//   lightningAddress: 1.0,
//   eventKind10002: 0.0,
//   reciprocity: 1.0
// }
```

---

### Sprint 6: Trust Score Calculation
**Goal:** Implement weighted trust score formula

**Reference:** [05-trust-score-computation.md](./05-trust-score-computation.md)

**Tasks:**
1. Implement `TrustScoreCalculator` with formula
2. Implement weighting schemes (default, conservative, progressive, balanced)
3. Implement `TrustScoreCache` for database caching
4. Write comprehensive unit tests
5. Create score breakdown utility

**Testable Output:**
- Calculate trust scores with all metrics
- Apply different weighting schemes
- Cache scores in database
- Generate metric breakdowns

**Demo:**
```typescript
const calculator = new TrustScoreCalculator();
const result = await calculator.calculate({
    distanceWeight: 0.8,
    nip05Valid: 1.0,
    lightningAddress: 1.0,
    eventKind10002: 0.0,
    reciprocity: 1.0
});
console.log(`Trust Score: ${result.score}`);
// Output: 0.875

const breakdown = calculator.calculateBreakdown(inputs);
console.log(breakdown); // Shows each metric's contribution
```

---

### Sprint 7: Service Orchestration
**Goal:** Integrate all modules into RelatrService

**Reference:** [06-mcp-server-interface.md](./06-mcp-server-interface.md), [08-data-flow.md](./08-data-flow.md)

**Tasks:**
1. Implement `RelatrService` class
2. Coordinate all modules (graph, normalizer, metrics, calculator)
3. Implement end-to-end trust score computation
4. Write integration tests
5. Add error handling and logging

**Testable Output:**
- Complete trust score flow works
- All modules integrate correctly
- Errors propagate properly
- Performance metrics logged

**Demo:**
```typescript
const service = new RelatrService();
await service.initialize();

const result = await service.calculateTrustScore({
    targetPubkey: 'target',
    sourcePubkey: 'source',
    scheme: 'default',
    forceRefresh: false
});

console.log(`Trust Score: ${result.score}`);
console.log(`Metrics:`, result.metrics);
```

---

### Sprint 8: MCP Server Implementation
**Goal:** Expose trust score calculation via MCP protocol

**Reference:** [06-mcp-server-interface.md](./06-mcp-server-interface.md), [11-api-specification.md](./11-api-specification.md)

**Tasks:**
1. Implement MCP server entry point
2. Register `calculate_trust_score` tool
3. Add Zod schema validation
4. Implement error handling
5. Test with MCP client

**Testable Output:**
- MCP server starts successfully
- Tool registration works
- Schema validation catches errors
- Returns proper MCP responses

**Demo:**
```bash
# Start server
bun run src/mcp/server.ts

# In another terminal, test with MCP client
# (Tool should respond with trust score JSON)
```

---

### Sprint 9: Caching & Performance
**Goal:** Implement complete caching strategy

**Reference:** [09-caching-strategy.md](./09-caching-strategy.md)

**Tasks:**
1. Implement cache hit/miss tracking
2. Add cache warming utilities
3. Implement periodic cleanup script
4. Add performance monitoring
5. Optimize database queries with proper indexes

**Testable Output:**
- Cache hit rate > 70%
- Cleanup removes expired entries
- Warm cache requests < 10ms
- Cold cache requests < 500ms

**Demo:**
```typescript
// First request (cold)
const start1 = Date.now();
await service.calculateTrustScore({...});
console.log(`Cold: ${Date.now() - start1}ms`);

// Second request (warm)
const start2 = Date.now();
await service.calculateTrustScore({...});
console.log(`Warm: ${Date.now() - start2}ms`);
```

---

### Sprint 10: Testing & Documentation
**Goal:** Complete test coverage and documentation

**Tasks:**
1. Write unit tests for all modules (target: 80% coverage)
2. Write integration tests for complete flows
3. Create usage examples in README
4. Document deployment process
5. Add JSDoc comments to public APIs

**Testable Output:**
- All tests pass
- Coverage report shows > 80%
- README includes quick start guide
- Example scripts work

**Demo:**
```bash
bun test
# All tests pass with coverage report
```

---

## Testing Strategy Per Sprint

### Unit Tests
Each module should have:
- Happy path tests
- Edge case tests
- Error handling tests
- Mock dependencies

### Integration Tests
Test interactions between:
- Database ↔ Cache layers
- Social Graph ↔ Metrics
- Metrics ↔ Trust Calculator
- Service ↔ All modules

### End-to-End Tests
Full flow from MCP request to response:
1. MCP request received
2. All modules orchestrated
3. Correct response returned
4. Caching works

## Development Workflow

```
For each sprint:
1. Read relevant LLD document(s)
2. Implement core functionality
3. Write unit tests
4. Run tests (bun test)
5. Create demo script
6. Test manually
7. Commit working code
8. Move to next sprint
```

## Progressive Demo Path

After each sprint, you should be able to demo:

- **Sprint 2:** Distance normalization with different profiles
- **Sprint 3:** Social graph distance queries
- **Sprint 4:** Profile validation (NIP-05 + Lightning)
- **Sprint 5:** Complete profile metrics collection
- **Sprint 6:** Trust score calculation
- **Sprint 7:** End-to-end trust score flow
- **Sprint 8:** MCP tool working with real requests
- **Sprint 9:** Performance improvements visible

## Validation Checklist

Before considering implementation complete:

- [ ] All sprints completed
- [ ] All unit tests passing
- [ ] Integration tests passing
- [ ] MCP server responds correctly
- [ ] Cache performance meets targets
- [ ] Error handling works
- [ ] Documentation complete
- [ ] Can compute trust score for any pubkey pair
- [ ] Weighting schemes work
- [ ] Database properly normalized

## Key Files Reference Map

| Module | LLD Document | Key Files |
|--------|-------------|-----------|
| Database | [01-database-schema.md](./01-database-schema.md) | `src/database/schema.sql` |
| Social Graph | [02-social-graph-integration.md](./02-social-graph-integration.md) | `src/social-graph/SocialGraphManager.ts` |
| Distance | [03-distance-normalization.md](./03-distance-normalization.md) | `src/distance/DistanceNormalizer.ts` |
| Metrics | [04-profile-validation-metrics.md](./04-profile-validation-metrics.md) | `src/metrics/ProfileMetricsCollector.ts` |
| Trust Score | [05-trust-score-computation.md](./05-trust-score-computation.md) | `src/trust/TrustScoreCalculator.ts` |
| MCP Server | [06-mcp-server-interface.md](./06-mcp-server-interface.md) | `src/mcp/server.ts` |
| Service | [06-mcp-server-interface.md](./06-mcp-server-interface.md) | `src/services/RelatrService.ts` |
| Caching | [09-caching-strategy.md](./09-caching-strategy.md) | `src/metrics/cache/`, `src/trust/TrustScoreCache.ts` |
| Config | [10-configuration.md](./10-configuration.md) | `src/config/environment.ts` |

## Next Steps

1. Start with **Sprint 0** to set up the foundation
2. Follow sprints sequentially
3. Test after each sprint before moving forward
4. Reference LLD documents for implementation details
5. Keep code modular and testable

**Happy coding! 🚀**