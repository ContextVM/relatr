# TS Validator → Elo Portable Plugin mappings (v0)

This document provides concrete mappings from the legacy TypeScript validation plugins to the revised v0 portable Elo plugin format described in [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:1).

The goal is to sanity-check the authoring ergonomics and confirm the RELATR block model supports the existing validator set.

## Common conventions

### Inputs

These examples assume the standard v0 input described in [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:41):

- `_.targetPubkey`
- `_.sourcePubkey`
- `_.now`
- `_.provisioned`

### Capability results

Capability results are available under `_.provisioned.<id>` where `<id>` is the identifier declared in the RELATR block.

Failures/unavailable capabilities/unplannable args resolve to `null`.

### Plan-time results

Args expressions inside RELATR blocks can reference the JSON results of earlier declarations via:

- `_.planned.<id>`

### Notes on legacy context fields

The legacy TS context included `ctx.profile`, `ctx.pool`, `ctx.graphManager`, etc. In the portable model:

- Anything requiring IO is modeled as a capability.
- The host owns pooling/relays/repositories/caching.

## 1) Root NIP-05 (port of `RootNip05Plugin`)

Legacy behavior: if `ctx.profile?.nip05` is present, normalize it, and return `1.0` only if the username portion is `_`.

Portable model:

- Fetch metadata event(s) via `nostr.query`.
- Extract `.content.nip05`.

```text
--RELATR
cap meta = nostr.query {kinds: [0], authors: [_.targetPubkey], limit: 1}
--RELATR

let
  events = fetch(_.provisioned, .meta) | [],
  meta = first(events),
  profile = fetch(meta, .content) | {},
  nip05 = fetch(profile, .nip05) | null,
  normalized =
    if nip05 == null then null
    else if contains(nip05, '@') then nip05
    else '_@' + nip05,
  username =
    if normalized == null then null
    else first(split(normalized, '@'))
in
if username == '_' then 1.0 else 0.0
```

## 2) NIP-05 valid (port of `Nip05Plugin`)

Legacy behavior: if profile has `nip05`, query it (network) and compare returned pubkey.

Portable model:

- Fetch profile nip05 via `nostr.query`.
- Resolve nip05 via `http.nip05_resolve`.

This mapping requires **plan-time Elo args evaluation** so the second request can be derived from the first result.

```text
--RELATR
cap meta = nostr.query {kinds: [0], authors: [_.targetPubkey], limit: 1}
cap nip05_res = http.nip05_resolve(
  let
    events = fetch(_.planned, .meta) | [],
    meta = first(events),
    profile = fetch(meta, .content) | {},
    nip05_raw = fetch(profile, .nip05) | null,
    nip05 =
      if nip05_raw == null then null
      else if contains(nip05_raw, '@') then nip05_raw
      else '_@' + nip05_raw
  in
  { nip05: nip05 }
)
--RELATR

let
  res = fetch(_.provisioned, .nip05_res),
  pubkey = fetch(res, .pubkey) | null
in
if pubkey == _.targetPubkey then 1.0 else 0.0
```

## 3) Reciprocity / mutual follow (port of `ReciprocityPlugin`)

Legacy behavior: return `1.0` iff `ctx.graphManager.areMutualFollows(source, target)`.

Portable model:

```text
--RELATR
cap mutual = graph.are_mutual {a: _.sourcePubkey, b: _.targetPubkey}
--RELATR

if _.sourcePubkey == null then 0.0
else if fetch(_.provisioned, .mutual) == true then 1.0
else 0.0
```

## 4) Event kind 10002 present (port of `EventPlugin`)

Legacy behavior: fetch relay list (kind 10002) and return 1.0 if inboxes/outboxes exist.

Portable model option A: use `nostr.query` directly.

```text
--RELATR
cap relays = nostr.query {kinds: [10002], authors: [_.targetPubkey], limit: 1}
--RELATR

let
  events = fetch(_.provisioned, .relays) | [],
  e = first(events),
  content = fetch(e, .content) | {},
  inboxes = fetch(content, .inboxes) | [],
  outboxes = fetch(content, .outboxes) | []
in
if length(inboxes) > 0 or length(outboxes) > 0 then 1.0 else 0.0
```

Portable model option B: define a dedicated capability `nostr.relay_list` returning `{ inboxes: [...], outboxes: [...] }`.

## 5) Lightning address (port of `LightningPlugin`)

Legacy behavior:

- If `lud16` exists, validate "email-ish" format.
- Else if `lud06` exists, validate bech32 LNURL-ish OR URL.

In pure Elo, this may be awkward because Elo stdlib may not include regex and URL parsing.

Recommended portable approach:

- Keep the scoring policy in Elo.
- Push parsing/validation into a dedicated capability.

Example (capability-driven):

```text
--RELATR
cap meta = nostr.query {kinds: [0], authors: [_.targetPubkey], limit: 1}
cap ln = lightning.validate_profile(
  let
    events = fetch(_.planned, .meta) | [],
    meta = first(events),
    profile = fetch(meta, .content) | {},
    lud16 = fetch(profile, .lud16) | null,
    lud06 = fetch(profile, .lud06) | null
  in
  { lud16: lud16, lud06: lud06 }
)
--RELATR

if fetch(_.provisioned, .ln) == true then 1.0 else 0.0
```

If you really want this to be pure Elo, you’ll need to confirm which string helpers exist in your Elo stdlib (e.g. `contains`, `split`, `startsWith`, `length`, etc.) and accept a weaker heuristic validator.

## Summary

With plan-time Elo args fragments, RELATR blocks can express the same multi-step “fetch → derive → request” patterns that existed in the legacy TS validators, without forcing the host to publish overly-specialized capabilities.
