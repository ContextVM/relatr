# Relatr Portable Plugins (Elo + Nostr) — Overview

## Elevator pitch

Relatr plugins become **portable, signed, shareable scoring kernels**: each plugin is a single **signed Nostr event** whose `content` is a pure **Elo** program and whose `tags` declare metadata + data requirements. Relatr fetches and normalizes the required inputs (events, graph computations, optional HTTP capabilities), runs the Elo program, and stores a single output: a **score in `[0,1]`**. Scores compose into trust exactly like today in [`TrustCalculator.calculate()`](src/trust/TrustCalculator.ts:42).

## Why this matters

- **Portability:** plugins can move between Relatr instances as Nostr events.
- **Customization:** operators can enable/disable plugins and override weights without patching code.
- **Composability:** trust becomes a weighted composition of many small metrics, matching today's validator model in [`ValidationPlugin.validate()`](src/validators/plugins.ts:29).
- **Safety:** Elo stays pure; IO and resource limits remain controlled by the host.

---

## Mental model

### What a plugin is

A plugin is one signed Nostr event:

- `content`: Elo expression (pure)
- `tags`: manifest
  - `name`: stable slug / metric key
  - `title`: human-readable name
  - `about`: description
  - `weight`: defaultWeight
  - optional: `cap` / `cap_arg` to request host capabilities

Relatr identifies the plugin by event id, and typically uses `name` as the stable metrics map key.

### What a plugin returns

Only a numeric score in `[0,1]` (runtime output minimal). This matches current aggregation behavior where failures fall back to `0.0` in [`ValidationRegistry.executeAll()`](src/validators/plugins.ts:54).

---

## User stories (how this plays out)

### 1) Bob creates a plugin

Bob writes a small Elo program and wraps it in a signed Nostr event with tags.

### 2) Carol curates a plugin pack

Carol shares a list of plugin event ids (or a directory of plugin JSON files) with recommended weights.

### 3) Alice installs and customizes

Alice enables a set of plugin ids (or drops JSON into a plugins folder), and locally overrides weights. The trust pipeline remains the same weighted composition implemented in [`calculateWeightedScore()`](src/trust/TrustCalculator.ts:132).

---

## Concrete examples (ports of existing validators)

The following examples are illustrative (the exact Elo stdlib details can evolve). The intent is to show how today's plugins in [`src/validators/plugins.ts`](src/validators/plugins.ts) translate into portable, data-driven scoring kernels.

### Example A: Root NIP-05 (port of [`RootNip05Plugin.validate()`](src/validators/plugins.ts:260))

Manifest tags (conceptual):

- `name`: `is_root_nip05`
- `title`: `Root NIP-05`
- `weight`: `0.15`
- `cap`: `nostr.query`
- `cap_arg`: `filter={"kinds": [0], "authors": [_.pubkey], "limit": 3}`

Elo content (conceptual):

```text
let
  events = fetch(_.cap, .nostr.query) | [],
  meta = first(events),
  profile = fetch(meta, .content) | {},
  nip05 = fetch(profile, .nip05) | null,
  normalized = if isNull(nip05)
    then null
    else if contains(nip05, '@')
      then nip05
      else '_@' + nip05,
  username = if isNull(normalized)
    then null
    else first(split(normalized, '@'))
in
if username == '_' then 1.0 else 0.0
```

### Example B: Flexible nostr query

Capability approach with maximum flexibility:

```text
let filter = {
  "kinds": [1, 7],
  "#p": [_.pubkey],
  "limit": 100
} in
let events = fetch(_.cap, .nostr.query) | [] in
count(events) / 100.0
```

### Example C: Reciprocity / mutual follows (port of [`ReciprocityPlugin.validate()`](src/validators/plugins.ts:230))

Graph computations are a good fit for host capabilities, keeping Elo pure:

```text
if fetch(_.cap, .graph.are_mutual) == true then 1.0 else 0.0
```

---

## When plugins need external IO (without breaking purity)

Plugins never do IO directly. Instead, they declare what they need and Relatr provides it.

### Capability-based provisioning

- Plugin declares `cap` + `cap_arg` in tags.
- Relatr executes the capability with operator-controlled policies (timeouts, caching).
- Results are injected into `_.cap` for Elo to consume.

V1 capability catalog (kept intentionally small but flexible):

- `nostr.query` -> `[nostr-event]` (accepts any filter, max 1000 events)
- `graph.stats` -> `{ totalFollows, uniqueFollowers, uniqueFollowed }`
- `graph.all_pubkeys` -> `[string]`
- `graph.pubkey_exists` -> boolean
- `graph.is_following` -> boolean
- `graph.are_mutual` -> boolean
- `graph.degree` -> `{ outDegree, inDegree }`
- `http.nip05_resolve` -> `{ pubkey: string | null }`

Operators control capabilities via environment config (e.g., `ENABLE_CAP_NOSTR_QUERY=false` to disable a capability, or `ENABLE_CAP_NOSTR_QUERY=true` to enable if default is disabled). Each capability declares its own default enabled/disabled state.

This keeps the system consistent with today's host-side behavior where IO can fail and safely maps to `0.0` (see [`ValidationRegistry.executeAll()`](src/validators/plugins.ts:54)).

---

## Inputs and determinism (why bounding matters)

Relatr provides an input object `_` that includes bounded event bundles by kind. Deterministic normalization rules (sorting + bounded lists) allow portable plugins to behave predictably.

- Default cap: up to 1000 events per kind
- Deterministic ordering: `created_at` desc, then `id` as tie-break
- Optional: verification flag or verified-only filtering

This is what enables set-based metrics (reactions, zaps, posting patterns) while avoiding unbounded queries.

---

## Caching strategy (simple)

- **Upsert on compute:** whenever a rank/metrics set is computed, metrics are upserted.
- **Recompute when stale:** time-based staleness, plus recompute when plugin set changes.
- **Periodic cleanup:** remove orphan metrics (old plugin sets / removed plugins) periodically.
- **Simple cache keys:** no graph snapshot IDs (occasional staleness acceptable)

This avoids complex invalidation while keeping results fresh.

---

## Where the detailed specs live

- Full design: [`plans/elo-plugins-design.md`](plans/elo-plugins-design.md)
- Narrative user story: [`plans/user-story-portable-plugins.md`](plans/user-story-portable-plugins.md)
