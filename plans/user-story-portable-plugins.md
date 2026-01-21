# Relatr Portable Plugins — User History (Create, Share, Install, Customize)

This document is a narrative walkthrough of how Relatr users and operators will create, share, install, and customize portable validation plugins using the Elo-based plugin system.

It intentionally uses concrete examples that mirror today’s built-in TypeScript validators in [`src/validators/plugins.ts`](src/validators/plugins.ts) and shows what they look like as portable Elo plugins.

---

## 1) Characters and Goals

### 1.1 Alice (Instance operator)

Alice runs a Relatr instance for a community. She wants:

- a predictable trust score pipeline (same core algorithm in [`TrustCalculator.calculate()`](src/trust/TrustCalculator.ts:42))
- the ability to enable/disable metrics without deploying code
- portability: plugins should be shareable across instances

### 1.2 Bob (Plugin author)

Bob wants to publish a plugin once and have it run anywhere:

- the plugin is a signed Nostr event
- the plugin declares what data it needs (kinds, windows, limits)
- the plugin is pure Elo (no IO) and returns a score in `[0,1]`

### 1.3 Carol (Community curator)

Carol curates a “starter pack” of plugins for new operators.

---

## 2) The User Journey: Create → Share → Install → Customize

### Step A: Bob creates a plugin locally

Bob writes an Elo expression that computes a score from Relatr’s provided `_` input. He also creates a manifest (tags) that describes the plugin.

The plugin artifact is a single Nostr event:

- `content`: Elo code
- `tags`: metadata + requirements

#### A1) Example: Root NIP-05 (port of [`RootNip05Plugin.validate()`](src/validators/plugins.ts:260))

**Goal:** score `1.0` if a profile’s NIP-05 is root (`_@domain`), otherwise `0.0`.

**Manifest tags (conceptual):**

- `name`: `is_root_nip05`
- `title`: `Root NIP-05`
- `about`: `Scores 1 when nip05 username is _`
- `weight`: `0.15`
- `k`: `0` (needs kind 0 metadata events)
- `limit`: `3` (metadata conflicts are expected; you usually only need a few)

**Elo content (conceptual):**

```text
let
  meta = first(fetch(_.events, ."0") | []),
  profile = fetch(meta, .content) | {},
  nip05 = fetch(profile, .nip05) | null,
  normalized = if isNull(nip05)
    then null
    else if contains(nip05, '@')
      then nip05
      else '_@' + nip05,
  username = if isNull(normalized)
    then null
    else first(split(normalized, '@'))
in
if username == '_' then 1.0 else 0.0
```

Notes:

- This is intentionally “events-first”: it looks at kind `0` events and extracts the profile.
- Relatr still owns normalization rules (sorting, bounds, verification flag), per [`plans/elo-plugins-design.md`](plans/elo-plugins-design.md).

#### A2) Example: Lightning address format (port of [`LightningPlugin.validate()`](src/validators/plugins.ts:102))

**Goal:** score `1.0` if profile has a plausible lightning address (`lud16`) (or LNURL), else `0.0`.

**Manifest tags (conceptual):**

- `name`: `has_lightning_address`
- `title`: `Lightning Address Present`
- `about`: `Scores 1 when profile advertises lud16 or lud06`
- `weight`: `0.10`
- `k`: `0`
- `limit`: `3`

**Elo content (conceptual):**

```text
let
  meta = first(fetch(_.events, ."0") | []),
  profile = fetch(meta, .content) | {},
  lud16 = fetch(profile, .lud16) | null,
  lud06 = fetch(profile, .lud06) | null,
  looksLikeEmail = fn(s ~> contains(s, '@') and contains(s, '.')),
  looksLikeLnurl = fn(s ~> startsWith(lower(s), 'lnurl1'))
in
if (not isNull(lud16) and looksLikeEmail(lud16))
  then 1.0
  else if (not isNull(lud06) and looksLikeLnurl(lud06))
    then 1.0
    else 0.0
```

Key insight:

- This is a format check only. The TypeScript version does slightly more thorough validation (regex + URL parsing in [`LightningPlugin.isValidLightningAddressFormat()`](src/validators/plugins.ts:124) and [`LightningPlugin.isValidLnurlFormat()`](src/validators/plugins.ts:171)). Elo plugins can start cheap; more thorough checks can be standardized later as host-provided primitives.

---

### Step B: Bob shares the plugin

Bob publishes the plugin event to a relay set.

Because the plugin is a single signed Nostr event:

- it’s easy to mirror across relays
- it’s easy to cache as JSON on disk
- its identity is stable (event id)

Carol (curator) can re-share Bob’s event id, or include it in a “starter pack list” (curation mechanism can be as simple as a JSON list of event ids for v1).

---

### Step C: Alice installs the plugin into her instance

Alice enables plugins in her Relatr instance by pointing at:

- a local directory of plugin event JSON files, or
- a list of plugin event ids to fetch and cache

Operationally, nothing changes about the trust computation pipeline:

- plugin outputs still become part of the metric map consumed by [`TrustCalculator.calculate()`](src/trust/TrustCalculator.ts:42)
- weights are applied exactly as they are today

Alice’s instance now emits a trust score that includes `is_root_nip05` and `has_lightning_address` metrics.

---

### Step D: Alice customizes behavior (weights, enablement)

Alice can customize without forking plugin code:

1. enable/disable plugins
2. override weights locally (operator override remains, per design)

Example intent:

- keep the plugin’s signed metadata (title, about, declared requirements)
- but tune its impact by changing local weight

This preserves a clean separation:

- plugins define _what_ is measured
- operators define _how much it matters_ in their trust composition

---

## 3) A More Powerful Example (Why 1000 Events Matter)

### 3.1 Reaction-based metric (kind 7), last 30 days

Alice wants a plugin that measures whether a user receives meaningful reactions.

This is not a single-event check; it requires set analysis, hence the default upper bound of 1000 per kind.

**Manifest tags (conceptual):**

- `name`: `reaction_activity`
- `title`: `Reaction Activity`
- `about`: `Scores higher when user gets reactions recently`
- `weight`: `0.20`
- `k`: `7`
- `limit`: `1000`
- `window`: `P30D`

**Elo content (conceptual):**

```text
let
  reactions = fetch(_.events, ."7") | [],
  n = length(reactions)
in
if n == 0 then 0.0
else if n >= 50 then 1.0
else n / 50
```

Key insight:

- This plugin is deliberately simple, but shows the purpose of larger bounded sets.
- More sophisticated variants could deduplicate reactors, filter by tags, exclude self-reactions, or weight by recency.

---

## 4) What Happens When a Plugin Needs External IO

Some existing validators do IO today:

- NIP-05 resolution in [`Nip05Plugin.validate()`](src/validators/plugins.ts:79)
- relay list fetching in [`EventPlugin.validate()`](src/validators/plugins.ts:200)
- social graph reciprocity in [`ReciprocityPlugin.validate()`](src/validators/plugins.ts:230)

In the Elo model:

- the Elo script stays pure
- Relatr can provide additional event sets or derived fields as part of `_`

If a metric depends on something that cannot be represented as Nostr events alone, it becomes a host-provided primitive (added as new fields under `_`), while still keeping plugin logic portable.

This is the “framework primitives” model:

- plugins declare requirements
- Relatr provides stable, deterministic, bounded inputs
- Elo computes score

---

## 5) Expected Ecosystem Behaviors

### 5.1 Plugin packs and curation

Over time, we should expect “plugin packs” to emerge:

- a curated set of event ids + recommended weights
- a minimal compatibility statement (Relatr version, required host primitives)

### 5.2 Safe defaults

Because plugins operate on bounded event bundles, a plugin cannot force unbounded relay queries.

Relatr can further enforce:

- a max total events budget per evaluation
- per-plugin timeouts

These controls protect an operator even when enabling community plugins.

---

## 6) How This Maps Back to Today’s System

Conceptually, the new system replaces the per-plugin TS function call in [`ValidationRegistry.executeAll()`](src/validators/plugins.ts:54) with:

1. plugin event loading and manifest parsing
2. required-data planning
3. bounded event provisioning
4. Elo evaluation

The output is still a map of metric keys to numbers in `[0,1]` that plugs into the existing trust formula.
