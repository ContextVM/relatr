---
name: relatr-elo-plugin-author
description: Writes, reviews, fixes, validates, and prepares portable Relatr Elo plugins across the full lifecycle from source design to kind 765 publication. Use when the task involves Relatr plugins, Elo plugin authoring, capability-based scoring logic, plugin manifests, `relo` checks/builds/publishing, or explaining how Relatr plugin programs use `plan`, `then`, and `do`.
---

# Relatr Elo Plugin Author

## Overview

This skill helps an agent produce correct, portable Elo plugins for relatr and guide users through the full plugin lifecycle. The core principle is to treat Relatr plugins as bounded, capability-driven scoring programs: collect data safely, then score it clearly.

## When to use

- When a user wants to write a new portable Relatr plugin in Elo.
- When a user needs help fixing or reviewing an existing Elo plugin.
- When a user asks how Relatr-specific plugin programs use `plan`, `then`, and `do`.
- When a user needs capability-aware plugin guidance for `nostr.query`, graph capabilities, or `http.nip05_resolve`.
- When a user wants to validate, build, or publish a plugin using `relo` or package it as a Nostr kind `765` event.
- When an LLM needs project-specific reference material for Elo operators, common functions, nullable handling, and Relatr plugin packaging.

**Do NOT use when:**

- The task is about general Nostr application development unrelated to Relatr plugin authoring.
- The task is about changing Relatr runtime internals rather than authoring or reviewing plugin artifacts.
- The user only needs generic Elo language education with no Relatr plugin context.

## Workflow

### 1. Classify the request

Identify which of these workflows is needed before producing output:

- **Author** — create a new plugin from a desired scoring signal.
- **Review** — inspect a plugin for correctness, safety, and compatibility.
- **Debug** — fix broken syntax, misuse of `do`, bad fallbacks, or wrong capability args.
- **Package / publish** — prepare manifest tags, artifact JSON, and `relo` commands.
- **Explain** — teach the plugin model, Elo operators, or lifecycle steps.

If the request mixes concerns, handle them in lifecycle order: source correctness first, packaging second, publishing last.

### 2. Load only the references needed

Use progressive disclosure instead of repeating all documentation inline.

- Read [`references/elo-core.md`](references/elo-core.md) when the task depends on Elo syntax, values, `let`, `if`, lists, tuples, or field access.
- Read [`references/elo-operators-and-functions.md`](references/elo-operators-and-functions.md) when the task depends on operators, `Data()`, `fetch`, fallback `|`, or pipe `|>`.
- Read [`references/authoring-model.md`](references/authoring-model.md) when designing or fixing Relatr plugin structure.
- Read [`references/capabilities.md`](references/capabilities.md) before writing any `do` call.
- Read [`references/patterns.md`](references/patterns.md) when the user wants a concrete example or a starting point.
- Read [`references/lifecycle.md`](references/lifecycle.md) when the task involves [`relo`](../../relo/README.md), manifests, publishing, or installation.

### 3. Build or assess the plugin with Relatr rules, not generic assumptions

Always enforce these non-negotiable constraints:

- A plugin returns a numeric score intended for `[0.0, 1.0]`.
- External requests happen only through `do`.
- `do` may appear only as the full right-hand side of a binding in `plan` or `then` rounds.
- Capability args must evaluate to strict JSON-shaped values.
- Capability results must be treated as nullable and given safe fallbacks.
- Relay queries should be narrow and include explicit `limit` values.
- Graph capability argument shapes must match the documented object fields exactly.

If a plugin needs one capability result to compute the next request, split it into another `then` round instead of nesting requests.

### 4. Produce lifecycle-aware outputs

Match the output to the user’s likely next step.

- For **authoring**, provide the plugin source plus a brief explanation of the scoring logic.
- For **review**, report concrete issues, why they matter, and a corrected version when possible.
- For **debugging**, explain the failing pattern first, then show the fixed plugin.
- For **packaging**, provide the required tags, event structure, and the relevant `relo check`, `build`, or `publish` commands.
- For **teaching**, explain the minimum relevant Elo and Relatr concepts, then ground them in one plugin example.

### 5. Finish with verification guidance

Unless the user only asked for a conceptual explanation, end with the minimum concrete verification steps:

- structure / logic checks
- capability-shape checks
- manifest / compatibility checks
- `relo` command sequence when applicable

Prefer concise checklists over long prose.

## Checklist

- [ ] Classified the request as author, review, debug, package/publish, or explain.
- [ ] Consulted the smallest relevant reference files before writing advice.
- [ ] Enforced Relatr plugin constraints around rounds, `do`, JSON args, and nullable results.
- [ ] Verified capability names and argument shapes against the documented Relatr catalog.
- [ ] Included packaging and validation steps when the task extends beyond raw `.elo` source.
- [ ] Delivered output in a form the user can immediately use: plugin source, review notes, manifest, commands, or explanation.

## Examples

**Example:**

Input: user asks for a plugin that scores recent note activity for a target pubkey and wants something publishable later.

```text
Write a Relatr Elo plugin that scores users based on recent notes from the last 7 days. Keep it simple and safe, and tell me how I would publish it later.
```

Output: a bounded activity plugin plus minimal lifecycle guidance.

```elo
plan
  notes = do 'nostr.query' {
    kinds: [1],
    authors: [_.targetPubkey],
    since: _.now - 604800,
    limit: 50
  }
in
let
  events = notes | [],
  n = length(events)
in
if n >= 30 then 1.0
else if n >= 12 then 0.75
else if n >= 2 then 0.3
else 0.0
```

```text
Suggested manifest tags:
- ["n", "activity_notes"]
- ["relatr-version", "^0.2.0"]
- ["title", "Recent note activity"]
- ["description", "Scores higher for recent note activity over the last 7 days."]

Suggested checks:
- `relo check plugin.elo`
- `relo build plugin.elo --name activity_notes --relatr-version '^0.2.0'`
```

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Using `do` inside `if`, `let`, arrays, or nested expressions | Move the request to a full binding RHS inside `plan` or `then`. |
| Forgetting nullable fallbacks for capability results | Use `| []`, `| {}`, `| null`, and `fetch(... )` with fallbacks. |
| Writing graph capability args with the wrong field names | Check the exact object shape in [`references/capabilities.md`](references/capabilities.md) before emitting the call. |
| Mixing up fallback `|` and pipe `|>` | Use `|` for defaults and `|>` for chaining a value into a function. |
| Writing a plugin that tries to do too much | Keep one focused signal per plugin and let Relatr combine weighted plugin outputs. |

## Quick reference

| Operation | How |
| --- | --- |
| Learn core Elo syntax | Read [`references/elo-core.md`](references/elo-core.md). |
| Check operators and common helpers | Read [`references/elo-operators-and-functions.md`](references/elo-operators-and-functions.md). |
| Design or fix plugin rounds | Read [`references/authoring-model.md`](references/authoring-model.md). |
| Verify capability calls | Read [`references/capabilities.md`](references/capabilities.md). |
| Start from a known-safe example | Read [`references/patterns.md`](references/patterns.md). |
| Package and publish a plugin | Read [`references/lifecycle.md`](references/lifecycle.md). |

## Key principles

1. **Collect first, score second** — treat plugin authoring as a bounded data-collection phase followed by a pure scoring phase.
2. **Capabilities are host-provided** — a plugin may request only what Relatr exposes, and must never assume arbitrary runtime powers.
3. **Null is normal** — capability failures, missing fields, and absent context are expected; robust plugins always define fallbacks.
4. **Keep plugins focused** — one understandable signal is better than a monolithic trust algorithm hidden inside one plugin.
5. **Lifecycle completeness matters** — a good answer covers not only the source program, but also validation, packaging, compatibility, and publication when the user needs them.
