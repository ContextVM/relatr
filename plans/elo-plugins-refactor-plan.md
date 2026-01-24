# Implementation Plan — Refactor relatr Elo Plugins to v0 Spec

This plan describes the concrete refactor steps needed to align the current codebase with the v0 spec in [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:1).

The existing implementation is manifest-driven (`cap` + `cap_arg`) and injects capability results under `_.cap.*`. The v0 spec requires **inline** `cap(name, args_expr)` inside Elo content, a **plan-only** execution model (no I/O during scoring), and **JSON-only** `args_expr` evaluated during planning.

---

## 0) Guardrails / scope

- This is early development: we will **remove** the old `cap_arg` design rather than documenting migration/deprecation.
- Keep the Unix-y property from the spec: **inspectable plans**, explicit dependencies, and a clean separation between:
  - plugin policy (Elo content)
  - host mechanism (capability execution, timeouts, batching)

---

## 1) Identify current vs target architecture

### 1.1 Current (manifest-driven provisioning)

Key pieces:

- Manifest parsing supports `cap` + `cap_arg` tags in [`src/plugins/parseManifestTags.ts`](src/plugins/parseManifestTags.ts:1).
- Runner provisions capabilities from `plugin.manifest.caps` and injects nested results into `_.cap` in [`runPlugin()`](src/plugins/EloPluginRunner.ts:22).
- Capability handlers expect string-array args (often JSON strings) like [`nostrQuery`](src/capabilities/nostrQuery.ts:20).
- `PlanningStore` dedupes by `pluginId:targetPubkey:capName:argsHash` in [`src/plugins/PlanningStore.ts`](src/plugins/PlanningStore.ts:30).

### 1.2 Target (inline cap + plan/provision + rewrite)

From the spec [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:57):

- Elo plugin content contains `cap('nostr.query', {kinds: [...], ...})` call sites.
- Host extracts all `cap(name, args_expr)` from AST, evaluates `args_expr` against input `_`, canonicalizes args JSON, dedupes, provisions, then rewrites `cap(...)` to `lookup(RequestKey)` and evaluates score.

---

## 2) Refactor strategy (high-level)

We’ll implement this as a set of narrow changes, each validated by focused tests:

1. **Data model cleanup**: remove manifest cap args and make manifest `cap` tags an allowlist only.
2. **Introduce planning pipeline**:
   - extract `cap(name, args_expr)` call sites from source (host macro)
   - evaluate args expressions with Elo
   - compute RequestKey = `capName + "\n" + canonicalArgsJson`
3. **Provisioning**: execute deduped requests via `CapabilityExecutor` (timeouts, enablement).
4. **Rewrite & score**:
   - rewrite Elo **source** so `cap(...)` expands to a pure lookup over provisioned results (host macro expansion)
   - compile and evaluate with `_` containing `{ targetPubkey, sourcePubkey, now, provisioned }`
5. **Remove legacy**: delete `cap_arg` parsing and any tests/examples using the old model.

---

## 3) Step-by-step implementation plan

### Phase A — Manifest + loader cleanup (remove `cap_arg` design)

**A1. Update manifest types**

- Change `PluginManifest.caps` in [`src/plugins/plugin-types.ts`](src/plugins/plugin-types.ts:24) from an array of `{ name, args: string[] }` to an array of `{ name }` (or `string[]` of names).
- Update `CapabilityRequest.args` if needed later (see Phase C).

**A2. Replace `parseManifestTags()` behavior**

- In [`src/plugins/parseManifestTags.ts`](src/plugins/parseManifestTags.ts:1):
  - Remove the state machine associating `cap_arg` with `cap`.
  - Parse only repeatable `cap` tags to build the allowlist.
  - Ignore any `cap_arg` tags if present (or treat as validation error).

**A3. Update loader validation**

- Keep validating `cap` names via [`isValidCapabilityName()`](src/capabilities/capability-catalog.ts:83).
- Ensure loader behavior stays deterministic in [`loadPluginFromFile()`](src/plugins/PortablePluginLoader.ts:46).

**A4. Delete/update legacy tests**

- Update `createTestPlugin()` in [`src/tests/elo-plugins.test.ts`](src/tests/elo-plugins.test.ts:31) to stop emitting `cap_arg` tags.
- Remove/replace tests that assert cap args parsing, e.g. “should parse capability tags with arguments”.

Deliverable: compiling tests with manifest-only `cap` allowlist.

---

### Phase B — Define the new Elo input shape (remove `_.cap` injection)

**B1. Update `EloInput`**

- Update [`EloInput`](src/plugins/plugin-types.ts:71) to match the spec:
  - `targetPubkey: string`
  - `sourcePubkey: string | null`
  - `now: number` (seconds)
- Remove `pubkey` and remove `cap`.

**B2. Update evaluator**

- `compile()` usage in [`src/plugins/EloEvaluator.ts`](src/plugins/EloEvaluator.ts:1) remains, but:
  - Ensure `_.now` is seconds (currently uses `Date.now()` ms in [`runPlugin()`](src/plugins/EloPluginRunner.ts:80)).

Deliverable: unit tests updated for new `_` schema.

---

### Phase C — Introduce planning primitives (RequestKey, canonical args)

**C1. Add a RequestKey helper**

- Create a utility module (e.g. `src/plugins/requestKey.ts`) that:
  - Takes `(capName: string, argsJson: unknown)`
  - Validates JSON-only
  - Uses `canonicalize()` (already used in [`PlanningStore`](src/plugins/PlanningStore.ts:1))
  - Returns `RequestKey = capName + "\n" + canonicalArgsJson` per spec.

**C2. Replace `PlanningStore` key format**

- The spec dedupes across plugins by RequestKey.
- Update [`PlanningStore`](src/plugins/PlanningStore.ts:19) to map `RequestKey -> result`.
  - Remove `pluginId` and `targetPubkey` from the key.
  - Keep the store per evaluation run (same lifecycle).

Deliverable: PlanningStore reflects spec dedupe and is reusable by the new pipeline.

---

### Phase D — Parse Elo AST, extract cap calls, evaluate args_expr

The Elo docs mention a low-level API with `parse()` in [`plans/elo-docs.md`](plans/elo-docs.md:1151), but `@enspirit/elo` rejects unknown function calls at compile time.

Finding (verified via local experiment):

- `compile()` and `compileToJavaScript()` both throw `Unknown function cap(String, Object)` when plugin content contains `cap(...)`.

Therefore, in v0 `cap(...)` must be treated as a **host macro** and removed before compiling full plugin code.

**D1. Implement `cap(...)` macro extraction (source-level)**

- Create a small extractor that scans the plugin source for `cap('<literal-cap-name>', <args_expr>)` call sites.
- `capName` MUST be a string literal.
- Capture the raw `<args_expr>` substring and its source span (start/end indices) so we can rewrite later.

**D2. Evaluate `args_expr` during planning (args-only compilation)**

- For each extracted call site, compile and evaluate **only** the `<args_expr>` fragment using Elo.
- Validate strict JSON and canonicalize.
- Compute RequestKey.

Locked implementation choice:

- **`capName` MUST be a string literal**, not a computed expression.
- Call sites are identified by deterministic **source order** (scan order), yielding a stable `callSiteId -> requestKey` mapping.

Sketch (planner output types):

```ts
// src/plugins/eloCapPlanner.ts
export type CallSiteId = number;

export type PlannedCall = {
  callSiteId: CallSiteId;
  capName: string;
  canonicalArgsJson: string;
  requestKey: string; // `${capName}\n${canonicalArgsJson}`
};

export type PlanResult = {
  // Optional: parsed Elo AST of the fully-expanded (scoring) program
  // but not required for v0.
  plannedCalls: PlannedCall[];
  // useful for debugging:
  byCapName: Record<string, PlannedCall[]>;
};
```

**D3. Macro expansion plan for scoring**

- For scoring, the host will expand each `cap(...)` call to a pure lookup over host-provided input `_.provisioned`.
- The expansion MUST NOT re-evaluate `<args_expr>`.
- If unplannable or disallowed, expand to `null`.

Locked implementation choice:

- `args_expr` is evaluated **only during planning**.
- If `args_expr` cannot be evaluated or yields a non-JSON value, the call site is treated as unplannable and will resolve to `null` during scoring (spec failure semantics).

**D4. Enforce plugin allowlist**

- For each extracted `capName`, ensure it appears in `plugin.manifest.cap` allowlist.
- If missing, treat as a failure and provision `null` for that RequestKey (or skip execution and map call site to `null`).

Locked implementation choice:

- If a call site references a capability not present in the plugin’s `cap` tags, it is treated as a provisioning failure and resolves to `null`.

Deliverable: planner returns `(ast, plannedCalls[])`.

---

### Phase E — Provisioning: execute deduped requests

**E1. Rework capability request type**

Currently `CapabilityRequest` uses `args: string[]` in [`src/plugins/plugin-types.ts`](src/plugins/plugin-types.ts:52). Under the new spec, `args` is a JSON value.

Plan:

- Change `CapabilityRequest.args` to `argsJson: unknown` (strict JSON).
- Update capability handlers accordingly.

Locked implementation choice:

- Capability handlers MUST accept strict JSON args and MUST return strict JSON results (or `null`). This keeps the boundary portable and predictable.

**E2. Update `CapabilityExecutor.execute()` signature**

- Modify [`CapabilityExecutor.execute()`](src/capabilities/CapabilityExecutor.ts:65) to accept `(capName, argsJson)` rather than string-array args.
- Use the new RequestKey + `PlanningStore` to dedupe before running handler.

**E3. Update built-in capabilities to accept JSON args**

- Example: [`nostrQuery`](src/capabilities/nostrQuery.ts:20)
  - It currently expects `args[0]` as JSON string.
  - Update to accept an object `Filter` directly.
- Similarly update graph/http capabilities.

Deliverable: executor provisions requests by RequestKey and stores JSON result or null.

---

### Phase F — Rewrite and score (remove `_.cap` entirely)

**F1. Source rewrite (macro expansion)**

- Implement a macro expander that replaces each extracted `cap(name, args_expr)` call site in the **source string** with a pure Elo expression.

Locked implementation choice (simplest / fewest moving parts):

- Host injects `_.provisioned` as an object mapping `RequestKey -> jsonOrNull`.
- Each cap call site is expanded to a lookup expression over `_.provisioned` using Elo stdlib.
- Unplannable/disallowed call sites expand to `null`.

Sketch (rewriter intent):

```ts
// src/plugins/eloCapRewriter.ts
export function rewriteCapCalls(
  ast: unknown,
  callSiteToKey: Map<number, string>,
): unknown {
  // Walk AST; on nth cap-call encountered, replace with:
  //   Call(Identifier("__cap"), [StringLiteral(requestKey)])
  return ast;
}
```

**F2. Compile expanded Elo source**

- Compile the expanded Elo source using [`compile()`](src/plugins/EloEvaluator.ts:1).
- This avoids any need for custom JS evaluation or function injection.

Sketch (compilation wrapper):

```ts
// src/plugins/EloEvaluator.ts (new helper)
const fn = compile(expandedElo);
const score = fn({ ...input_, provisioned });
```

**F3. New runner pipeline**

Replace manifest-driven [`runPlugin()`](src/plugins/EloPluginRunner.ts:22) with:

1. Build input `_` = `{ targetPubkey, sourcePubkey: string|null, now: seconds }`
2. Plan cap call sites
3. Dedupe + provision using executor
4. Expand cap macros in Elo source to provisioned lookups
5. Compile and evaluate
6. Clamp

Locked implementation choice:

- `_.now` is integer seconds (`Math.floor(Date.now()/1000)`), per spec.
- `_.sourcePubkey` is always present and is `string | null`.

New locked decision:

- Scoring input includes `_.provisioned` mapping `RequestKey -> jsonOrNull`.

Deliverable: runner conforms to v0 execution flow.

---

### Phase G — Update tests to match the new semantics

The current test suite is tightly coupled to the old model (`_.cap.*`, manifest `caps[]`, args strings). We should rewrite the tests to assert the spec pipeline.

**G1. Manifest tests**

- Update manifest parsing tests in [`src/tests/elo-plugins.test.ts`](src/tests/elo-plugins.test.ts:53):
  - Validate `cap` tags parsing as allowlist only.
  - Remove `cap_arg` test cases.

**G2. New runner integration tests**

- Add tests that:
  - Use inline `cap('test.echo', {x: 1})` inside content.
  - Assert planning extracts the request.
  - Assert provisioning is deduped across plugins when args canonicalize the same.
  - Assert scoring uses provisioned result (and that scoring does not call capability lazily).

**G3. Failure semantics**

- Add tests for:
  - args_expr returning non-JSON (e.g. DateTime) ⇒ `cap()` returns null
  - capability disabled ⇒ null
  - missing from allowlist tags ⇒ null

---

## 4) Deletions / removals (explicit cleanup)

To avoid lingering references to the previous design, remove these concepts from code/tests:

- `cap_arg` parsing and any mention in comments/docstrings.
- `plugin.manifest.caps` as an executable plan (it becomes allowlist only).
- `_.cap.*` injection in runner.
- `CapabilityRequest.args: string[]` and all JSON-string argument conventions.

---

## 5) Open decisions to settle before coding

Locked decisions (so this plan is fully actionable):

- Cap call sites are of the form `cap('<literal-cap-name>', <args_expr>)`.
- `args_expr` is evaluated only during planning, and must yield strict JSON.
- Capability handler inputs/outputs are strict JSON (or `null`).
- Cap calls are rewritten to `__cap('<literal-RequestKey>')` and `__cap` is injected by the host as a pure lookup.

---

## 6) Implementation entrypoints to modify

- Runner pipeline: [`src/plugins/EloPluginRunner.ts`](src/plugins/EloPluginRunner.ts:1)
- Manifest tags: [`src/plugins/parseManifestTags.ts`](src/plugins/parseManifestTags.ts:1)
- Types: [`src/plugins/plugin-types.ts`](src/plugins/plugin-types.ts:1)
- Dedup store: [`src/plugins/PlanningStore.ts`](src/plugins/PlanningStore.ts:1)
- Capability executor: [`src/capabilities/CapabilityExecutor.ts`](src/capabilities/CapabilityExecutor.ts:1)
- Capabilities:
  - [`src/capabilities/nostrQuery.ts`](src/capabilities/nostrQuery.ts:1)
  - graph/http handlers in `src/capabilities/*`
- Tests: [`src/tests/elo-plugins.test.ts`](src/tests/elo-plugins.test.ts:1)

---

## 7) Suggested implementation order

1. Phase A (remove `cap_arg`, simplify manifest)
2. Phase B (new `_` input)
3. Phase C (RequestKey + PlanningStore change)
4. Phase D (planner: parse/extract/eval args)
5. Phase E (executor + capabilities accept JSON args)
6. Phase F (rewrite + new runner)
7. Phase G (rewrite tests; add new coverage)
