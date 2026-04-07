# Relatr capability reference for plugin authors

Use only documented Relatr capability names and exact argument shapes.

## Most important gotcha

Graph capabilities use object-shaped arguments with exact field names.

## Capability summary

| Capability | Args | Returns | Safe default |
| --- | --- | --- | --- |
| `nostr.query` | object filter | list of events | `[]` |
| `http.nip05_resolve` | `{nip05: string}` | `{pubkey: string \\| null}` | `{pubkey: null}` |
| `graph.stats` | `{}` | stats object | zeroed stats object |
| `graph.all_pubkeys` | `{}` | `string[]` | `[]` |
| `graph.pubkey_exists` | `{pubkey}` | `boolean` | `false` |
| `graph.is_following` | `{followerPubkey, followedPubkey}` | `boolean` | `false` |
| `graph.are_mutual` | `{a, b}` | `boolean` | `false` |
| `graph.distance_from_root` | `{pubkey}` | `number` | `1000` |
| `graph.distance_between` | `{sourcePubkey, targetPubkey}` | `number` | `1000` |
| `graph.degree` | `{pubkey}` | `{outDegree, inDegree}` | `{outDegree: 0, inDegree: 0}` |
| `graph.degree_histogram` | `{pubkey}` | `{outDegree, inDegree, outDistanceHistogram, inDistanceHistogram}` | `{outDegree: 0, inDegree: 0, outDistanceHistogram: {}, inDistanceHistogram: {}}` |
| `graph.users_within_distance` | `{distance}` | `string[]` | `[]` |

## Invocation patterns

```elo
plan exists = do 'graph.pubkey_exists' {pubkey: _.targetPubkey} in
exists == true
```

```elo
plan follows = do 'graph.is_following' {followerPubkey: _.sourcePubkey, followedPubkey: _.targetPubkey} in
_.sourcePubkey != null and follows == true
```

```elo
plan mutual = do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey} in
_.sourcePubkey != null and mutual == true
```

```elo
plan d = do 'graph.distance_between' {sourcePubkey: _.sourcePubkey, targetPubkey: _.targetPubkey} in
if _.sourcePubkey != null and d <= 2 then 1.0 else 0.0
```

```elo
plan degree = do 'graph.degree' {pubkey: _.targetPubkey} in
let
  outDegree = fetch(degree | {}, .outDegree) | 0,
  inDegree = fetch(degree | {}, .inDegree) | 0
in
if inDegree >= 100 then 1.0
else if inDegree >= 20 then 0.6
else if outDegree >= 10 then 0.2
else 0.0
```

```elo
plan histogram = do 'graph.degree_histogram' {pubkey: _.targetPubkey} in
let
  h = histogram | {},
  outbound = fetch(h, .outDistanceHistogram) | {},
  inbound = fetch(h, .inDistanceHistogram) | {},
  reachableOutbound1 = fetch(outbound, ."1") | 0,
  reachableInbound1 = fetch(inbound, ."1") | 0
in
if reachableInbound1 >= 20 then 1.0
else if reachableOutbound1 >= 10 then 0.5
else 0.0
```

## Safe result handling

- lists: `events | []`
- objects: `obj | {}`
- optional fields: `fetch(obj, .field) | null`
- booleans: compare with `== true`
- degree objects: use `fetch(obj, .outDegree) | 0` and `fetch(obj, .inDegree) | 0`
- histogram objects: use `fetch(obj, .outDistanceHistogram) | {}` and string distance keys such as `fetch(hist, ."1") | 0`
- distances: treat `1000` as effectively unreachable

## Capability notes

### `nostr.query`

- query relays with a Nostr filter
- keep filters narrow
- always prefer explicit `limit`

### `http.nip05_resolve`

- args must be `{nip05: string}`
- treat the result object as nullable at the plugin boundary

### Graph capabilities

- always pass the documented object shape
- guard `_.sourcePubkey` before relationship checks when source context may be absent
- [`graph.degree_histogram`](relo/src/catalog.ts:179) returns root-aware neighbor histograms keyed by distance as strings when accessed from Elo, so use `fetch(hist, ."1") | 0` rather than assuming array-style indexing

## Authority

For authoring help, this reference is the working contract. For runtime behavior, the real authority is the capability surface actually exposed by the Relatr host running the plugin.
