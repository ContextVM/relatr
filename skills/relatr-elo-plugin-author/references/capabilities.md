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

## Safe result handling

- lists: `events | []`
- objects: `obj | {}`
- optional fields: `fetch(obj, .field) | null`
- booleans: compare with `== true`
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

## Authority

For authoring help, this reference is the working contract. For runtime behavior, the real authority is the capability surface actually exposed by the Relatr host running the plugin.
