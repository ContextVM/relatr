# Elo Plugin Writer's Guide (Relatr plugin-program format)

**Write portable scoring plugins for Relatr using the Elo language + the plugin-program format.**

This guide focuses on the _portable_ plugin content format (what you publish) and the _runtime semantics_ you should rely on.

Authoritative references:

- [`plans/relatr-plugins-spec-v1.md`](plans/relatr-plugins-spec-v1.md)
- [`plans/relatr-plugins-v0-to-v1-migration-and-host-policy.md`](plans/relatr-plugins-v0-to-v1-migration-and-host-policy.md)

---

## What is an Elo plugin?

An **Elo plugin** is a small program that computes a score in **[0.0, 1.0]** for a Nostr pubkey. Plugins run in a sandbox and may request external data via **capabilities**.

**Key idea**: your score expression is pure. The host handles provisioning, timeouts, retries, caching/deduplication, and failure mapping.

---

## Inputs you can use

Your plugin sees a single input object named `_`.

Common fields:

- `_.targetPubkey`: the pubkey being scored
- `_.sourcePubkey`: the scorer identity (or `null` if absent)
- `_.now`: current time (seconds) for this evaluation run

---

## The plugin-program structure

Relatr uses an explicit **round-based** program:

```text
plan <bindings> in
then <bindings> in
then <bindings> in
<score>
```

Where each round has comma-separated bindings:

```text
plan a = 1, b = 2 in a + b
```

Rules of thumb:

- **Bindings evaluate left-to-right** within a round.
- **No forward references** within a round (a binding cannot use a later binding).
- After each round, all `do` requests from that round are provisioned, and results become available to later rounds.

---

## Requesting external data with `do`

Use `do` as the _entire value_ of a binding:

```text
plan notes = do 'nostr.query' {kinds: [1], authors: [_.targetPubkey], limit: 20} in
let
  events = notes | [],
  n = length(events)
in
if n > 10 then 0.9 else if n > 5 then 0.7 else 0.4
```

Important constraints:

- `do` is only permitted in `plan`/`then` bindings (never in the final score expression).
- `do` cannot be nested inside another expression (e.g. inside `if`, object literals, function args).
  - Relatr enforces this at compile-time in [`compilePluginProgram()`](src/plugins/relatrPlanner.ts:53).

### JSON boundary for `do` args

`do` args must evaluate to **strict JSON** (objects, arrays, strings, numbers, booleans, `null`). Non-JSON values (e.g. `undefined`, `NaN`, `Infinity`, functions) are treated as unplannable.

Good:

```text
plan res = do 'test.echo' {x: 1, tags: ["a", "b"], ok: true} in 0.0
```

Bad (becomes unplannable → `null`):

```text
plan res = do 'test.echo' _.missing in 0.0
```

---

## Multi-step planning (chaining across rounds)

If request B depends on the _result_ of request A, use multiple rounds:

```text
plan profile = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1} in
then
  nip05 = fetch(first(profile | []), .nip05) | null,
  nip05_res = do 'http.nip05_resolve' {nip05: nip05}
in
if fetch(nip05_res, .pubkey) == _.targetPubkey then 1.0 else 0.0
```

How to think about it:

- Round 1 requests `profile`.
- Provisioning happens.
- Round 2 can read `profile` and build args for the next `do`.

---

## Failure semantics (design for `null`)

Relatr maps all capability-level failures to `null`:

- unknown/disabled capability
- handler exception
- timeout
- unplannable args (non-JSON)
- args evaluation exception (treated as unplannable in [`runPluginInternal()`](src/plugins/EloPluginRunner.ts:95))

Write your scoring so `null` is safe:

```text
plan res = do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey} in
if _.sourcePubkey == null then 0.0
else if res == true then 1.0
else 0.0
```

Practical patterns:

- `value | []` for lists
- `value | {}` for objects
- `value | null` for optional values

---

## Deduplication (write idempotent requests)

Within a single evaluation run, Relatr deduplicates requests by `(capName, argsJson)`.

Implications:

- Prefer stable, minimal args.
- Order of object keys does not matter (canonicalization makes `{a: 1, b: 2}` equivalent to `{b: 2, a: 1}`).
- If a request fails, that failure is cached as `null` for the rest of the evaluation run.

---

## Host policy limits (keep plugins bounded)

The host may enforce limits such as:

- maximum rounds per plugin
- maximum `do` calls per round
- maximum `do` calls per plugin

Write plugins that:

- keep chains short
- cap query sizes (`limit`)
- avoid unbounded loops / recursion

---

## Packaging your plugin (Nostr event)

Plugins are published as Nostr events, containing:

- `content`: the plugin program text (the `plan/then/.../score` program)
- tags/metadata describing the plugin

At minimum, include:

- `name`: stable identifier (`snake_case` or `kebab-case`)
- `relatr-version`: a **caret semver range** describing which Relatr versions this plugin is compatible with (e.g. `^0.1.16`)

Recommended:

- `title`
- `description`
- `weight` (0.0 to 1.0)

---

## Common patterns

### Pattern: tiered activity scoring

```text
plan notes = do 'nostr.query' {kinds: [1], authors: [_.targetPubkey], limit: 20} in
let
  events = notes | [],
  n = length(events)
in
if n > 10 then 0.9
else if n > 5 then 0.7
else if n > 0 then 0.4
else 0.0
```

### Pattern: combine multiple signals

```text
plan
  mutual = do 'graph.are_mutual' {a: _.sourcePubkey, b: _.targetPubkey},
  notes = do 'nostr.query' {kinds: [1], authors: [_.targetPubkey], limit: 20}
in
let
  activity = if length(notes | []) > 10 then 0.9 else 0.4
in
if _.sourcePubkey != null and mutual == true then 1.0 else activity
```

---

## Debugging checklist

If your plugin fails:

1. **Validate program structure**
   - `plan ... in then ... in <score>` is well-formed
   - no `do` in score
   - no nested `do`

2. **Validate args**
   - args evaluate to strict JSON
   - handle `null` everywhere

3. **Minimize**
   - reduce to a single round
   - reduce to a single `do`
   - then expand step-by-step

---

## Next steps

1. Read the v1 spec: [`plans/relatr-plugins-spec-v1.md`](plans/relatr-plugins-spec-v1.md)
2. Review host policy and migration notes: [`plans/relatr-plugins-v0-to-v1-migration-and-host-policy.md`](plans/relatr-plugins-v0-to-v1-migration-and-host-policy.md)
