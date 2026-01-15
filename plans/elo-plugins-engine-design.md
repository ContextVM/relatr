# Elo Plugins Engine (C1) — Library Facade Design

## Context

Relatr currently has an Elo portable plugins implementation with distinct modules:

- Loader: [`loadPlugins()`](src/plugins/PortablePluginLoader.ts:179)
- Execution orchestration: [`runPlugin()`](src/plugins/EloPluginRunner.ts:21), [`runPlugins()`](src/plugins/EloPluginRunner.ts:117)
- Capabilities: registry ([`CapabilityRegistry`](src/capabilities/CapabilityRegistry.ts:30)) + executor ([`CapabilityExecutor`](src/capabilities/CapabilityExecutor.ts:32))
- Runtime config: [`RelatrConfigSchema`](src/config.ts:26) including Elo plugin settings
- Metrics caching: [`MetricsValidator.validateAll()`](src/validators/MetricsValidator.ts:104) caches results via MetricsRepository

The code is working and well-tested, but configuration/context is spread across call sites (runner config object, capability config object, optional fields in base contexts). We want better consistency and integration with Relatr conventions, while keeping the plugin system *decoupled* and portable.

This document proposes the next iteration: a **C1 “Library Facade”** architecture.

---

## Goals

1. **Keep Elo plugins as a “kernel/library”** (easy to extract into a separate package later).
2. **Single entrypoint** for wiring + invariants (timeouts, enabled caps, relays list, deps).
3. **Startup-load only** (load plugin files once; no reload loop for now).
4. **Metrics caching stays in MetricsRepository**: cache *only the final merged* `ProfileMetrics` (TS + Elo).
5. Reduce redundancy: avoid passing overlapping config fragments through multiple layers.

Non-goals (for this iteration):

- DB-backed storage of plugins, remote plugin fetching, hot reload, background refresh.
- Persisting per-capability results in DB.

---

## Decision Summary

### Why C1 (Library Facade)

We want decoupling and portability, but also a consistent, centralized wiring point.

- Option A (“PluginService in RelatrFactory”) improves lifecycle consistency but increases coupling and makes extraction harder.
- Option B (“ad-hoc standalone wiring”) keeps decoupling but tends to spread config/dependency wiring across call sites.
- **Option C refined to C1 (“Library Facade”)** keeps decoupling *and* provides a single integration surface.

### Why cache only final merged ProfileMetrics (A)

Using existing caching in [`MetricsValidator`](src/validators/MetricsValidator.ts:104) keeps the Elo engine DB-free and makes extraction straightforward.

We can later add optional caching adapters (e.g. separate Elo metrics cache) without re-architecting.

**Single-layer caching:**
- **MetricsRepository**: Caches final merged ProfileMetrics in DB (pubkey-only key, TTL-based)

During evaluation, a temporary **planning phase store** avoids redundant capability calls within a single evaluation, but is flushed afterward to ensure consistency.

### Why pass full RelatrConfig into the engine

Passing `RelatrConfig` keeps a single source of truth and avoids continuously defining “mini-config” DTOs.
It also makes it easier to evolve the engine with new settings without refactoring many call sites.

### Why remove searchQuery from metrics computation

**Metrics should be intrinsic properties** of a profile (trust, validation, etc.), not dependent on search context.

**Separation of concerns:**
- MetricsValidator: "How trustworthy is this profile?" → intrinsic scores
- SearchService: "How relevant is this profile to this query?" → contextual boosting

**Benefits:**
- Simpler caching (pubkey-only cache key)
- Consistent with TS validators (NIP-05, Lightning, etc.)
- Search can apply different boosting strategies without recomputing metrics
- Final score = intrinsicScore × relevanceBoost

### Why use plugin manifest 'description' field for metric descriptions

**For consistency**, we'll rename the Elo plugin manifest field from `about` to `description` to match the same semantics as TS validators.

**MetricDescriptionRegistry:**
- **TS validators**: register descriptions at construction using `plugin.name` and `plugin.description`
- **Elo plugins**: extract from `manifest.description` at load time
- **API layer**: merges values with descriptions when serving

This keeps descriptions static (loaded once at initialization) while values are computed per-pubkey.

---

## Proposed Architecture

### New module: EloPluginEngine (facade)

Add a facade that owns internal wiring:

- Plugin loading (startup-load)
- Capability registrations (built-ins)
- Capability executor configuration
- Running plugins for a pubkey (and optionally batch)

Proposed file:

- `src/plugins/EloPluginEngine.ts` (new)

This should be the *only* module imported by validators/services.

### Engine responsibilities

The engine:

1. Loads plugins once from `config.eloPluginsDir` (when enabled).
2. Creates and owns:
   - registry: [`CapabilityRegistry`](src/capabilities/CapabilityRegistry.ts:30)
   - executor: [`CapabilityExecutor`](src/capabilities/CapabilityExecutor.ts:32)
3. Registers built-in capabilities (nostr, graph, http) in a single helper.
4. Exposes simple methods to evaluate plugin metrics.

### What remains unchanged

The engine uses existing modules as-is:

- [`PortablePluginLoader`](src/plugins/PortablePluginLoader.ts:125)
- [`EloPluginRunner`](src/plugins/EloPluginRunner.ts:21)
- [`EloEvaluator`](src/plugins/EloEvaluator.ts:1)
- capability implementations like [`nostrQuery`](src/capabilities/nostrQuery.ts:1)

This keeps the refactor low-risk.

---

## Interfaces and Data Flow

### Current pain point

Configuration/context is currently split across:

- Runner `config` ({ eloPluginTimeoutMs, capTimeoutMs })
- CapabilityContext `config` ({ capTimeoutMs })
- Optional fields in [`BaseContext`](src/plugins/plugin-types.ts:12) (graph/pool/relays)

### Desired shape

Engine owns configuration and deps; call sites pass only semantic inputs.

#### Engine dependencies

At construction:

- `config: RelatrConfig`
- `deps: { pool: RelayPool; relays: string[]; graph: SocialGraph }`

#### Per-call execution context

At evaluation time:

- `targetPubkey: string`
- `sourcePubkey?: string`
This reduces the “optional grab-bag” feel and makes invariants explicit.

---

## Integration Points

### MetricsValidator

`MetricsValidator` becomes the owner of merging TS metrics + Elo metrics.

Pseudo-code (illustrative):

```ts
const tsMetrics = await this.registry.executeAll(context);

let eloMetrics: Record<string, number> = {};
if (this.config.eloPluginsEnabled) {
  eloMetrics = await this.eloEngine.evaluateForPubkey({
    targetPubkey: pubkey,
    sourcePubkey,
    searchQuery,
  });
}

const metrics = { ...tsMetrics, ...eloMetrics };
```

Caching remains unchanged: `ProfileMetrics` is cached as a whole (current behavior).

### RelatrFactory

`RelatrFactory` should construct the engine once and pass it to `MetricsValidator` (dependency injection).
This keeps lifecycle consistent (startup-load) without turning the engine into a first-class service.

---

## Caching Strategy

### Single Layer: MetricsRepository (DB)

**MetricsRepository caches final merged ProfileMetrics**
- Key: pubkey only
- TTL: 48 hours default (configurable via `cacheTtlSeconds`)
- Scope: End-to-end (TS + Elo metrics together)
- Storage: DuckDB

**Pubkey-only for metrics:** Metrics are intrinsic properties, so cache key is simply the pubkey. This provides:
- Simple invalidation
- Efficient batch operations
- Acceptable staleness for social graph data

**No searchQuery in cache key:** Search context is handled by SearchService via relevance boosting, not by MetricsValidator.

### Performance Characteristics

**Cache hit:** ~1-5ms (single DB read)
**Cache miss:** ~100-500ms (capability calls + Elo evaluation)
**Batch operations:** Only uncached pubkeys are processed

### Cache Invalidation

**Time-based:** Simple and reliable. TTL expires → recompute.

### Planning Phase Store (Not a Cache)

During Elo plugin evaluation, the engine uses a **temporary in-memory store** to avoid redundant capability calls within a single evaluation:

- **Purpose:** Deduplicate capability requests across plugins during planning phase
- **Scope:** Single evaluation only (not persisted across evaluations)
- **Lifecycle:** Created at start of evaluation, flushed after completion
- **Key:** `pluginId:targetPubkey:capName:argsHash`

**Important:** This is NOT a cache with TTL. When metrics expire in MetricsRepository, the planning store is already empty, ensuring fresh capability results on recomputation. This prevents inconsistencies that would arise from cross-evaluation caching.

**Benefits:**
- Avoids redundant network calls during a single evaluation
- Reduces memory allocation (store is garbage collected after evaluation)
- Simpler architecture (no cache invalidation logic needed)
- Guaranteed consistency (no stale capability data)

**Future optimizations:** The planning phase architecture enables additional optimizations like:
- Merging nostr.query filters across plugins
- Batch execution of independent capabilities
- Request deduplication across plugins

---

## Metric Descriptions

### Design Rationale

Users need to understand what each metric means. We provide descriptions alongside metric values.

### Implementation

**MetricDescriptionRegistry:**
```ts
class MetricDescriptionRegistry {
  private descriptions = new Map<string, string>();
  
  register(metricName: string, description: string): void
  get(metricName: string): string | undefined
  getAll(): Record<string, string>
}
```

**TS Validators:**
Register descriptions in MetricsValidator constructor alongside plugin registration:
```ts
// In MetricsValidator constructor (src/validators/MetricsValidator.ts:91)
for (const plugin of plugins) {
  this.registry.register(plugin);
  // NEW: Register metric description
  this.metricDescriptions.register(plugin.name, plugin.description);
}
```

**Note**: The `ValidationPlugin` type (in `src/validators/plugins.ts`) will need to be extended to include a `description: string` property.

**Elo Plugins:**
Extract from `manifest.description` at plugin load time:
```ts
// In plugin loader (src/plugins/PortablePluginLoader.ts)
const description = manifest.description || 'No description available';
metricDescriptions.register(manifest.name, description);
```

**API Response:**
```ts
{
  pubkey: "...",
  metrics: {
    "nip05": {
      value: 0.9,
      description: "NIP-05 identifier validation score"
    },
    "elo-example": {
      value: 0.7,
      description: "Example plugin based on graph analysis"
    }
  }
}
```

**Benefits:**
- Descriptions loaded once at startup (not per-evaluation)
- Single source of truth (manifest for Elo, code for TS)
- No DB schema changes
- Backward compatible (descriptions optional)

---

## Capability Registration Strategy

Create a single helper:

- `src/capabilities/registerBuiltInCapabilities.ts` (new)

Responsibilities:

- Register:
  - `nostr.query` using [`nostrQuery`](src/capabilities/nostrQuery.ts:1)
  - graph caps using existing graph handlers (e.g. [`graphStats`](src/capabilities/graphStats.ts:1))
  - `http.nip05_resolve` using [`httpNip05Resolve`](src/capabilities/httpNip05Resolve.ts:1)

The engine calls it once.

This prevents capability wiring from being spread across multiple call sites.

---

## Refactor Plan (Minimal Diff)

### Phase 1 — Introduce facade

1. Add `EloPluginEngine` facade.
2. Add `registerBuiltInCapabilities` helper.
3. Keep existing runner/contexts working; facade just wires and forwards.

### Phase 2 — Reduce context/config redundancy

1. Move runner `config` object creation into engine.
2. Reduce call-site usage of [`PluginRunnerContext`](src/plugins/EloPluginRunner.ts:14) to semantic fields only.
3. Build `CapabilityContext` inside engine (pool/relays/graph injected once).

### Phase 3 — Integrate into MetricsValidator

1. Add optional `eloEngine` dependency to MetricsValidator.
2. Merge metrics as `{ ...tsMetrics, ...eloMetrics }`.
3. Ensure errors in Elo metrics return safe defaults and do not break validation.

### Phase 4 — Tests and invariants

1. Update unit tests to construct engine and assert:
   - plugins load at startup
   - capabilities register once
   - per-pubkey evaluation returns expected metrics
2. Preserve existing tests for lower-level modules.

---

## Key Code Examples (Target Shape)

### Engine facade

```ts
// src/plugins/EloPluginEngine.ts
export class EloPluginEngine {
  constructor(
    private config: RelatrConfig,
    private deps: { pool: RelayPool; relays: string[]; graph: SocialGraph },
  ) {}

  async initialize(): Promise<void> {
    // load plugins once + register capabilities
  }

  async evaluateForPubkey(input: {
    targetPubkey: string;
    sourcePubkey?: string;
  }): Promise<Record<string, number>> {
    // calls runPlugins()
  }
}
```

### Built-in capability registration

```ts
export function registerBuiltInCapabilities(registry: CapabilityRegistry): void {
  registry.register("nostr.query", nostrQuery);
  registry.register("http.nip05_resolve", httpNip05Resolve);
  registry.register("graph.stats", graphStats);
  // ...and the rest
}
```

### Metric description registry

```ts
export class MetricDescriptionRegistry {
  private descriptions = new Map<string, string>();
  
  register(metricName: string, description: string): void {
    this.descriptions.set(metricName, description);
  }
  
  get(metricName: string): string | undefined {
    return this.descriptions.get(metricName);
  }
  
  getAll(): Record<string, string> {
    return Object.fromEntries(this.descriptions);
  }
}
```

---

## Risks / Watch-outs

1. **Context drift**: if call sites keep constructing contexts by hand, the facade won’t deliver consistency. The plan removes this by concentrating wiring in the engine.
2. **Capability deps**: engine must validate it has `pool/relays` for nostr capabilities, `graph` for graph capabilities.
3. **Metric description sync**: ensure TS validator descriptions and Elo plugin `about` fields stay in sync with actual metric names.
4. **Cache granularity**: pubkey-only caching works for intrinsic metrics but may need refinement if we add context-aware metrics in the future.
5. **Planning store lifecycle**: must ensure the temporary store is properly cleared after each evaluation to prevent memory leaks.

---

## Outcome

After this refactor:

- Elo plugins are a library-style subsystem with a single entrypoint.
- Relatr integrates via DI (Factory → MetricsValidator), without absorbing Elo plugins into the service lifecycle model.
- Configuration and dependency wiring becomes consistent and easier to maintain.
- Metrics are intrinsic properties with clear descriptions for users.
- Planning phase store optimizes evaluation without risking consistency.
- Extraction to a separate package becomes straightforward (engine + internal modules + capability impls).

---

## MCP Server Integration

The MCP server (`src/mcp/server.ts`) currently returns trust scores with validator components but no metric descriptions. After this refactor, we can enhance the output schemas to include descriptions:

```ts
// Enhanced validators schema
validators: z.record(
  z.string(),
  z.object({
    score: z.number(),
    description: z.string().optional()
  })
)
```

This provides users with human-readable explanations of what each metric means directly in the MCP tool responses.

