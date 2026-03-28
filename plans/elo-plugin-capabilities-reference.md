# Elo Plugin Capability Reference

This document describes the external capabilities currently exposed to Elo plugins in [`relatr`](package.json), with a focus on what plugin writers can safely rely on.

Primary implementation references:

- [`src/capabilities/capability-catalog.ts`](src/capabilities/capability-catalog.ts:20)
- [`src/capabilities/registerBuiltInCapabilities.ts`](src/capabilities/registerBuiltInCapabilities.ts:25)
- [`src/capabilities/CapabilityRegistry.ts`](src/capabilities/CapabilityRegistry.ts:9)

For general plugin-program semantics, see [`plans/elo-plugin-writers-guide.md`](plans/elo-plugin-writers-guide.md).

---

## Capability authoring model

From a plugin writer's perspective, every capability call has the same shape:

```elo
plan result = do '<capability-name>' <json-args> in
...
```

General rules:

- args must evaluate to strict JSON
- results should be treated as nullable
- failures should be treated as `null` at the plugin layer
- capability names are strings such as `nostr.query` or `graph.are_mutual`

---

## Availability note

The catalog in [`CAPABILITY_CATALOG`](src/capabilities/capability-catalog.ts:20) still includes `graph.degree`, but the built-in registration function [`registerBuiltInCapabilities()`](src/capabilities/registerBuiltInCapabilities.ts:25) does not register a handler for it. This reference documents only capabilities that are actually registered today.

---

## `nostr.query`

Implementation: [`nostrQuery`](src/capabilities/nostr/nostrQuery.ts:20)

### Purpose

Query the configured Nostr relays using a Nostr filter and return matching events.

### Expected args

Pass a Nostr filter object.

Typical fields include:

- `kinds`
- `authors`
- `ids`
- `since`
- `until`
- `limit`

Example:

```elo
plan notes = do 'nostr.query' {
  kinds: [1],
  authors: [_.targetPubkey],
  since: _.now - 86400,
  limit: 20
} in
length(notes | [])
```

### Return shape

Returns a list of Nostr event objects.

In practice, plugin writers commonly use fields like:

- `id`
- `pubkey`
- `created_at`
- `kind`
- `content`
- `tags`

### Runtime behavior

- Missing args return `[]`.
- Missing relay context returns `[]`.
- Relay failures return `[]`.
- If `limit` is omitted, Relatr sets it to `1000`.
- If `limit` is greater than `1000`, Relatr clamps it to `1000`.
- Results are sorted deterministically by `created_at` descending, then `id` ascending.

That deterministic ordering matters because `first(events)` will consistently mean “newest event” for the same returned set, as implemented in [`nostrQuery`](src/capabilities/nostr/nostrQuery.ts:78).

### Author guidance

- Always provide a narrow filter.
- Prefer explicit `limit` values smaller than `1000`.
- When reading profile metadata, pair `kinds: [0]` with `limit: 1`.
- Use `notes | []` before `length`, `first`, `map`, or `filter`.

---

## `http.nip05_resolve`

Implementation: [`httpNip05Resolve`](src/capabilities/http/httpNip05Resolve.ts:25)

### Purpose

Resolve a NIP-05 identifier such as `'alice@example.com'` to a pubkey.

### Expected args

Pass an object with a `nip05` field:

```elo
plan res = do 'http.nip05_resolve' {nip05: 'alice@example.com'} in
fetch(res, .pubkey) | null
```

### Return shape

Returns an object:

```json
{"pubkey": "<hex-pubkey-or-null>"}
```

So the practical read pattern is:

```elo
fetch(res, .pubkey) | null
```

### Runtime behavior

- Missing or invalid `nip05` returns `{pubkey: null}`.
- The host normalizes NIP-05 strings before caching and deduplication.
- Results may come from an in-memory per-run cache, a persistent cache, prepared validation facts, or a live HTTP fetch.
- Fetch failures return `{pubkey: null}`.

### Author guidance

- Treat the result object itself as nullable in plugin logic, even if the handler often returns an object.
- Treat `fetch(res, .pubkey) | null` as the canonical read pattern.
- Use this after fetching a profile event with [`nostr.query`](plans/elo-plugin-capabilities-reference.md) when validating a target's advertised NIP-05.

Example pattern:

```elo
plan
  meta = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1}
in then
  ev = first(meta | []),
  profile = Data(fetch(ev, .content) | '{}'),
  nip05 = fetch(profile, .nip05) | null,
  nip05_res = do 'http.nip05_resolve' {nip05: nip05}
in
if lower(fetch(nip05_res, .pubkey) | '') == lower(_.targetPubkey) then 1.0 else 0.0
```

---

## `graph.stats`

Implementation: [`graphStats`](src/capabilities/graph/graphStats.ts:9)

### Purpose

Return aggregate statistics for the currently loaded social graph.

### Expected args

No meaningful args are required. Pass `{}` or another trivial JSON value if you want to be explicit.

```elo
plan stats = do 'graph.stats' {} in
fetch(stats, .totalFollows) | 0
```

### Return shape

Returns an object with these fields:

- `totalFollows`
- `uniqueFollowers`
- `uniqueFollowed`

Safe-default return value when unavailable:

```json
{"totalFollows":0,"uniqueFollowers":0,"uniqueFollowed":0}
```

### Runtime behavior

- If the graph is not initialized, safe default stats are returned.
- If graph access fails, safe default stats are returned.

### Author guidance

- Useful for normalization or graph-density-aware heuristics.
- Use `fetch(stats, .field) | 0` instead of assuming a field exists.

---

## `graph.all_pubkeys`

Implementation: [`graphAllPubkeys`](src/capabilities/graph/graphAllPubkeys.ts:9)

### Purpose

Return all unique pubkeys currently present in the social graph.

### Expected args

No meaningful args are required.

```elo
plan pubkeys = do 'graph.all_pubkeys' {} in
length(pubkeys | [])
```

### Return shape

Returns a list of pubkey strings.

Safe default on unavailable graph or error: `[]`

### Runtime behavior

- If the graph is not initialized, returns `[]`.
- If graph access fails, returns `[]`.

### Author guidance

- This can be large, so use it cautiously.
- Prefer more targeted graph capabilities when possible.
- If you only need existence or a relationship check, use [`graph.pubkey_exists`](plans/elo-plugin-capabilities-reference.md) or [`graph.are_mutual`](plans/elo-plugin-capabilities-reference.md) instead.

---

## `graph.pubkey_exists`

Implementation: [`graphPubkeyExists`](src/capabilities/graph/graphPubkeyExists.ts:9)

### Purpose

Check whether a pubkey exists in the loaded social graph.

### Expected args

Current implementation reads `args[0]`, so use a one-element JSON array:

```elo
plan exists = do 'graph.pubkey_exists' [_.targetPubkey] in
if exists == true then 1.0 else 0.0
```

### Return shape

Returns a boolean.

Safe default on unavailable graph or error: `false`

### Runtime behavior

- Missing pubkey arg causes the handler to throw internally.
- At the plugin layer, failures should be treated as `null`, so authors should still program defensively.
- If the graph is not initialized, returns `false`.

### Author guidance

- Prefer the exact argument shape used by the current implementation: a one-element array.
- If you need a more self-describing call shape, document it locally in your plugin comments because this capability currently does not use named-object args.

---

## `graph.is_following`

Implementation: [`graphIsFollowing`](src/capabilities/graph/graphIsFollowing.ts:9)

### Purpose

Check whether one pubkey directly follows another in the social graph.

### Expected args

Current implementation reads `args[0]` and `args[1]`, so use a two-element JSON array:

```elo
plan follows = do 'graph.is_following' [_.sourcePubkey, _.targetPubkey] in
if _.sourcePubkey != null and follows == true then 1.0 else 0.0
```

### Return shape

Returns a boolean.

Safe default on unavailable graph or error: `false`

### Runtime behavior

- Missing args cause the handler to throw internally.
- If the graph is not initialized, returns `false`.
- Errors are converted into safe plugin-layer failure behavior.

### Author guidance

- Guard against `_.sourcePubkey == null` before calling or before using the result.
- Use [`graph.are_mutual`](plans/elo-plugin-capabilities-reference.md) when reciprocity matters more than one-way follow state.

---

## `graph.are_mutual`

Implementation: [`graphAreMutual`](src/capabilities/graph/graphAreMutual.ts:9)

### Purpose

Check whether two pubkeys follow each other.

### Expected args

This capability expects a named object with fields `a` and `b`:

```elo
plan mutual = do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey} in
if _.sourcePubkey != null and mutual == true then 1.0 else 0.0
```

### Return shape

Returns a boolean.

Safe default on unavailable graph or error: `false`

### Runtime behavior

- Missing `a` or `b` causes the handler to throw internally.
- If the graph is not initialized, returns `false`.
- Errors are isolated from the rest of the plugin evaluation.

### Author guidance

- This is currently the most ergonomic graph relationship capability because it uses named args.
- Prefer it when building reciprocity-based trust heuristics.

---

## `graph.distance_from_root`

Implementation: [`graphDistanceFromRoot`](src/capabilities/graph/graphDistanceFromRoot.ts:9)

### Purpose

Get the hop distance from the current graph root to a target pubkey.

### Expected args

Pass an object with a `pubkey` field:

```elo
plan d = do 'graph.distance_from_root' {pubkey: _.targetPubkey} in
if d <= 2 then 1.0 else 0.0
```

### Return shape

Returns a number representing hop distance.

Safe default on unavailable graph or error: `1000`

### Runtime behavior

- If the graph is not initialized, returns `1000`.
- If the pubkey is unreachable, the underlying graph returns `1000`.
- Errors are isolated and mapped to a safe default.

### Author guidance

- Use this when the current graph root is the relevant trust anchor.
- Treat `1000` as effectively unreachable.

---

## `graph.distance_between`

Implementation: [`graphDistanceBetween`](src/capabilities/graph/graphDistanceBetween.ts:9)

### Purpose

Get the hop distance between two arbitrary pubkeys.

### Expected args

Pass an object with `sourcePubkey` and `targetPubkey`:

```elo
plan d = do 'graph.distance_between' {sourcePubkey: _.sourcePubkey, targetPubkey: _.targetPubkey} in
if _.sourcePubkey != null and d <= 2 then 1.0 else 0.0
```

### Return shape

Returns a number representing hop distance.

Safe default on unavailable graph or error: `1000`

### Runtime behavior

- If the graph is not initialized, returns `1000`.
- If either pubkey is unreachable, the underlying graph returns `1000`.
- Errors are isolated and mapped to a safe default.

### Author guidance

- Prefer this over root-relative distance when your plugin semantics care about a specific source-target pair.
- Guard `_.sourcePubkey` before relying on it.

---

## `graph.users_within_distance`

Implementation: [`graphUsersWithinDistance`](src/capabilities/graph/graphUsersWithinDistance.ts:9)

### Purpose

Get all pubkeys reachable from the current graph root within a maximum hop distance.

### Expected args

Pass an object with a numeric `distance` field:

```elo
plan users = do 'graph.users_within_distance' {distance: 2} in
length(users | [])
```

### Return shape

Returns a list of pubkey strings.

Safe default on unavailable graph or error: `[]`

### Runtime behavior

- If the graph is not initialized, returns `[]`.
- Invalid distance args fail at the handler boundary and are isolated from the rest of plugin evaluation.

### Author guidance

- This can return a large set for bigger radii, so keep distances tight.
- Use it when you need root-relative reachability rather than pairwise distance.

---

## Capability shape summary

| Capability | Current args shape | Typical result shape | Safe default |
| --- | --- | --- | --- |
| `nostr.query` | object filter | list of Nostr events | `[]` |
| `http.nip05_resolve` | `{nip05: string}` | `{pubkey: string \| null}` | `{pubkey: null}` |
| `graph.stats` | `{}` | stats object | zeroed stats object |
| `graph.all_pubkeys` | `{}` | `string[]` | `[]` |
| `graph.pubkey_exists` | `[pubkey]` | `boolean` | `false` |
| `graph.is_following` | `[follower, followed]` | `boolean` | `false` |
| `graph.are_mutual` | `{a: pubkey, b: pubkey}` | `boolean` | `false` |
| `graph.distance_from_root` | `{pubkey}` | `number` | `1000` |
| `graph.distance_between` | `{sourcePubkey, targetPubkey}` | `number` | `1000` |
| `graph.users_within_distance` | `{distance}` | `string[]` | `[]` |

The mixed argument conventions are important for plugin authors today: some graph capabilities currently expect arrays while others expect named objects. If these APIs are normalized later, this document should be updated together with [`plans/elo-plugin-writers-guide.md`](plans/elo-plugin-writers-guide.md).
