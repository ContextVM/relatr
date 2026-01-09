# Trusted Assertions (TA) in Relatr

Relatr can act as a **Trusted Assertion provider** as described by NIP-85, publishing **Kind 30382** events that assert a rank (0–100) for a pubkey. The important part is *how* Relatr does this in practice: it treats TA as a persisted, queryable **rank cache**, and publishes events as a side-effect when appropriate.

This document explains the mechanics of TA inside Relatr: the persisted table, the meaning of `is_active`, the “dual API” (request/response vs. publishing), and what operators need to enable it.

## The mental model: TA is not a “subscription”

Many systems model TA as a subscription list: “users who opted in will get their rank published periodically.” Relatr intentionally avoids making TA a first-class subscription mechanism. Instead, the persisted TA table is the system of record for “what is the latest rank we computed” (and when), and `is_active` is just a **flag that records user intent**.

Think of it like a mailbox label, not a billing plan.

* The TA table stores: the most recent rank, when it was computed, and whether it was explicitly requested.
* The service uses staleness to decide when to recompute.
* Publishing Kind 30382 is a side-effect that happens on enable and on refreshes when the rank changes.

The outcome is simpler semantics and better performance: TA also becomes a cache layer that prevents re-running expensive trust computations for the same pubkey over and over.

## Persistence and staleness

Relatr stores TA state in a DuckDB table with a unique row per pubkey. From the service perspective, the core fields are:

* `latest_rank`: the last computed rank (0–100)
* `computed_at`: unix seconds when `latest_rank` was computed
* `is_active`: a boolean meaning “user requested this entry via `enable`”

Staleness is intentionally boring: an entry is stale when `computed_at` is older than `now - CACHE_TTL_HOURS`, or when `latest_rank` is missing.

This exact staleness rule drives both refresh modes described below. The authoritative logic lives in [`TAService.refreshStaleRanks()`](src/service/TAService.ts:322) and [`TAService.maybeRefreshAndEnqueueTA()`](src/service/TAService.ts:445).

## `is_active`: what it means (and what it does not)

`is_active` is a local operator-friendly signal. It does **not** mean “Relatr has a protocol-level subscription” and it does **not** imply special Nostr privileges.

It means: “this pubkey explicitly asked Relatr to manage TA for them.”

That single bit is used for one operational purpose: periodic refresh work focuses on active entries (so operators can bound cost), while inactive entries are updated only when they naturally appear in Relatr’s trust computation flow.

## The dual API: request/response *and* publication

TA has two faces that run in parallel:

1) A **request/response interface** that returns status and cached rank.
2) A **publishing interface** that emits Kind 30382 events to relays.

They are related, but not identical.

### Request/response: `manage_ta`

Relatr exposes TA management through an MCP tool named `manage_ta` with actions `get`, `enable`, and `disable` (registered in [`registerManageTATool()`](src/mcp/server.ts:463)).

`get` is read-only: it returns the current cached rank if present, without computing or publishing. The logic is implemented in [`TAService.manageTASub()`](src/service/TAService.ts:75).

`enable` does three things in one intentional, user-facing operation:

* creates (or updates) the TA row and sets `is_active = TRUE`
* computes a fresh rank and persists it (so the cache is warm immediately)
* attempts to publish a Kind 30382 event

If publishing fails, the operation still succeeds from the user’s perspective: the cache is updated and the system logs the publish failure. This is deliberate—publishing is network-dependent; caching is local truth.

`disable` flips `is_active = FALSE` and keeps the cached rank. Disabling is not deletion; it is “stop treating this as user-requested.”

### Publication: Kind 30382 events

When Relatr publishes TA, it publishes Kind 30382 with tags that include:

* `d` tag: the subject pubkey
* `rank` tag: the rank as a string

The event is signed by the server’s key (configured via `SERVER_SECRET_KEY`) and is published to a relay set derived from:

* the user’s relay list (when available)
* the server’s configured relays
* optional `customRelays` supplied on `enable`

The implementation is in [`TAService.publishTAEvent()`](src/service/TAService.ts:180). Relatr also caches the final relay set per pubkey in the key/value store, so repeated publishes don’t need to refetch relay lists every time.

## Refresh modes: periodic and lazy

Relatr refreshes TA ranks in two complementary ways.

### 1) Periodic refresh (active entries only)

Periodic refresh is designed for operators: it bounds cost by only targeting `is_active = TRUE` rows. It recomputes stale ranks, persists them in batch, and publishes only when the rank changed.

This is handled by [`TAService.refreshStaleRanks()`](src/service/TAService.ts:322), which pulls stale active rows efficiently via `getStaleActiveTA`.

### 2) Lazy refresh (inactive entries when encountered)

Lazy refresh is designed for correctness and cache warmth. When Relatr computes trust for some pubkey, it may opportunistically refresh that pubkey’s TA cache if the cached rank is missing or stale. This path creates the TA row as inactive (because it was not user-requested), updates the rank, and publishes only if the rank changed.

This is handled by [`TAService.maybeRefreshAndEnqueueTA()`](src/service/TAService.ts:445). It is explicitly best-effort: failures are logged and never block the trust score response.

## Preventing recursion and double-work

Because TA refresh is triggered by trust computation, and trust computation can trigger TA refresh, the implementation must avoid recursion. Relatr does this by computing TA ranks using an internal trust method that does not re-trigger lazy refresh.

You can see the intent in the code comments and in the calls to `calculateTrustScoreInternal` from [`TAService.computeRank()`](src/service/TAService.ts:309) and [`TAService.manageTASub()`](src/service/TAService.ts:75).

## Operator controls: how to enable TA

TA is an optional feature guarded by configuration. Operators enable it with `TA_ENABLED=true` (loaded in [`loadConfig()`](src/config.ts:75)). When disabled, TA endpoints return a disabled response and TA publishing is blocked.

Minimum recommended environment variables:

```env
TA_ENABLED=true

# The server’s Nostr key used to sign TA events
SERVER_SECRET_KEY=<hex-private-key>

# Relays used by the server for publishing
SERVER_RELAYS=wss://relay.example1,wss://relay.example2

# Controls TA cache staleness window (also used elsewhere in Relatr)
CACHE_TTL_HOURS=72
```

Operationally, `CACHE_TTL_HOURS` is the main dial: a shorter TTL increases freshness but costs more compute and more publishes; a longer TTL reduces load but makes ranks age out.

## What users should expect

If you call `manage_ta`:

* `get` returns what Relatr currently knows (cached rank + timestamps).
* `enable` immediately computes a fresh rank, stores it, and attempts to publish it.
* `disable` stops periodic refresh by clearing `is_active`, while keeping the cached rank for future reads and potential lazy refresh.

The user-visible guarantee is simple: Relatr will never pretend to publish a rank it couldn’t publish, but it will still cache ranks locally to avoid wasteful recomputation.

## Why this design is aligned with decentralization

Relatr’s TA implementation is intentionally “weakly coupled”: rank computation, persistence, and publishing are separate concerns. This keeps the service honest. A relay outage cannot rewrite history; it can only delay propagation. A user can opt into periodic attention (`is_active`) without forcing a long-lived subscription contract.

In other words: TA in Relatr is a *local truth engine* that can speak to the network, not a network dependency that dictates local truth.
