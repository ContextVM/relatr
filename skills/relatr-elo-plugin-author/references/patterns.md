# Safe plugin patterns

Use these as copy-adapt patterns, not as rules to cargo-cult.

## Recent note activity

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
else if n >= 12 then 0.75
else if n >= 2 then 0.3
else 0.0
```

Why it works:

- one bounded relay query
- safe list fallback
- clear score thresholds

## NIP-05 validation

```elo
plan
  meta = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1}
in then
  ev = first(meta | []),
  profile = Data(fetch(ev, .content) | '{}'),
  nip05 = fetch(profile, .nip05) | null,
  nip05_res = do 'http.nip05_resolve' {nip05: nip05}
in
if nip05 == null then 0.0
else if lower(fetch(nip05_res, .pubkey) | '') == lower(_.targetPubkey) then 1.0
else 0.0
```

Why it works:

- demonstrates `then`
- shows JSON parsing and safe field access
- keeps capability chaining explicit

## Reciprocity plus activity

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

Why it works:

- blends graph and relay signals
- preserves fallback behavior when no source pubkey exists

## Distance-based graph trust

```elo
plan
  d = do 'graph.distance_from_root' {pubkey: _.targetPubkey}
in
if d <= 1 then 1.0
else if d <= 2 then 0.7
else if d <= 4 then 0.3
else 0.0
```

Why it works:

- no relay access required
- operator-friendly scoring logic

## Simple existence guard

```elo
plan
  exists = do 'graph.pubkey_exists' {pubkey: _.targetPubkey}
in
if exists == true then 1.0 else 0.0
```

Why it works:

- minimal first plugin
- demonstrates the standard graph arg pattern

## Adaptation advice

- change thresholds before changing structure
- add one new capability at a time
- keep fallbacks in place even if the happy path looks reliable
- if a later step depends on an earlier result, move it to another `then` round
