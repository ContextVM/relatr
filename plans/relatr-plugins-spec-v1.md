# Relatr portable Elo plugins — v1 spec (draft)

This document defines the v1 portable plugin format for Relatr, replacing the v0 `--RELATR` block convention in [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:1).

Status: draft for internal implementation.

---

## 1. Goals

Carry forward v0 goals:

- **Portable**: plugins can be shared and loaded across relatr instances.
- **Plannable**: host can discover external data dependencies before scoring.
- **Performant**: pre-provisioning enables batching and deduplication.
- **Robust**: failures are non-fatal; plugins default safely.

New v1 goal:

- **Multi-round chaining**: plugins can perform multi-step workflows where later capability args depend on earlier fetched results.

---

## 2. Inputs (`_`)

Plugins receive inputs via Elo’s standard `_` input.

Host-provided input schema (same as v0):

- `_.targetPubkey`: string
- `_.sourcePubkey`: string | null
- `_.now`: integer seconds since Unix epoch

---

## 3. Plugin program syntax

v1 plugins are expressed as a **plugin program** consisting of one or more planning rounds followed by a final score expression.

### 3.1 Canonical syntax (binder form)

```elo
plan <bindings> in <continuation>
```

Where `<continuation>` is either:

- another planning round:

```elo
then <bindings> in <continuation>
```

- or a terminal score expression:

```elo
<score-expr>
```

### 3.2 Binding list

Bindings are comma-separated assignments, like Elo `let` bindings.

Example:

```elo
plan
  metaArgs = {kinds: [0], authors: [_.targetPubkey], limit: 1},
  meta = do 'nostr.query' metaArgs
in
  length(meta | [])
```

---

## 4. External data primitive: `do`

### 4.1 Syntax

`do` is a special form used only within `plan/then` bindings:

```elo
<name> = do '<capName>' <args_expr>
```

Where:

- `<capName>` is a string literal, e.g. `'nostr.query'`.
- `<args_expr>` is an Elo expression evaluated at plan-time.

### 4.2 Semantics

- `do` does not execute during scoring.
- `do` emits a capability request during its round.
- The binding name receives the provisioned result (JSON-or-null).

---

## 5. Evaluation model

### 5.1 Rounds

- `plan` is round 1.
- Each `then` is the next round.

The host executes rounds sequentially:

1. Evaluate the round bindings in order.
2. Collect all `do` requests emitted in that round.
3. Dedupe and execute capability requests.
4. Bind provisioned results into the environment.
5. Proceed to the next round.

### 5.2 Ordered evaluation and no forward references

Within a round:

- Bindings are evaluated top-to-bottom.
- A binding may reference:
  - `_`
  - any bindings from previous rounds
  - any earlier bindings in the same round
- A binding must not reference bindings declared later in the same round.

### 5.3 Score execution

After the last round, the terminal score expression is evaluated once.

Score is compute-only:

- `do` is not permitted in the score expression.

---

## 6. JSON boundary rules

`do` arguments are evaluated at plan-time and must be **strict JSON** (or null).

Allowed JSON values:

- null
- boolean
- number
- string
- object/tuple
- array/list

Disallowed:

- DateTime, Duration
- functions/lambdas
- any non-JSON values

If args are non-JSON or evaluation fails, the request is treated as unplannable and the bound value becomes `null`.

---

## 7. Request deduplication

The host dedupes capability execution by a stable request key.

v1 does not prescribe the exact request-key encoding beyond:

- it must incorporate capName and canonical args JSON
- it must be stable across hosts

(Relatr currently uses a `capName + "\n" + canonicalJson(args)`-style key in v0; see v0 spec request-key description in [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:176).)

---

## 8. Failure semantics

Failures are non-fatal. All failures resolve to `null` values:

- capability disabled/unknown
- capability error/timeout
- args evaluation error
- args non-JSON

Score authors should treat `null` as safe negative signal (often returning `0.0`).

---

## 9. Example (multi-round chaining)

```elo
plan
  meta = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1}
in then
  profile = first(meta | []),
  nip05 = fetch(profile, .nip05) | null
in then
  nip05_result = if nip05 == null
    then null
    else do 'http.nip05_resolve' {nip05: nip05}
in
  if nip05_result != null then 1.0 else 0.0
```
