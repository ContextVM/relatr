# Relatr plugin authoring model

## What a Relatr plugin is

A Relatr plugin is a small Elo program that returns a score in `[0.0, 1.0]` for a target pubkey. The host composes plugin outputs with weights into a larger trust model.

## Inputs

Plugins receive `_` with:

- `_.targetPubkey`
- `_.sourcePubkey`
- `_.now`

## Program shape

Relatr uses round-based plugin programs.

```elo
plan <bindings> in
then <bindings> in
<score-expression>
```

Rules:

- bindings evaluate left-to-right within a round
- later rounds may depend on earlier rounds
- a binding may not depend on a later binding in the same round
- end-of-round provisioning happens before the next round begins

## `do`

Use `do` only as a full binding right-hand side inside `plan` or `then`.

Valid:

```elo
plan notes = do 'nostr.query' {kinds: [1], authors: [_.targetPubkey], limit: 20} in
length(notes | [])
```

Invalid:

```elo
if do 'graph.pubkey_exists' {pubkey: _.targetPubkey} then 1.0 else 0.0
```

Also invalid:

```elo
let x = [do 'nostr.query' {kinds: [1]}] in 0.0
```

## JSON boundary for capability args

Args must evaluate to strict JSON:

- null
- booleans
- numbers
- strings
- arrays
- objects

Avoid runtime-only values and non-JSON constructs in capability args.

## Null semantics

Treat all capability results as nullable.

Use patterns like:

- `notes | []`
- `res | {}`
- `fetch(obj, .field) | null`

## Multi-round design

If one request depends on earlier fetched data, split it into another round.

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

## Author constraints worth preserving

- keep request chains short
- keep relay queries bounded with explicit `limit`
- keep each plugin focused on one signal
- prefer readable thresholds over hidden heuristics

## Runtime reality

Capabilities are host-provided, not language-defined. Runtime availability depends on what the host actually exposes, not on what a plugin tries to call.
