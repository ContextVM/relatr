# Relo CLI design

## Goal

Design a compact, high-value CLI for [`@contextvm/relo`](../package.json) that supports the full practical lifecycle of Relatr ELO plugins without compromising the existing library-first architecture.

The CLI should be useful for:

- local plugin authors working from source files
- shell users piping data through stdin/stdout
- CI workflows validating plugin artifacts
- developers preparing, signing, and publishing plugins to Nostr relays

## Design principles

### Keep the command surface small

The CLI should expose only three top-level commands:

- `relo build`
- `relo check`
- `relo publish`

This is intentionally small, but each command should be capable enough to cover a complete stage in the plugin lifecycle.

### Prefer smart defaults over flags

The CLI should auto-detect common input forms and avoid low-value switches.

Avoid introducing flags such as:

- `--from`
- `--stdin`
- `--quiet`
- `--strict`
- `--scope`
- `--no-color`

These add surface area without enough practical value for the intended workflow.

### Keep [`@contextvm/relo`](../package.json) reusable

The library should remain a reusable authoring and validation core for:

- this CLI
- the web app
- possible editor integrations
- CI and automation

Terminal IO, relay publishing UX, and argv handling should stay in the CLI layer.

### Use [`@nostr/tools`](nostr-tools.md) for Nostr operations

The CLI should rely on [`@nostr/tools`](nostr-tools.md) for:

- event signing
- event verification
- NIP-19 `nsec` decoding
- relay publishing via pool APIs

This avoids inventing custom crypto or relay transport behavior.

## Final v1 command set

### `relo build`

Build a canonical Relatr plugin artifact from source or an existing plugin JSON event, optionally signing it.

### `relo check`

Validate raw source or plugin event JSON.

### `relo publish`

Publish a plugin event to one or more Nostr relays, signing it first when needed.

## Command details

## `relo build`

### Role

[`relo build`](../package.json:20) is the canonical artifact constructor.

It should cover all of these workflows:

1. scaffold a new plugin artifact
2. transform raw ELO source into an unsigned JSON event
3. normalize and fix an existing plugin artifact
4. optionally sign the output event

### Accepted input

[`relo build`](../package.json:20) should accept:

- raw ELO source from a file path
- raw ELO source from stdin
- an existing unsigned or signed plugin event JSON file
- no input, in which case it scaffolds starter content

### Default behavior

Without [`--sec`](../package.json:19), [`relo build`](../package.json:20) should emit a canonical unsigned JSON event.

With [`--sec`](../package.json:19), [`relo build`](../package.json:20) should emit a canonical signed JSON event.

### Responsibilities

[`relo build`](../package.json:20) should:

- produce canonical JSON formatting
- normalize top-level field ordering
- normalize manifest tag ordering
- normalize content stringification and final newline behavior
- synthesize manifest tags from semantic flags
- preserve semantic content when reformatting an existing artifact
- validate enough structure to safely build the artifact

### Manifest awareness

Manifest tags are currently defined by [`parseManifestTags()`](../../src/plugins/parseManifestTags.ts:79) and validated by [`validateManifest()`](../../src/plugins/parseManifestTags.ts:122).

The recognized manifest keys today are:

- `n`
- `relatr-version`
- `title`
- `description`
- `weight`

The CLI should expose semantic flags for these instead of forcing users to construct raw tag arrays.

### High-value v1 flags

[`relo build`](../package.json:20) should support:

- `--out <file>`
- `--name <plugin-name>`
- `--title <text>`
- `--description <text>`
- `--weight <number>`
- `--relatr-version <range>`
- `--sec <value>`

### Secret key handling

[`--sec`](../package.json:19) should accept either:

- a 64-character hex secret key
- an `nsec1...` value

Internally the CLI should normalize this into a signing key using [`@nostr/tools`](nostr-tools.md).

There should not be separate `--sec` and `--nsec` flags.

### Output contract

Canonical output should be pretty-printed JSON with stable field ordering.

For unsigned artifacts, the output shape should align with examples like [`test-plugins/activity_notes.json`](../../test-plugins/activity_notes.json:1).

Recommended top-level ordering:

1. `kind`
2. `pubkey`
3. `created_at`
4. `tags`
5. `content`
6. `id` when signed
7. `sig` when signed

Recommended manifest tag ordering:

1. `n`
2. `relatr-version`
3. `title`
4. `description`
5. `weight`
6. any other tags after recognized manifest tags

### Example workflows

Build from source:

```bash
cat plugin.elo | relo build --name activity_notes > plugin.json
```

Scaffold from nothing:

```bash
relo build --name activity_notes > activity_notes.json
```

Canonicalize an existing artifact:

```bash
relo build plugin.json > plugin.fixed.json
```

Build and sign:

```bash
cat plugin.elo | relo build --name activity_notes --sec nsec1... > plugin.signed.json
```

## `relo check`

### Role

[`relo check`](../README.md:31) is the validation command.

It should validate whatever the user provides without forcing them to classify the input first.

### Accepted input

[`relo check`](../README.md:31) should accept:

- raw ELO source
- unsigned plugin event JSON
- signed plugin event JSON
- file path input or stdin

### Behavior

[`relo check`](../README.md:31) should:

- auto-detect whether input is source or JSON event
- validate plugin source using [`validateRelatrPluginProgram()`](../src/wrappers.ts:12)
- validate event shape when JSON is provided
- extract source from a plugin artifact and validate it
- validate manifest tags consistently with [`validateManifest()`](../../src/plugins/parseManifestTags.ts:122)
- print concise diagnostics by default
- return non-zero on failure

### High-value v1 flags

[`relo check`](../README.md:31) should support:

- `--json`

That is enough for CI and machine-readable workflows.

### Example workflows

```bash
relo check plugin.json
cat plugin.elo | relo check
relo check plugin.json --json
```

## `relo publish`

### Role

[`relo publish`](../README.md:111) is the relay transport command.

It should publish a plugin artifact to one or more relays, and it should be robust enough to sign an unsigned event when the user provides a secret.

### Accepted input

[`relo publish`](../README.md:111) should accept:

- raw ELO source
- unsigned plugin event JSON
- signed plugin event JSON
- file path input or stdin

### Behavior

[`relo publish`](../README.md:111) should:

1. parse the input
2. normalize it through the same artifact-building path used by [`relo build`](../package.json:20)
3. validate the result
4. if unsigned and [`--sec`](../package.json:19) is present, sign it
5. if signed, verify it
6. publish to the given relays using [`@nostr/tools`](nostr-tools.md)

### High-value v1 flags

[`relo publish`](../README.md:111) should support:

- `--relay <url>` repeatable
- `--sec <value>`
- `--json`
- `--dry-run`

### Why [`--sec`](../package.json:19) also belongs here

Allowing [`--sec`](../package.json:19) on [`relo publish`](../README.md:111) makes the command more robust and versatile.

That enables:

- publishing a prebuilt unsigned event directly
- one-shot source-to-publish workflows
- shell pipelines where explicit build output is optional

Even with this convenience, [`relo build`](../package.json:20) remains the primary artifact creation and signing command.

### Relay behavior

In v1, relays should be explicit. Do not hide relay defaults.

Publishing destination is too important to infer silently.

### Example workflows

Publish a signed artifact:

```bash
relo publish plugin.signed.json --relay wss://relay.example
```

Publish an unsigned artifact by signing on the fly:

```bash
relo publish plugin.json --relay wss://relay.example --sec nsec1...
```

One-shot source publish:

```bash
cat plugin.elo | relo publish --relay wss://relay.example --sec 0123abcd...
```

## Architecture plan

## Library responsibilities

[`@contextvm/relo`](../package.json) should remain the reusable core and eventually expose helpers for:

- source vs event input classification
- source extraction from a plugin artifact
- canonical plugin artifact construction
- manifest tag synthesis
- canonical artifact normalization
- secret normalization for signing workflows
- plugin validation wrappers built on [`validateRelatrPluginProgram()`](../src/wrappers.ts:12)

These should be reusable by both the CLI and the web app.

## CLI responsibilities

The CLI layer should own:

- argv parsing
- file and stdin reading
- stdout/stderr formatting
- process exit codes
- invoking signing and publishing paths using [`@nostr/tools`](nostr-tools.md)

## Internal pipeline recommendation

To keep behavior consistent, both [`relo build`](../package.json:20) and [`relo publish`](../README.md:111) should share the same internal normalization path.

Recommended conceptual flow:

1. classify input
2. normalize source or event into a canonical artifact
3. validate plugin source and manifest
4. sign if requested
5. output or publish

This avoids separate drifting implementations for build and publish.

## UX summary

The intended lifecycle is:

1. [`relo build`](../package.json:20)
2. [`relo check`](../README.md:31)
3. [`relo publish`](../README.md:111)

Typical workflows:

```bash
relo build --name trust_distance > trust_distance.json
relo check trust_distance.json
relo publish trust_distance.json --relay wss://relay.example --sec nsec1...
```

Or fully piped:

```bash
cat plugin.elo | relo build --name activity_notes | relo publish --relay wss://relay.example --sec nsec1...
```

## v1 scope summary

### Commands

- `build`
- `check`
- `publish`

### Flags

#### `build`

- `--out`
- `--name`
- `--title`
- `--description`
- `--weight`
- `--relatr-version`
- `--sec`

#### `check`

- `--json`

#### `publish`

- `--relay`
- `--sec`
- `--json`
- `--dry-run`

## Final recommendation

This design gives [`relo`](../package.json:2) a compact CLI with high capability density:

- [`relo build`](../package.json:20) creates, canonicalizes, and optionally signs artifacts
- [`relo check`](../README.md:31) validates source or event input
- [`relo publish`](../README.md:111) publishes artifacts and can sign unsigned input when needed

It aligns with the current manifest model in [`src/plugins/parseManifestTags.ts`](../../src/plugins/parseManifestTags.ts:79), existing artifact examples like [`test-plugins/activity_notes.json`](../../test-plugins/activity_notes.json:1), and the plan to use [`@nostr/tools`](nostr-tools.md) for signing and relay interactions.
