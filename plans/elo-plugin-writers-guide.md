# Elo Plugin Writer's Guide (Relatr v0)

**Write portable scoring plugins for Relatr using the Elo language.**

This guide teaches you how to create plugins that compute trust scores by combining on-chain data, social graph information, and external APIs.

---

## What is an Elo Plugin?

An **Elo plugin** is a small program that calculates a trust score (0.0 to 1.0) for a Nostr pubkey. Plugins run in a sandboxed environment and can request external data through **capabilities**.

**Key idea**: You write pure scoring logic. Relatr handles the rest (fetching data, timeouts, and failures, etc).

---

## Your First Plugin: Always Return 0.5

Let's start with the simplest possible plugin:

```text
0.5
```

This plugin always returns a neutral score. Not useful, but valid.

Now let's make it respond to input:

```text
if _.targetPubkey == "abc123..." then 1.0 else 0.0
```

The `_` object contains:
- `_.targetPubkey` - the pubkey being scored
- `_.sourcePubkey` - your pubkey (or `null` if not available)
- `_.now` - current time in seconds

---

## Requesting External Data

Most plugins need data. Use **RELATR blocks** to declare what you need:

```text
--RELATR
cap notes = nostr.query {kinds: [1], authors: [_.targetPubkey], limit: 20}
--RELATR

let
  events = fetch(_.provisioned, .notes) | [],
  count = length(events)
in
if count > 10 then 0.9 else if count > 5 then 0.7 else 0.4
```

**What happens:**
1. Relatr sees your `nostr.query` request
2. It fetches the data once (even if multiple plugins request the same thing)
3. Your scoring code receives the results in `_.provisioned.notes`
4. If the request fails, you get `null`

### Common Capability Patterns

**Check if two users follow each other:**
```text
--RELATR
cap mutual = graph.are_mutual {a: _.sourcePubkey, b: _.targetPubkey}
--RELATR

if _.sourcePubkey == null then 0.0
else if fetch(_.provisioned, .mutual) == true then 1.0
else 0.0
```

**Verify NIP-05 identifier:**
```text
--RELATR
cap meta = nostr.query {kinds: [0], authors: [_.targetPubkey], limit: 1}
--RELATR

let
  events = fetch(_.provisioned, .meta) | [],
  profile = first(events)
in
if profile == null then 0.0
else 1.0
```

---

## Understanding RELATR Blocks

RELATR blocks are special comments that declare data dependencies:

```text
--RELATR
cap <id> = <capability> <arguments>
--RELATR
```

**Rules:**
- Each declaration needs a unique ID (lowercase, `a-z0-9_-`)
- Arguments must be **valid JSON** (objects, arrays, strings, numbers, booleans, null)
- Use `_` to reference the input object
- For multi-step planning, see [Multi-Step Planning with `_.planned`](#multi-step-planning-with-_planned)

**Good arguments:**
```text
cap notes = nostr.query {kinds: [1], authors: [_.targetPubkey], limit: 20}
cap mutual = graph.are_mutual {a: _.sourcePubkey, b: _.targetPubkey}
```

**Bad arguments (will fail):**
```text
cap bad = nostr.query {time: DateTime.now()}  -- DateTime is not JSON
cap bad = nostr.query undefined_var           -- undefined is not JSON
```

---

## Multi-Step Planning with `_.planned`

During planning, you can chain capability requests where later requests depend on earlier ones. Use `_.planned` to access the planned args of previous declarations.

**How it works:**
- `_.planned` is a map of `<id>` → `argsJsonOrNull` from earlier declarations
- Only available during planning (inside RELATR blocks)
- Enables building request args from previous planned values

**Example: Deriving a second request from the first**

```text
--RELATR
cap profile = nostr.query {kinds: [0], authors: [_.targetPubkey], limit: 1}
cap nip05_check = http.nip05_resolve {nip05: fetch(_.planned, .profile).nip05}
--RELATR

let
  res = fetch(_.provisioned, .nip05_check),
  pubkey = fetch(res, .pubkey) | null
in
if pubkey == null then 0.0 else 1.0
```

**Important notes:**
- `_.planned.<id>` returns the **planned args JSON**, not the provisioned result
- If a previous declaration is unplannable, its value is `null`
- Always handle `null` gracefully when chaining
- Keep chains short and deterministic

**Safe pattern for chaining:**

```text
--RELATR
cap first = some.cap {x: 1}
cap second = another.cap {y: fetch(_.planned, .first).y | 0}
--RELATR
```

---

## Handling Failures Gracefully

Always assume requests can fail. Use the `| default` pattern:

```text
let
  events = fetch(_.provisioned, .notes) | [],  -- If null, use empty list
  profile = fetch(_.provisioned, .meta) | null  -- If null, use null
in
-- your scoring logic
```

**Safe patterns:**
- `fetch(_.provisioned, .id) | []` - for lists
- `fetch(_.provisioned, .id) | null` - for single values
- `fetch(_.provisioned, .id) | {}` - for objects

If a capability is disabled, unknown, or times out, you'll get `null`. Design your scoring to degrade safely.

---

## Packaging Your Plugin

Plugins are Nostr events. Required tags:

- `name`: your plugin identifier (`snake_case` or `kebab-case`)
- `relatr-version`: `v0`

Recommended tags:
- `title`: human-readable name
- `description`: what it does
- `weight`: default importance (0.0 to 1.0)

Example event structure:
```json
{
  "kind": 765,
  "pubkey": "your-pubkey",
  "created_at": 1234567890,
  "tags": [
    ["name", "activity_score"],
    ["relatr-version", "v0"],
    ["title", "Activity Score"],
    ["description", "Scores based on recent note activity"]
  ],
  "content": "--RELATR\ncap notes = nostr.query {...}\n--RELATR\n\nlet ... in ..."
}
```

---

## Common Patterns

### Pattern 1: Tiered Scoring

When you have clear thresholds:

```text
--RELATR
cap notes = nostr.query {kinds: [1], authors: [_.targetPubkey], limit: 20}
--RELATR

let
  events = fetch(_.provisioned, .notes) | [],
  n = length(events)
in
if n > 10 then 0.9
else if n > 5 then 0.7
else if n > 0 then 0.4
else 0.0
```

### Pattern 2: Boolean Check

For yes/no signals:

```text
--RELATR
cap mutual = graph.are_mutual {a: _.sourcePubkey, b: _.targetPubkey}
--RELATR

if fetch(_.provisioned, .mutual) == true then 1.0 else 0.0
```

### Pattern 3: Combined Signals

Mix multiple factors:

```text
--RELATR
cap mutual = graph.are_mutual {a: _.sourcePubkey, b: _.targetPubkey}
cap notes = nostr.query {kinds: [1], authors: [_.targetPubkey], limit: 20}
--RELATR

let
  mutual = fetch(_.provisioned, .mutual),
  events = fetch(_.provisioned, .notes) | [],
  activity = if length(events) > 10 then 0.9 else 0.4
in
if mutual == true then 1.0
else activity
```

### Pattern 4: Profile Field Check

Parse kind-0 metadata:

```text
--RELATR
cap meta = nostr.query {kinds: [0], authors: [_.targetPubkey], limit: 1}
--RELATR

let
  events = fetch(_.provisioned, .meta) | [],
  meta = first(events),
  content = fetch(meta, .content) | '{}',
  profile = Data(content)
in
if fetch(profile, .name) != null then 0.5 else 0.0
```

---

## Best Practices

**Do:**
- ✅ Start simple and add complexity gradually
- ✅ Test with pubkeys you know (friends, your own)
- ✅ Use explicit defaults (`| []`, `| null`)
- ✅ Return 0.0 when data is missing
- ✅ Keep scoring pure and deterministic
- ✅ Use clear, descriptive IDs in RELATR blocks
- ✅ Comment your scoring logic

**Don't:**
- ❌ Depend on external APIs not exposed as capabilities
- ❌ Use non-JSON values in RELATR arguments
- ❌ Assume requests always succeed
- ❌ Write overly complex expressions
- ❌ Hardcode pubkeys (use `_.targetPubkey`)
- ❌ Return values outside [0.0, 1.0]

---

## Debugging Checklist

When your plugin doesn't work:

1. **Check RELATR syntax**
   - Are markers exactly `--RELATR`?
   - Is there a matching closing marker?
   - Is the `cap` line format correct?

2. **Validate arguments**
   - Do your args evaluate to JSON?
   - Are you using `_` correctly?

3. **Test provisioned values**
   - Add debug output (if your environment supports it)
   - Check if you're getting `null` (means request failed)

4. **Simplify**
   - Reduce to one RELATR declaration
   - Hardcode a simple score first
   - Add complexity back step by step

---

## Capability Reference

Common capabilities you can use:

| Capability | Purpose | Example Args |
|------------|---------|--------------|
| `nostr.query` | Query relay events | `{kinds: [1], authors: ["pubkey"], limit: 20}` |
| `graph.are_mutual` | Check mutual follows | `{a: "pubkey1", b: "pubkey2"}` |
| `http.nip05_resolve` | Verify NIP-05 identifier | `{nip05: "_@example.com"}` |

Check your Relatr instance for available capabilities and their exact argument formats.

---

## Next Steps

1. **Read the spec**: [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md) for full details
2. **Study examples**: Look at plugins in [`test-plugins/`](test-plugins/)
3. **Start writing**: Begin with a simple pattern from this guide
4. **Test locally**: Use the test runner to verify your plugin
5. **Share**: Publish your plugin as a Nostr event for others to use

---

**Remember**: The best plugins are simple, robust, and degrade gracefully. Start small!