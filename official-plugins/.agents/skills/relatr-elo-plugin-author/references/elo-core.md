# Elo core for Relatr plugin authors

This reference is the compact Elo primer for writing Relatr plugins. It covers only the subset most useful for plugin work.

## Core mental model

Normal Elo expressions transform values. Relatr plugin programs add a round-based outer structure so the host can plan and provision capability requests safely.

Use this split:

- use normal Elo for computation
- use `plan` / `then` for staged request collection
- use `do` only to ask the host for a capability result

## Values you will use most

- numbers: `1`, `0.75`, `86400`
- strings: `'alice@example.com'`
- booleans: `true`, `false`
- null: `null`
- lists: `[1, 2, 3]`
- tuples / objects: `{nip05: 'alice@example.com', limit: 1}`

These matter because capability args must stay JSON-shaped.

## Input object

Relatr plugins receive one input object named `_`.

- `_.targetPubkey`
- `_.sourcePubkey`
- `_.now`

Examples:

```elo
_.targetPubkey
_.sourcePubkey != null
_.now - 604800
```

## Variables with `let`

Use `let` for pure computation after values are already available.

```elo
let
  events = notes | [],
  n = length(events)
in
if n > 5 then 0.8 else 0.2
```

Do not use `let` as the place for a `do` call.

## Conditionals

Most plugins turn observed data into a score with `if ... then ... else ...`.

```elo
if n >= 30 then 1.0
else if n >= 12 then 0.75
else 0.0
```

## Tuples and lists

Capability args are usually tuples and results are often lists or tuples.

```elo
{kinds: [1], authors: [_.targetPubkey], limit: 20}
```

## Paths and field access

Use paths like `.content` or `.nip05` with `fetch`.

```elo
fetch(profile, .nip05) | null
fetch(event, .content) | '{}'
```

## Parsing JSON strings with `Data()`

Nostr metadata event content often arrives as a JSON string. Parse it before inspecting fields.

```elo
profile = Data(fetch(ev, .content) | '{}')
```

## Rule of thumb: `let` vs `plan`

- use `let` for pure transformations
- use `plan` or `then` when a binding needs `do`

Valid:

```elo
plan notes = do 'nostr.query' {kinds: [1], authors: [_.targetPubkey], limit: 20} in
let
  events = notes | [],
  n = length(events)
in
if n > 5 then 0.8 else 0.2
```

Invalid model:

```elo
let notes = do 'nostr.query' {kinds: [1]} in 0.0
```

## Most useful reading pattern

When reading a plugin, scan in this order:

1. what comes from `_`
2. what capability calls are made with `do`
3. what fallbacks are applied
4. how the final condition maps values to `[0.0, 1.0]`
