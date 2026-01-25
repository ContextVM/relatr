# Relatr plugins v0 → v1 migration + host execution policy

This document defines:

1. a mechanical migration mapping from v0 (`--RELATR` + `_.planned`/`_.provisioned`) to v1 (plan/then + bindings)
2. host execution policy defaults for robust operation

---

## 1. Summary of what changes

v0:

- Declares capability requests inside `--RELATR` blocks (v0 spec: [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:66)).
- Host extracts blocks and strips them before compilation.
- Plan-time uses `_.planned`, score-time uses `_.provisioned`.

v1:

- Plugin is a program with explicit planning rounds: `plan ... in then ... in <expr>`.
- Host does not strip blocks; instead it parses the program and executes rounds.
- Provisioned values are in normal bindings (`meta`, `mutual`, etc.).

---

## 2. Mechanical mapping table

### 2.1 Capability declaration mapping

v0 declaration line:

```text
cap meta = nostr.query {kinds: [0], authors: [_.targetPubkey], limit: 1}
```

v1 binding:

```elo
meta = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1}
```

Notes:

- capability name becomes a string literal.
- args expression stays Elo.

### 2.2 Score-side lookup mapping

v0 score uses provisioned map:

```elo
let events = fetch(_.provisioned, .meta) | [] in ...
```

v1 score uses binding directly:

```elo
let events = meta | [] in ...
```

### 2.3 v0 sequential planning (`_.planned`) mapping

v0 planned values:

- earlier capability args may refer to `_.planned.<id>`.

v1 equivalent:

- split into rounds with bindings.
- refer directly to earlier bindings.

Example mapping:

v0:

```text
cap meta = nostr.query {kinds:[0], authors:[_.targetPubkey], limit: 1}
cap nip05 = http.nip05_resolve {nip05: fetch(first(_.provisioned.meta), .nip05)}
```

v1:

```elo
plan
  meta = do 'nostr.query' {kinds:[0], authors:[_.targetPubkey], limit: 1}
in then
  profile = first(meta | []),
  nip05 = fetch(profile, .nip05) | null
in then
  nip05_result = if nip05 == null then null else do 'http.nip05_resolve' {nip05: nip05}
in
  ...
```

---

## 3. Host execution policy defaults

These defaults exist to keep the system robust and performant.

### 3.1 Limits

- `maxRoundsPerPlugin`: cap the number of `then` rounds allowed.
- `maxRequestsPerRound`: cap the number of `do` calls in a single round.
- `maxTotalRequestsPerPlugin`: optional global cap across all rounds.

### 3.2 Timeouts

- `capTimeoutMs`: timeout per capability execution.
- `pluginTimeoutMs`: total timeout across all rounds + scoring.

(Relatr currently applies these in [`runPlugin()`](src/plugins/EloPluginRunner.ts:26).)

### 3.3 Dedupe strategy

- Dedupe within a single evaluation run across all plugins using a shared store, similar to current behavior in [`runPlugins()`](src/plugins/EloPluginRunner.ts:151).
- Dedupe key is host-defined (v0 uses canonical JSON, see [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:176)).

### 3.4 Failure mapping

Any of the following results in a `null` binding value for the corresponding `do`:

- args evaluation error or non-JSON args
- unknown/disabled capability
- timeout
- runtime error

### 3.5 Inspectability outputs (recommended)

For each plugin evaluation, the host SHOULD be able to expose:

- per round planned requests:
  - `(roundIndex, bindingName, capName, argsJson, requestKey)`
- per round outcomes:
  - `(requestKey -> ok | null | error)`

---

## 4. Relatr host integration plan (high level)

Replace v0 planning implementation:

- block extraction in [`src/plugins/relatrBlocks.ts`](src/plugins/relatrBlocks.ts:15)
- line parsing + sequential args evaluation in [`src/plugins/relatrPlanner.ts`](src/plugins/relatrPlanner.ts:47)

With v1 program execution:

- parse plugin program once
- for each round:
  - evaluate pure bindings
  - compute `do` args
  - dedupe+batch execute
  - bind results
- compute final score by compiling the terminal score expression

---

## 5. Deprecation approach (internal)

Since the system is not public yet:

- port existing v0 tests into v1 golden tests
- Clean up v0 related code
- Dont deprecate, better remove.
