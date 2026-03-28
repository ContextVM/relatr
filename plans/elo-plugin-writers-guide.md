# Elo Plugin Writer's Guide

**Write portable Elo scoring plugins for [`relatr`](package.json) using the v1 plugin-program format.**

This guide is for plugin authors who want to publish portable plugins as Nostr events and rely on the host runtime in [`relatr`](package.json) to provision external data. It focuses on author-facing semantics rather than internal implementation details.

Authoritative references:

- [`plans/relatr-plugins-spec-v1.md`](plans/relatr-plugins-spec-v1.md)
- [`plans/elo-plugin-capabilities-reference.md`](plans/elo-plugin-capabilities-reference.md)
- [`plans/elo-reference.md`](plans/elo-reference.md)

---

## What is an Elo plugin?

An Elo plugin is a small program that produces a score in **[0.0, 1.0]** for a target Nostr pubkey.

- Your plugin logic is written in Elo.
- External data access happens through `do '<capability>' <args>`.
- The host handles execution, batching, deduplication, timeouts, and failure isolation.

In [`relatr`](package.json), portable plugins are loaded from Nostr kind `765` events and executed by the planner/runner in [`src/plugins/relatrPlanner.ts`](src/plugins/relatrPlanner.ts:50) and [`src/plugins/EloPluginRunner.ts`](src/plugins/EloPluginRunner.ts:47).

---

## Inputs available to your plugin

Plugins receive a single input object named `_`.

Available fields:

- `_.targetPubkey`: the pubkey being scored
- `_.sourcePubkey`: the source/scorer pubkey, or `null` when unavailable
- `_.now`: current Unix time in whole seconds for the evaluation run

`_.now` is fixed once per evaluation run so multiple plugins executed together see the same time value, as implemented in [`runPlugins()`](src/plugins/EloPluginRunner.ts:389).

---

## Plugin-program structure

Relatr uses the v1 **round-based plugin program** format.

```elo
plan <bindings> in
then <bindings> in
then <bindings> in
<score-expression>
```

Each round contains comma-separated bindings, similar to Elo `let` bindings.

Example:

```elo
plan a = 1, b = 2 in a + b
```

Important runtime rules:

- Bindings evaluate left-to-right within a round.
- A binding may use earlier bindings in the same round.
- A binding may use bindings from previous rounds.
- A binding may **not** use a later binding from the same round.
- After each round, all plannable `do` requests from that round are provisioned before the next round begins.

These constraints are enforced by the planner in [`compilePluginProgram()`](src/plugins/relatrPlanner.ts:50).

---

## Using `do` to request external data

Use `do` only as the **entire right-hand side** of a `plan` or `then` binding.

```elo
plan notes = do 'nostr.query' {kinds: [1], authors: [_.targetPubkey], limit: 20} in
let
  events = notes | [],
  n = length(events)
in
if n > 10 then 0.9 else if n > 5 then 0.7 else 0.4
```

Rules:

- `do` is allowed only in `plan` and `then` bindings.
- `do` is not allowed in the final score expression.
- `do` cannot be nested inside `if`, tuples, arrays, function calls, or any other expression.
- `do` cannot be nested inside the args expression of another `do`.

Those restrictions are checked in [`exprContainsDoCall()`](src/plugins/relatrPlanner.ts:85) and [`compilePluginProgram()`](src/plugins/relatrPlanner.ts:50).

### JSON boundary for `do` args

Capability args are evaluated at plan time and must produce strict JSON:

- `null`
- booleans
- numbers
- strings
- arrays/lists
- objects/tuples

Non-JSON values are unplannable, including temporal values, lambdas, `undefined`, `NaN`, and other runtime-only values.

If args evaluation throws or produces non-JSON, Relatr does not fail the whole plugin. Instead, the request becomes unplannable and that binding resolves to `null`, as handled in [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:102).

Good:

```elo
plan res = do 'test.echo' {x: 1, tags: ['a', 'b'], ok: true} in 0.0
```

Bad:

```elo
plan res = do 'test.echo' _.missing in 0.0
```

---

## Multi-round planning

If one external request depends on the result of an earlier request, split it into multiple rounds.

```elo
plan profile_events = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1} in
then
  profile_event = first(profile_events | []),
  profile = Data(fetch(profile_event, .content) | '{}'),
  nip05 = fetch(profile, .nip05) | null,
  nip05_res = do 'http.nip05_resolve' {nip05: nip05}
in
if nip05 == null then 0.0
else if lower(fetch(nip05_res, .pubkey) | '') == lower(_.targetPubkey) then 1.0
else 0.0
```

How the runtime sees this:

1. Round 1 plans and provisions `profile_events`.
2. Round 2 can read `profile_events`, compute `nip05`, then plan `nip05_res`.
3. The final score uses already-provisioned values.

Per-round execution and end-of-round provisioning are implemented in [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:159).

---

## Failure semantics: always design for `null`

Plugin authors should assume any external request can resolve to `null`.

Relatr maps request failures to `null` at the plugin boundary, including:

- unknown or disabled capabilities
- handler errors
- timeouts
- args evaluation failure
- args that are not valid JSON

For plugin authors, the practical rule is simple: **treat capability results as nullable** and provide safe fallbacks.

Example:

```elo
plan mutual = do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey} in
if _.sourcePubkey == null then 0.0
else if mutual == true then 1.0
else 0.0
```

Useful fallback idioms:

- `value | []` for lists
- `value | {}` for objects
- `value | null` for optional scalars
- `fetch(obj, .field) | null` for optional fields

The runner also clamps final numeric output into `[0.0, 1.0]` and converts non-numeric or non-finite score values to `0.0`, as implemented in [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:333).

---

## Deduplication and request identity

Relatr deduplicates requests by capability name plus canonical JSON args.

Practical implications:

- Prefer stable, minimal args.
- Repeating the same request in one round does not force multiple executions.
- Repeating the same request across rounds or across plugins in the same evaluation run can still be deduplicated.
- A failed request result is reused just like a successful one for the rest of that evaluation scope.

This behavior is driven by request keys in [`src/plugins/requestKey.ts`](src/plugins/requestKey.ts), the planning store in [`src/plugins/PlanningStore.ts`](src/plugins/PlanningStore.ts), and round scheduling in [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:177).

### Special case: NIP-05 normalization

For `http.nip05_resolve`, Relatr normalizes the `nip05` argument before generating the request key so equivalent casing and formatting do not create duplicate requests. This happens in [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:216) and [`normalizeNip05()`](src/capabilities/http/utils/httpNip05Normalize.ts:1).

---

## Host policy limits

Relatr enforces host policy limits to keep plugins bounded.

Current default limits:

- maximum rounds per plugin: `8`
- maximum plannable requests per round: `32`
- maximum plannable requests per plugin: `128`

These defaults are defined in [`DEFAULT_HOST_POLICY_LIMITS`](src/plugins/EloPluginRunner.ts:37).

Author guidance:

- keep request chains short
- keep query filters narrow
- use explicit `limit` values for relay queries
- avoid patterns that multiply requests based on large external result sets

---

## Current built-in capabilities

The built-in capability catalog currently includes:

- `nostr.query`
- `http.nip05_resolve`
- `graph.stats`
- `graph.all_pubkeys`
- `graph.pubkey_exists`
- `graph.is_following`
- `graph.are_mutual`
- `graph.distance_from_root`
- `graph.distance_between`
- `graph.users_within_distance`

These are registered in [`registerBuiltInCapabilities()`](src/capabilities/registerBuiltInCapabilities.ts:25) and cataloged in [`CAPABILITY_CATALOG`](src/capabilities/capability-catalog.ts:20).

There is also a `graph.degree` entry in [`CAPABILITY_CATALOG`](src/capabilities/capability-catalog.ts:20), but there is no corresponding built-in registration in [`registerBuiltInCapabilities()`](src/capabilities/registerBuiltInCapabilities.ts:25). Plugin-writer-facing docs should therefore treat it as **not currently available** unless and until the runtime registers it.

For capability-by-capability argument and result guidance, see [`plans/elo-plugin-capabilities-reference.md`](plans/elo-plugin-capabilities-reference.md).

---

## Packaging your plugin as a Nostr event

Portable plugins are published as Nostr kind `765` events.

Required pieces:

- `kind`: `765`
- `content`: the plugin program text
- `tags`: manifest metadata

Required tags:

- `n`: stable plugin identifier
- `relatr-version`: compatible Relatr semver range

Recommended tags:

- `title`
- `description`
- `weight`

Example:

```json
{
  "kind": 765,
  "content": "plan notes = do 'nostr.query' {...} in ...",
  "tags": [
    ["n", "activity_notes"],
    ["relatr-version", "^0.1.16"],
    ["title", "Activity score (notes)"],
    ["description", "Scores higher for more recent notes."]
  ]
}
```

Manifest fields are parsed into the internal plugin model described by [`PluginManifest`](src/plugins/plugin-types.ts:47).

### Versioning model

Relatr versioning for published plugin events is based on Nostr event ordering:

- same author pubkey
- same `n` tag
- newer `created_at` means newer version
- if timestamps tie, compare event `id` lexicographically

See [`plans/relatr-plugins-spec-v1.md`](plans/relatr-plugins-spec-v1.md) for the detailed format rules.

---

## Common authoring patterns

### Pattern: activity score from recent notes

```elo
plan
  notes = do 'nostr.query' {
    kinds: [1],
    authors: [_.targetPubkey],
    since: _.now - 604800,
    limit: 50
  }
in
let
  events = notes | [],
  n = length(events)
in
if n >= 30 then 1.0
else if n >= 20 then 0.9
else if n >= 12 then 0.75
else if n >= 6 then 0.55
else if n >= 2 then 0.3
else if n >= 1 then 0.15
else 0.0
```

This matches the style of the shipped sample plugin in [`plugins/elo/d1df386be09e06a7f015c2d6bffed7c96ad749b64ecbed42613efed489967015-activity_notes.json`](plugins/elo/d1df386be09e06a7f015c2d6bffed7c96ad749b64ecbed42613efed489967015-activity_notes.json).

### Pattern: NIP-05 validation against target pubkey

```elo
plan
  meta = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1}
in then
  events = meta | [],
  ev = first(events),
  profile = Data(fetch(ev, .content) | '{}'),
  nip05 = fetch(profile, .nip05) | null,
  nip05_res = do 'http.nip05_resolve' {nip05: nip05}
in
if nip05 == null then 0.0
else if lower(fetch(nip05_res, .pubkey) | '') == lower(_.targetPubkey) then 1.0
else 0.0
```

This mirrors the shipped example in [`plugins/elo/0f0c15457799aac79848730a6d466cd89bec73ad59973b4c52431bd2890974fe-nip05_valid.json`](plugins/elo/0f0c15457799aac79848730a6d466cd89bec73ad59973b4c52431bd2890974fe-nip05_valid.json).

### Pattern: combine direct graph relationship with activity

```elo
plan
  mutual = do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey},
  notes = do 'nostr.query' {kinds: [1], authors: [_.targetPubkey], limit: 20}
in
let
  activity = if length(notes | []) > 10 then 0.8 else if length(notes | []) > 0 then 0.4 else 0.0
in
if _.sourcePubkey != null and mutual == true then 1.0 else activity
```

---

## Debugging checklist for plugin authors

If a plugin behaves unexpectedly:

1. **Validate structure**
   - `do` appears only as a full binding RHS
   - no nested `do`
   - no `do` in the final score expression

2. **Validate args**
   - args evaluate to strict JSON
   - nullable inputs are handled explicitly
   - large relay queries include an explicit `limit`

3. **Minimize**
   - reduce to one round
   - reduce to one external request
   - confirm the returned shape before composing more logic

4. **Treat every capability result as nullable**
   - use `| []`, `| {}`, and `| null`
   - use `fetch(... ) | null` instead of assuming fields exist

---

## Recommended reading order

1. [`plans/relatr-plugins-spec-v1.md`](plans/relatr-plugins-spec-v1.md)
2. [`plans/elo-plugin-capabilities-reference.md`](plans/elo-plugin-capabilities-reference.md)
3. [`plans/elo-reference.md`](plans/elo-reference.md)
