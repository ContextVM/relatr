# Elo operators and functions for Relatr plugins

This is the high-signal subset of Elo operators and helpers most commonly used in Relatr plugins.

## Operators you will use most

### Arithmetic

```elo
_.now - 604800
n / 50
```

Use `+`, `-`, `*`, `/`, `%`, and `^` for normal numeric work.

### Comparison

```elo
n >= 12
mutual == true
```

Use `>`, `<`, `>=`, `<=`, `==`, and `!=`.

For booleans from capabilities, prefer explicit comparison with `== true`.

### Logical operators

```elo
_.sourcePubkey != null and mutual == true
```

Use `and`, `or`, and `not`.

### Fallback operator `|`

This returns the first non-null value.

```elo
notes | []
fetch(profile, .nip05) | null
fetch(nip05_res, .pubkey) | ''
```

Use it for nullable boundaries.

### Pipe operator `|>`

This passes the left value as the first argument to the function on the right.

```elo
'  hello  ' |> trim |> lower
```

In plugin authoring, this is less central than fallback `|`, and authors often confuse them.

## Most important operator distinction

Do not confuse these:

- `x | y` means “use `y` if `x` is null”
- `x |> f` means “pass `x` into function `f`”

Examples:

```elo
notes | []
```

```elo
'Alice@Example.com' |> lower
```

## Common helpers for plugin work

### `length()`

Count items in a list.

```elo
length(notes | [])
```

### `first()`

Take the first item from a list.

```elo
first(meta | [])
```

### `lower()`

Normalize strings for comparison.

```elo
lower(fetch(nip05_res, .pubkey) | '') == lower(_.targetPubkey)
```

### `fetch()`

Safely access a field using a path.

```elo
fetch(profile, .nip05) | null
fetch(ev, .content) | '{}'
```

### `Data()`

Parse JSON strings into Elo data structures.

```elo
profile = Data(fetch(ev, .content) | '{}')
```

### `isNull()` and `isNotNull()`

Useful when explicit null checks read more clearly than `== null`.

```elo
if isNull(nip05) then 0.0 else 1.0
```

## Plugin-focused patterns

### Safe list handling

```elo
let
  events = notes | [],
  n = length(events)
in
if n > 0 then 0.4 else 0.0
```

### Safe object handling

```elo
let
  obj = nip05_res | {},
  pubkey = fetch(obj, .pubkey) | null
in
if pubkey == null then 0.0 else 1.0
```

### Parse metadata content

```elo
let
  ev = first(meta | []),
  profile = Data(fetch(ev, .content) | '{}'),
  nip05 = fetch(profile, .nip05) | null
in
if nip05 == null then 0.0 else 1.0
```

## Common mistakes

- using `|>` where a nullable fallback `|` is needed
- calling `fetch()` without a fallback
- forgetting `Data()` when reading event `content`
- writing clever pipelines where a small `let` block would be clearer

## Practical recommendation

For Relatr plugins, optimize for readability over language cleverness. A short plugin with obvious fallbacks is better than a dense expression that hides null behavior.
