# Validation Pipeline Refactor Plan v1

## Purpose

This document describes:

- the current validation architecture in [`relatr`](package.json)
- the main performance and complexity issues in the current implementation
- a proposed flatter architecture for validation and fact acquisition
- a phased refactor plan that preserves plugin dynamism and operational consistency

The goal is to make validation more predictable, easier to reason about, and substantially faster during initialization, while preserving the dynamic Elo plugin model used by [`PluginManager`](src/plugins/PluginManager.ts:90), [`EloPluginEngine`](src/plugins/EloPluginEngine.ts:62), and [`MetricsValidator`](src/validators/MetricsValidator.ts:20).

## Problem Statement

Bulk validation is currently too slow during initialization. Real-world runs show multi-hour completion times, with a large fraction of time spent waiting on network-bound validation capabilities, especially NIP-05 resolution through [`httpNip05Resolve`](src/capabilities/http/httpNip05Resolve.ts:50).

Although the Elo planning model reduces redundant capability execution within a single pubkey evaluation in [`runPlugins`](src/plugins/EloPluginRunner.ts:376), it does not optimize the dominant cost in initialization: tens of thousands of mostly unique, network-bound validations across many pubkeys.

The result is a pipeline that is correct and flexible, but too nested and too pubkey-oriented for large-scale initialization.

## Current Architecture

### Runtime entry and scheduling

Initialization and background operations are orchestrated by [`SchedulerService`](src/service/SchedulerService.ts:16).

Relevant behavior:

- initial validation sync is executed during service startup in [`start()`](src/service/SchedulerService.ts:40)
- validation runs are serialized through [`syncValidations()`](src/service/SchedulerService.ts:163)
- plugin changes can trigger warm-up reruns through [`scheduleValidationWarmup()`](src/service/SchedulerService.ts:206)

The scheduler currently treats validation as a large pubkey-by-pubkey processing task.

### Validation orchestration

The main bulk validation path lives in [`validateAllBatch()`](src/validators/MetricsValidator.ts:190).

Current flow:

1. read cached metrics in bulk
2. determine which pubkeys are missing current expected metric keys
3. split missing pubkeys into chunks
4. fetch missing metadata for each chunk
5. evaluate Elo plugins per pubkey
6. upsert metric subsets for successful evaluations

Important current parameters in [`MetricsValidator`](src/validators/MetricsValidator.ts:20):

- profile fetch concurrency: [`profileFetchConcurrency`](src/validators/MetricsValidator.ts:26)
- chunk size: [`validationChunkSize`](src/validators/MetricsValidator.ts:27)
- chunk concurrency: [`validationChunkConcurrency`](src/validators/MetricsValidator.ts:28)
- per-pubkey validation concurrency: [`validationPubkeyConcurrency`](src/validators/MetricsValidator.ts:29)

### Dynamic metric surface

The validation scope is dynamic and derived from the active plugin runtime.

- expected metric keys are computed by [`getExpectedMetricKeys()`](src/validators/MetricsValidator.ts:583)
- those keys are based on the runtime plugin set exposed by [`getRuntimeState()`](src/plugins/EloPluginEngine.ts:169)
- runtime plugin changes are applied through [`reloadFromPlugins()`](src/plugins/EloPluginEngine.ts:134)

This means metric completeness is relative to the currently installed and enabled plugin set.

### Elo execution model

Per-pubkey metric evaluation flows through:

- [`evaluateEloPlugins()`](src/validators/MetricsValidator.ts:563)
- [`evaluateForPubkey()`](src/plugins/EloPluginEngine.ts:189)
- [`runPlugins()`](src/plugins/EloPluginRunner.ts:376)
- [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:100)

Current properties:

- plugins are executed sequentially per pubkey in [`runPlugins()`](src/plugins/EloPluginRunner.ts:403)
- within a plugin, planned `do` calls are batched per round in [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:290)
- deduplication is scoped to a single pubkey evaluation through [`PlanningStore`](src/plugins/PlanningStore.ts:14)

### Capability execution

Capabilities are executed via [`CapabilityExecutor`](src/capabilities/CapabilityExecutor.ts:27).

Important behavior:

- planning-store dedupe only applies inside one evaluation in [`execute()`](src/capabilities/CapabilityExecutor.ts:65)
- batched execution is implemented as concurrent promise execution in [`executeBatch()`](src/capabilities/CapabilityExecutor.ts:205)
- there is no persistent cross-run cache in the executor itself

### NIP-05 handling

NIP-05 resolution is currently performed by [`httpNip05Resolve`](src/capabilities/http/httpNip05Resolve.ts:50).

Current behavior:

- uses normalized identifiers through [`normalizeNip05()`](src/capabilities/http/utils/httpNip05Normalize.ts)
- uses in-memory per-run caching through [`CapabilityRunCache`](src/plugins/plugin-types.ts:16)
- uses in-memory bad-domain fail-fast tracking through [`nip05BadDomains`](src/plugins/plugin-types.ts:20)
- applies `capTimeoutMs`-bounded live network resolution in [`httpNip05Resolve`](src/capabilities/http/httpNip05Resolve.ts:78)

This design is useful for correctness and local dedupe, but it is still dominated by slow remote calls during initialization.

## Current Pain Points

### 1. The hot path mixes too many concerns

[`validateAllBatch()`](src/validators/MetricsValidator.ts:190) currently combines:

- cache completeness checks
- metadata acquisition
- plugin evaluation
- capability execution
- persistence

This makes the flow harder to reason about and harder to optimize independently.

### 2. Planning helps at the wrong granularity for initialization

The planner in [`EloPluginRunner`](src/plugins/EloPluginRunner.ts:100) deduplicates capability calls within one pubkey evaluation. Initialization, however, is dominated by many unique requests spread across many pubkeys.

The planner is therefore useful but insufficient for large-scale bootstrap performance.

### 3. Network I/O happens in the innermost scoring loop

Expensive live network calls, especially [`http.nip05_resolve`](src/capabilities/registerBuiltInCapabilities.ts:32), are triggered while computing plugin scores for each pubkey.

This couples scoring and data acquisition too tightly.

### 4. Existing batch abstractions are not truly batch-oriented

[`runPluginsBatch()`](src/plugins/EloPluginRunner.ts:431) is currently only a sequential loop over pubkeys that repeatedly calls [`runPlugins()`](src/plugins/EloPluginRunner.ts:445).

This is not a genuine bulk-scoring or bulk-provisioning abstraction.

### 5. Dynamic plugin churn is supported, but invalidation is still coarse

The current model correctly reacts to additive, subtractive, and scoring-only runtime changes through [`PluginManager`](src/plugins/PluginManager.ts:90), but the recomputation model is still mostly broad revalidation rather than precise dependency-aware invalidation.

More specifically:

- install and enable are additive changes that can introduce new required metric keys or fact dependencies
- disable and uninstall are subtractive changes that shrink the active metric surface and should not invalidate unrelated facts
- weight changes are scoring-only changes that should not invalidate facts or plugin results

## Refactor Goals

The refactor should preserve the existing strengths while improving performance and clarity.

### Required properties

1. **Semantic consistency**
   - initialization mode and steady-state mode must produce the same metric meaning
   - live and cached fact sources must obey the same normalization and failure semantics

2. **Plugin dynamism**
   - operators must still be able to install, uninstall, enable, disable, and reweight plugins dynamically through [`PluginManager`](src/plugins/PluginManager.ts:90)
   - metric completeness must remain relative to the active runtime plugin set

3. **Operational clarity**
   - data acquisition, fact freshness, and metric scoring should be separable and observable

4. **Performance**
   - expensive remote work should be batched, cached, throttled, and reused across runs

5. **Simplicity**
   - the bulk path should become flatter and more comprehensible
   - the plugin system should remain elegant rather than becoming a growing set of special cases

## Proposed Architecture

The target architecture is a **fact-oriented validation pipeline** with a shared scoring model.

### Core principle

Use one scoring semantics with two acquisition strategies:

- **bulk acquisition** for initialization and scheduled refresh
- **incremental/live acquisition** for interactive or small-scope evaluation

Both paths should feed the same canonical fact model and the same scoring semantics.

### Architectural layers

#### Layer 1: Runtime plugin registry

This layer remains dynamic and continues to be managed by:

- [`PluginManager`](src/plugins/PluginManager.ts:90)
- [`EloPluginEngine`](src/plugins/EloPluginEngine.ts:62)

Responsibilities:

- define active plugin set
- define active metric keys
- define enabled/disabled state
- define weight overrides and resolved weights

#### Layer 2: Fact materialization

This becomes the primary place for expensive data acquisition.

Example fact families:

- profile metadata facts
- NIP-05 resolution facts
- domain cooldown / health facts
- graph-derived facts
- future note/activity facts

Responsibilities:

- normalization
- persistent caching
- TTL handling
- backoff and cooldown policy
- batch scheduling and concurrency control

#### Layer 3: Metric scoring

Scoring should use prepared facts whenever available.

Responsibilities:

- execute dynamic plugin logic
- preserve Elo plugin semantics
- avoid live remote I/O in the bulk path when facts are already materialized

### Proposed validation stages

The bulk validation pipeline should be organized into explicit stages.

#### Stage 1: collect targets

Source target pubkeys from [`SchedulerService`](src/service/SchedulerService.ts:258) and determine which are in scope.

#### Stage 2: ensure metadata

Load and materialize profile metadata in bulk, reusing existing metadata persistence.

#### Stage 3: derive required facts from active plugins

Determine what fact families are needed by the current active plugin runtime.

Initial implementation may do this conservatively using known capability families, with future dependency introspection added later.

#### Stage 4: refresh expensive fact families in batch

For example:

- collect normalized NIP-05 identifiers from metadata
- resolve them in a dedicated NIP-05 batch subsystem
- persist resolution results and domain cooldown state

#### Stage 5: score metrics from prepared facts

Run plugin scoring against a prepared fact context.

For bulk mode, plugin logic should prefer materialized facts. Live fallback may still exist, but should not dominate the hot path.

#### Stage 6: persist metrics and freshness state

Persist newly computed metric subsets and any updated fact timestamps.

## Proposed Modules

Suggested new modules under [`src/validation/`](src):

- [`ValidationPipeline`](src/validation/ValidationPipeline.ts)
- [`ProfileMaterializer`](src/validation/ProfileMaterializer.ts)
- [`Nip05BatchResolver`](src/validation/Nip05BatchResolver.ts)
- [`FactStore`](src/validation/FactStore.ts)
- [`MetricScorer`](src/validation/MetricScorer.ts)
- [`ValidationInvalidationPlanner`](src/validation/ValidationInvalidationPlanner.ts)

Suggested responsibilities:

- [`ValidationPipeline`](src/validation/ValidationPipeline.ts): stage orchestration only
- [`ProfileMaterializer`](src/validation/ProfileMaterializer.ts): metadata availability and refresh
- [`Nip05BatchResolver`](src/validation/Nip05BatchResolver.ts): domain-aware NIP-05 resolution with persistent cache and cooldown policy
- [`FactStore`](src/validation/FactStore.ts): read/write access to materialized facts
- [`MetricScorer`](src/validation/MetricScorer.ts): plugin scoring over prepared contexts
- [`ValidationInvalidationPlanner`](src/validation/ValidationInvalidationPlanner.ts): determine which pubkeys and metrics are dirty after plugin or fact changes

## Consistency Model

The refactor must maintain a strict consistency model.

### Invariant

For the same target pubkey, source pubkey, plugin runtime, and freshness policy, initialization and steady-state evaluation should produce the same metrics.

### Standardized semantics

The following must be identical across live and batch paths:

- normalization rules such as [`normalizeNip05()`](src/capabilities/http/utils/httpNip05Normalize.ts)
- timeout and failure classification semantics
- stale vs missing vs invalid fact semantics
- namespaced metric key generation in [`MetricsValidator.getExpectedMetricKeys()`](src/validators/MetricsValidator.ts:583)

### Dynamic plugin compatibility

The dynamic plugin model remains intact if:

- the active runtime in [`EloPluginEngine`](src/plugins/EloPluginEngine.ts:62) continues to define expected metrics
- fact materialization is implemented beneath stable capability or fact interfaces
- new plugins can still work immediately, even if some fact families initially rely on live fallback paths

## Dirty State Model

The current “dirty latch” concept should evolve into a more explicit model.

### Proposed dirtiness classes

1. **Additive runtime dirty**
   - plugin install or enable
   - introduces new required metric keys, plugin outputs, or fact dependencies

2. **Fact dirty**
   - a materialized fact family is stale, missing, or newly required

3. **Metric dirty**
   - a pubkey is missing one or more current metric keys, or depends on stale facts

4. **Subtractive runtime change**
   - plugin disable or uninstall
   - shrinks the active metric surface
   - should not invalidate unrelated facts or surviving plugin outputs

5. **Weight/config dirty**
   - resolved weights changed
   - should only affect downstream weighted composition or projection
   - should not invalidate facts or previously computed plugin-local results

This is more precise and easier to reason about than a single generic validation-dirty signal.

## Migration Strategy

The refactor should be phased to control risk.

### Phase 1: Immediate performance wins with minimal architectural change

Scope:

- reduce bulk validation timeout defaults or add dedicated bulk timeout configuration
- add persistent NIP-05 result caching
- add persistent NIP-05 domain cooldown state
- keep current plugin evaluation API unchanged

Benefits:

- high performance upside
- low compatibility risk

Risks:

- low

### Phase 2: Introduce fact-backed capability execution

Scope:

- make expensive capabilities cache-first and live-fallback-second
- introduce first fact store abstractions
- keep existing Elo plugin and capability contracts stable

Benefits:

- better separation of acquisition vs scoring
- improved repeat-run performance

Risks:

- low to medium

### Phase 3: Add explicit validation pipeline orchestration

Scope:

- add [`ValidationPipeline`](src/validation/ValidationPipeline.ts)
- move orchestration responsibilities out of [`MetricsValidator`](src/validators/MetricsValidator.ts:20)
- introduce fact refresh stages for expensive capability families

Benefits:

- major clarity improvement
- better observability and scheduling control

Risks:

- medium

### Phase 4: Narrow invalidation and dependency tracking

Scope:

- introduce plugin-to-fact or plugin-to-capability dependency tracking
- compute narrower backfill sets after additive runtime changes such as install or enable
- avoid full recomputation when only subsets are affected
- treat disable or uninstall as subtractive projection changes unless a plugin-specific cleanup path is explicitly required
- treat weight changes as scoring recomputation only, with no fact backfill

Benefits:

- major operational efficiency gains for dynamic plugin management

Risks:

- medium to high

### Phase 5: Optional pure-fact bulk scoring path

Scope:

- make bulk validation prefer prepared fact contexts entirely
- keep live capability fallback for interactive or unknown cases
- simplify or retire the current mixed hot path in [`validateAllBatch()`](src/validators/MetricsValidator.ts:190)

Benefits:

- highest long-term performance and conceptual clarity

Risks:

- highest implementation risk
- must not break dynamic plugin compatibility

## Risk Assessment

### Correctness risk: medium

The main risk is divergence between live and materialized fact semantics.

Mitigation:

- centralize normalization and failure classification
- keep live and batch paths sharing the same fact schema and scoring logic

### Plugin compatibility risk: low to medium

Compatibility risk stays moderate if the optimization is placed beneath stable interfaces rather than hardcoding special behavior for individual plugins.

Mitigation:

- preserve current capability contracts
- preserve dynamic runtime metric key derivation
- keep live fallback for newly installed or uncommon plugin dependency patterns

### Scope risk: medium-large

This is not a small local optimization. It spans validation orchestration, capability data acquisition, persistence, and dirty-state handling.

Mitigation:

- phase the work
- avoid rewriting the Elo model in one step
- land persistent caching and cache-first capability resolution before broader pipeline changes

### Performance upside: high

Persistent caching, fact materialization, and batch-oriented remote acquisition should produce major improvements for initialization and scheduled validation runs.

## Non-Goals

The refactor should **not**:

- replace the dynamic Elo plugin model with a fixed built-in metric system
- create separate metric semantics for initialization and steady-state operation
- hardcode optimization paths for a small set of known plugins in a way that weakens general extensibility
- remove live capability execution entirely from the system

## Recommended First Increment

The first implementation increment should focus on the highest-value, lowest-risk work:

1. persistent NIP-05 resolution cache
2. persistent NIP-05 domain cooldown tracking
3. distinct timeout policy for bulk validation
4. capability path changed to cache-first, live-fallback-second

This should deliver immediate improvement while preserving the current architecture and plugin behavior.

## Success Criteria

The refactor should be considered successful when:

- initialization time is materially reduced for large graphs
- plugin install/uninstall/enable/disable flows remain correct through [`PluginManager`](src/plugins/PluginManager.ts:90)
- additive changes trigger only newly required work
- subtractive changes do not invalidate unrelated facts or surviving plugin outputs
- weight changes only affect downstream weighted composition
- validation behavior remains semantically consistent between bulk and steady-state modes
- the new pipeline is easier to explain than the current nested flow
- expensive remote validation work is visible, cacheable, and independently tunable

## Final Recommendation

Proceed with a phased refactor toward a fact-oriented validation pipeline.

The most important design rule is:

**keep plugins dynamic, keep metric semantics unified, and move optimization beneath the capability/fact layer rather than above the plugin model.**

That path best satisfies the project goals of consistency, simplicity, efficiency, and elegance.
