# Elo fork (JS-only) plan for Relatr portable plugins

This document defines the planned fork of the Elo language implementation in this repo (currently vendored under [`elo/`](elo/src/index.ts:1)) to better support Relatr’s portable plugin system.

Status: draft for internal implementation.

---

## 1. Goals

- Provide a **JS-only** Elo runtime/compiler for Relatr plugins.
- Add a first-class **plugin-program** format that supports:
  - multi-round planning
  - network-dependent chaining
  - plan-time pure transformations
  - score-time compute-only evaluation
- Keep **closed-world** behavior (no access to host globals) consistent with Elo’s current undefined-variable rejection in [`transformWithDepth()`](elo/src/transform.ts:89).
- Improve embedding ergonomics with **low-risk utilities**:
  - `parseWithMeta` (diagnostics + locations)
  - `compileFromAst` / `compileExpression` (cacheable compilation)
  - `isJsonValue` / `assertJsonValue` (JSON boundary)

Non-goals (MVP):

- Maintaining Ruby/SQL compilation targets (explicitly dropped).
- Implementing host capability catalogs or request-key policy inside the fork.
- Adding host-callable externals beyond the language primitive `do`.

---

## 2. Fork scope changes (JS-only)

### 2.1 Remove Ruby/SQL surface area

In the fork’s public exports (currently in [`elo/src/index.ts`](elo/src/index.ts:1)):

- Remove exports for Ruby/SQL:
  - `compileToRuby`, `compileToRubyWithMeta`
  - `compileToSQL`, `compileToSQLWithMeta`
  - preludes targeting Ruby/SQL
- Option A (preferred): delete the Ruby/SQL compiler files entirely.
- Option B: keep them in-tree but unexported (not recommended since you want JS-only).

Also update/remove the Ruby/SQL paths in the CLI compiler [`elo/src/eloc.ts`](elo/src/eloc.ts:1) if the fork keeps any CLI.

---

## 3. New plugin-program capability (Strategy 1 runtime)

### 3.1 Core idea

Add a new public entrypoint `compilePlugin()` that accepts a **plugin program** and produces:

- a score function (JS function taking `_` input)
- a structured representation of `plan/then` rounds (bindings and `do` call sites)
- optionally: compiled/cached helpers for evaluating binding expressions

Score compilation can reuse the existing JS compiler pipeline via [`compile()`](elo/src/compile.ts:60) / [`compileToJavaScriptWithMeta()`](elo/src/compilers/javascript.ts:62).

Planning/chaining is implemented by a **small runtime planner** (Strategy 1):

- Parse plugin program.
- Execute it round-by-round:
  - evaluate pure bindings in order
  - evaluate `do` args expressions and emit requests
  - host provisions results
  - proceed to next round

### 3.2 Syntax summary

The canonical v1 syntax is the **binder form** (see v1 spec):

```elo
plan <bindings> in then <bindings> in then <bindings> in <score-expr>
```

`do` uses a string literal capability name:

```elo
x = do 'nostr.query' {kinds: [0], authors: [_.targetPubkey], limit: 1}
```

### 3.3 Semantics summary

- `plan` and each `then` denote a **network round barrier**.
- Within a round, bindings are evaluated **top-to-bottom**.
- **No forward references**: a binding may reference `_`, earlier-round bindings, and earlier bindings in the same round.
- `do` is allowed only inside `plan/then` rounds (not in final score expression).
- `do` args must be JSON-or-null.
- `do` failures resolve to `null`.

---

## 4. Public API surface (fork)

### 4.1 Parse APIs

#### `parseWithMeta(source)`

Purpose:

- Provide **stable diagnostics** with line/column.
- Allow hosts (Relatr) to surface errors in plugin programs.

Rationale:

- Lexer tokens already carry `line` and `column` fields in [`Token`](elo/src/parser.ts:57).

Expected shape (illustrative):

- `{ ast, diagnostics }`
- `diagnostics[] = { message, severity, location: { line, column, offset } }`

### 4.2 Compilation APIs

#### `compileExpression(source, options)`

- Similar to [`compile()`](elo/src/compile.ts:60) but intended for repeated compilation in planners.

#### `compileFromAst(ast, options)`

- Compile an already parsed `Expr` AST to JS.
- Enables caching at the host level.

### 4.3 JSON boundary utilities

#### `isJsonValue(value): boolean`

#### `assertJsonValue(value): void`

Purpose:

- Provide a reusable, host-agnostic “JSON-only” boundary used by `do` args.

This is aligned with the v0 rule in [`plans/elo-plugins-spec-v0.md`](plans/elo-plugins-spec-v0.md:122) and carried forward in v1.

### 4.4 Plugin compilation API

#### `compilePlugin(source, options)`

Produces:

- `program`: structured rounds/bindings
- `score`: JS function `_ -> number`

Intentionally does **not** include:

- capability execution
- request key policy
- canonical JSON policy

Those remain host concerns.

---

## 5. Internal architecture notes (implementation guide)

### 5.1 Parser additions

- Extend the lexer keyword list to recognize `plan` and `then` similarly to existing keyword mapping in [`Lexer.nextToken()`](elo/src/parser.ts:334).
- Add a parser entrypoint for “plugin program” distinct from expression parsing.

Recommended:

- Keep expression parsing unchanged.
- Add `parsePluginProgram()` that parses:
  - `plan <bindingList> in <pluginContinuation>`
  - `then <bindingList> in <pluginContinuation>`
  - terminal `<expr>` as the score expression

Binding list can reuse the parsing logic from [`letExpr()`](elo/src/parser.ts:1090) but without the `let` keyword.

### 5.2 `do` parsing

Treat `do` as a special form within binding values.

- Parse: `do STRING <expr>`
- Store as a new AST node `do_call` with:
  - `capName: string`
  - `argsExpr: Expr`

### 5.3 Planner/runtime execution

Implement a host-facing contract for each round:

- input env: `_` plus accumulated bindings
- output:
  - `requests[]` (each has capName, argsJsonOrNull, bindingName)
  - updated env once provisioned

Round evaluation should be deterministic and bounded.

---

## 6. Minimal fork roadmap (no time estimates)

### MVP

- Remove Ruby/SQL exports and code paths.
- Add plugin-program parser (`plan/then ... in ...`).
- Add `do` AST node.
- Implement Strategy-1 planner/runtime driver for rounds.
- Implement `compilePlugin()`.
- Add `parseWithMeta`, `compileFromAst`/`compileExpression`, and JSON validators.
- Add golden tests for parsing, diagnostics, planning rounds, null failure behavior.

### v1 hardening

- Improve diagnostics: error spans, “undefined binding” messages during planning.
- Add limits/config surface for max rounds and max requests.
- Add inspectability hooks: emit round plan summary.
