# Relatr Plugin Management UX v1 — Detailed Implementation Plan

## 1. Scope and Product Decision

This plan defines a minimal, RPC-friendly plugin management UX for Relatr instances with exactly three operator operations:

- `install`
- `config`
- `list`

Key UX decision:

- Public API surface is only `install`, `config`, and `list`.
- Runtime activation is internal: `install` persists plugin as available but defaults to disabled, while `config` applies enablement and weight changes atomically.

This keeps operator usage straightforward while preserving operational safety.

---

## 2. Goals and Non-Goals

### 2.1 Goals

1. Minimal API surface for CLI and MCP.
2. Single shared core manager used by both interfaces.
3. Atomic mutation semantics: all-or-nothing behavior per call.
4. Lean `list` output as source of truth for current runtime plugin state, with optional verbose mode.
5. Preserve existing plugin safety checks at install time.

### 2.2 Non-Goals (v1)

1. No marketplace/discovery UX implementation.
2. No plugin history/audit timeline exposed in public API.
3. No staged draft workflow in v1.
4. No plugin uninstall/remove API in this iteration.

---

## 3. Reference Context in Current Codebase

### 3.1 Existing load/validation pipeline

- Loader entrypoints: [`loadPluginFromFile()`](../src/plugins/PortablePluginLoader.ts:75), [`loadPluginsFromDirectory()`](../src/plugins/PortablePluginLoader.ts:160), [`loadPlugins()`](../src/plugins/PortablePluginLoader.ts:222)
- Manifest parsing and validation: [`parseManifestTags()`](../src/plugins/parseManifestTags.ts:79), [`validateManifest()`](../src/plugins/parseManifestTags.ts:122)
- Kind check: [`RELATR_PLUGIN_KIND`](../src/plugins/PortablePluginLoader.ts:10)
- Version compatibility tag semantics documented in [`plans/relatr-plugins-spec-v1.md`](./relatr-plugins-spec-v1.md)

### 3.2 Existing runtime integration

- Engine class: [`EloPluginEngine`](../src/plugins/EloPluginEngine.ts:50)
- Startup initialization: [`EloPluginEngine.initialize()`](../src/plugins/EloPluginEngine.ts:73)
- Runtime execution: [`EloPluginEngine.evaluateForPubkey()`](../src/plugins/EloPluginEngine.ts:139)
- Factory wiring: [`RelatrFactory.createRelatrService()`](../src/service/RelatrFactory.ts:37)

### 3.3 Existing server and persistence integration points

- MCP tool pattern: [`registerTool()`](../src/mcp/server.ts:390)
- Service boundary contracts: [`IRelatrService`](../src/service/ServiceInterfaces.ts:69)
- Settings persistence: [`SettingsRepository.get()`](../src/database/repositories/SettingsRepository.ts:20), [`SettingsRepository.set()`](../src/database/repositories/SettingsRepository.ts:43)

### 3.4 Product/UX context docs

- User journey narrative: [`plans/user-story-portable-plugins.md`](./user-story-portable-plugins.md)
- Plugin format/spec: [`plans/relatr-plugins-spec-v1.md`](./relatr-plugins-spec-v1.md)

---

## 4. Proposed Architecture

## 4.1 New core service

Introduce `PluginManager` as the single orchestration layer.

Responsibilities:

1. Validate install payloads and fetch plugin source event.
2. Persist installed plugin registry and runtime config state.
3. Compute effective runtime plugin set.
4. Perform atomic in-memory engine swap.
5. Expose read model for list output.

Expected usage:

- CLI calls `PluginManager` directly.
- MCP tool handlers call `PluginManager` through service layer.

## 4.2 State model

Persist the following in settings (JSON-encoded values):

1. Installed plugin sources map (keyed by canonical plugin key).
2. Enablement map.
3. Weight override map.

Canonical plugin key:

```text
<pubkey>:<manifest.name>
```

This aligns with current namespaced metric strategy used by engine/runner outputs.

## 4.3 Runtime model

For each mutation call:

### `install`

1. Resolve source and validate event/manfiest.
2. Persist plugin as installed and available.
3. Set `enabled=false` by default unless explicitly requested.
4. No runtime activation unless enablement changes are requested.

### `config`

1. Validate full batch request.
2. Build candidate runtime state from current active + requested changes.
3. Attempt engine reload/swap with candidate state.
4. If swap succeeds, persist committed state and return success.
5. If swap fails, rollback to last known good active state and return structured error.

---

## 5. API Design (RPC-Friendly)

## 5.1 `install`

Purpose:

- Install one plugin source from event id or nevent with relay hints.

Input fields (high-level):

1. `source`: one of `eventId` or `nevent`
2. `relays`: optional relay hints
3. `enabled`: optional default false
4. `weightOverride`: optional

Behavior:

1. Resolve source to event.
2. Validate kind, manifest, compatibility, signature policy.
3. Upsert plugin in installed registry.
4. Persist plugin as installed and disabled by default.
5. If `enabled=true` is passed, activation happens through same atomic path as `config`.

## 5.2 `config`

Purpose:

- Batch configure multiple existing plugins in one call.

Input fields (high-level):

1. `changes`: array of mutations
   - `pluginKey`
   - optional `enabled`
   - optional `weightOverride`

Behavior:

1. Validate all plugin keys exist.
2. Validate all values.
3. Apply all changes as one atomic transaction.
4. Auto-apply runtime atomically.

Failure semantics:

- If one entry is invalid or unknown, whole request fails.

## 5.3 `list`

Purpose:

- Return current plugin runtime state only.

Default output fields per plugin:

1. `pluginKey`
2. `name`
3. `enabled`
4. `effectiveWeight`

Verbose mode adds:

1. `pubkey`
2. `title`
3. `description`
4. `versionInfo`
5. `defaultWeight` (if present in the plugin event)

No previous mutation history in v1, per product decision.

---

## 6. Integration Plan by Layer

## 6.1 Engine layer

Add runtime reload capability to [`EloPluginEngine`](../src/plugins/EloPluginEngine.ts:50).

Potential shape:

```ts
async reloadFromPlugins(input: {
  plugins: PortablePlugin[];
  weightOverrides: Record<string, number>;
  enabled: Record<string, boolean>;
}): Promise<void>
```

Requirements:

1. Recompute metric descriptions and resolved weights.
2. Swap active plugin set atomically.
3. Keep previous active set for rollback path.

## 6.2 Service layer

Extend [`IRelatrService`](../src/service/ServiceInterfaces.ts:69) and [`RelatrService`](../src/service/RelatrService.ts:22) with plugin management methods:

1. `installPlugin`
2. `configurePlugins`
3. `listPlugins`

`RelatrService` delegates to `PluginManager`.

## 6.3 Factory wiring

Update [`RelatrFactory.createRelatrService()`](../src/service/RelatrFactory.ts:37) to:

1. Create `PluginManager` after engine creation.
2. Inject settings repository + engine + relay dependencies.
3. Pass manager into service dependencies.

## 6.4 MCP server layer

In [`src/mcp/server.ts`](../src/mcp/server.ts), add three tools:

1. `plugins_install`
2. `plugins_config`
3. `plugins_list`

Keep strict schemas (zod) and deterministic structured responses.

Add admin authorization for mutating tools:

1. Introduce `ADMIN_PUBKEYS` env var as comma-separated pubkeys in [`loadConfig()`](../src/config.ts:104).
2. Add parsed field to [`RelatrConfig`](../src/types.ts:10), e.g. `adminPubkeys: string[]`.
3. For MCP tools, authorize via `clientPubkey` injected by transport in [`registerManageTATool()`](../src/mcp/server.ts:513) pattern.
4. Enforce admin checks for `plugins_install` and `plugins_config`; keep `plugins_list` readable.

## 6.5 CLI layer

Add command family aligned 1:1 with RPC:

1. `plugins install`
2. `plugins config`
3. `plugins list`

CLI should be thin wrappers over service calls.

---

## 7. Key Code Blocks to Reuse or Mirror

## 7.1 Loader validation flow

Reference from [`loadPluginFromFile()`](../src/plugins/PortablePluginLoader.ts:75):

```ts
if (rawEvent.kind !== RELATR_PLUGIN_KIND) {
  throw new Error(
    `Unsupported plugin kind '${rawEvent.kind}' (expected ${RELATR_PLUGIN_KIND})`,
  );
}

const manifest = parseManifestTags(rawEvent.tags);
const validation = validateManifest(manifest);
if (!validation.valid) {
  throw new Error(
    `Plugin manifest validation failed: ${validation.errors.join(', ')}`,
  );
}
```

## 7.2 Settings persistence pattern

Reference from [`SettingsRepository.set()`](../src/database/repositories/SettingsRepository.ts:43):

```ts
await this.writeConnection.run(
  "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ($1, $2, $3)",
  { 1: key, 2: value, 3: now },
);
```

## 7.3 MCP tool registration pattern

Reference from [`registerStatsTool()`](../src/mcp/server.ts:361):

```ts
server.registerTool(
  'stats',
  {
    title: 'Stats',
    inputSchema: inputSchema.shape,
    outputSchema: outputSchema.shape,
  },
  async () => { /* handler */ },
);
```

---

## 8. Risks and Mitigations

## 8.1 Runtime consistency risk

Risk:

- mutation persists config but runtime swap fails, creating drift.

Mitigation:

1. Two-phase internal flow (prepare candidate, swap, commit marker).
2. Rollback to previous in-memory snapshot on swap failure.
3. Return clear structured error payload.

## 8.2 Concurrent mutation risk

Risk:

- two RPC calls mutate plugin config simultaneously.

Mitigation:

1. Single process-level mutex around install/config.
2. Reject or serialize concurrent write operations.

## 8.3 Unknown plugin key batch config risk

Risk:

- partial success if one key is invalid.

Mitigation:

1. Validate all keys up front.
2. Fail entire request on any unknown plugin key.

## 8.4 Weight visibility confusion

Risk:

- operators cannot tell manifest weight vs override vs effective.

Mitigation:

1. `list` returns all three fields explicitly.
2. deterministic precedence documented in tool responses.

## 8.5 Source resolution reliability risk

Risk:

- relay fetch failures for event id/nevent install flow.

Mitigation:

1. retry over provided relay hints + defaults.
2. explicit timeout and actionable error messages.
3. persist successful source metadata for traceability.

---

## 9. Test Plan

## 9.1 Unit tests

1. `install` rejects invalid kind and incompatible manifest.
2. `install` accepts valid event and persists as disabled by default.
3. `config` batch unknown key fails atomically.
4. `config` batch mixed operations updates all-or-none.
5. Effective weight calculation correctness.

## 9.2 Integration tests

1. MCP tool flow: install -> list shows plugin available and disabled by default.
2. MCP config batch toggles enablement for multiple plugins atomically.
3. Runtime reload failure path rolls back to previous active set.
4. Concurrent config calls serialized correctly.
5. Non-admin pubkey cannot call mutating plugin tools.

## 9.3 Regression tests

1. Trust score computation unchanged when plugin state unchanged.
2. Existing plugin loader tests remain green.
3. Existing Elo runner behavior remains unaffected.

Suggested files for new tests:

- [`src/tests/plugin-management.test.ts`](../src/tests/plugin-management.test.ts)
- [`src/tests/mcp-plugin-tools.test.ts`](../src/tests/mcp-plugin-tools.test.ts)

---

## 10. Implementation Sequence

1. Define persistent plugin state schema and keys.
2. Implement `PluginManager` core with install/config/list.
3. Add atomic engine reload/swap method.
4. Wire manager in factory/service layers.
5. Add MCP tools and schemas.
6. Add CLI wrappers.
7. Add tests and run targeted suites.

---

## 11. Definition of Done

1. Operators can install plugins from event id or nevent.
2. Installed plugins are disabled by default unless explicitly enabled.
3. Operators can batch-configure multiple plugins in one call.
4. `list` default response is concise and includes key operational fields.
5. `list` verbose response exposes extended plugin details.
6. No restart required for plugin config activation changes.
7. Mutation operations are atomic and rollback-safe.
8. Admin pubkeys are enforced for MCP mutating plugin operations.
9. MCP and CLI both use same core manager logic.
10. Test suite includes atomicity, rollback, auth, and RPC contract coverage.
