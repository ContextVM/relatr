# @contextvm/relo

`@contextvm/relo` is the lightweight Relatr authoring layer for [`@contextvm/elo`](../elo/package.json).

Its purpose is to let browser apps, editors, CLIs, and other tooling validate Relatr-flavored Elo plugins without depending on a full runtime host.

## Installation

```bash
bun add @contextvm/relo @contextvm/elo
```

`@contextvm/relo` is intended for authoring-time consumers such as browser clients, editor tooling, and plugin validation pipelines.

## Scope

- Relatr-specific plugin validation metadata
- capability-aware wrappers around [`validatePluginProgram()`](../elo/src/plugin-validator.ts:271)
- editor and authoring oriented exports over time

## Non-goals

- runtime capability execution
- graph or relay access
- environment-based enablement policy

## Status

`relo` is publish-oriented and is meant to be consumed independently from the full [`relatr`](../package.json) runtime.

## Public API

The package currently exposes:

- [`validateRelatrPluginProgram()`](src/wrappers.ts:12) to validate a complete Relatr plugin source string
- [`validateRelatrExpressionAst()`](src/wrappers.ts:22) to validate a parsed expression against the Relatr capability surface
- [`RELATR_CAPABILITIES`](src/catalog.ts:152) for stable named capability constants
- [`RELATR_CAPABILITY_DEFINITIONS`](src/catalog.ts:161) for capability descriptions and argument-shape metadata
- [`RELATR_VALIDATION_CAPABILITIES`](src/catalog.ts:426) for lower-level integration with the underlying Elo validator
- [`getRelatrCapabilityNames()`](src/catalog.ts:434) and [`isRelatrCapabilityName()`](src/catalog.ts:438) for catalog introspection

## Basic usage

### CLI usage

The package also ships a small authoring CLI via the published [`relo`](package.json:7) binary.

```bash
npx @contextvm/relo --help
```

After installation, you can also invoke the binary directly as `relo`.

Core commands:

- `build`: turn raw plugin source or existing event JSON into canonical Relatr artifact JSON
- `check`: validate raw source or an existing artifact
- `publish`: sign if needed, validate, and publish to one or more relays

Examples:

```bash
npx @contextvm/relo build plugin.elo --name activity_notes --relatr-version '^0.1.16'
npx @contextvm/relo check test-plugins/activity_notes.json
npx @contextvm/relo publish test-plugins/activity_notes.json --relay ws://localhost:10547 --sec <hex-or-nsec>
npx @contextvm/relo publish test-plugins/activity_notes.json --relay ws://localhost:10547 --bunker 'bunker://<pubkey>?relay=wss://relay.example'
```

Helpful CLI notes:

- Raw source passed to `build` or `publish` needs manifest context such as `--name` and `--relatr-version`.
- Existing event JSON keeps its manifest tags during `build` and `publish` unless you explicitly override them with flags.
- Signing can use either `--sec <hex|nsec>` for local keys or `--bunker <nostrconnect://...|bunker://...|name@domain>` for NIP-46 remote signing.
- Use `--json` when you want machine-readable success or failure output.
- Use `relo <command> --help` to see command-specific flags and examples.

Validate a Relatr plugin with the built-in capability catalog:

```ts
import { validateRelatrPluginProgram } from "@contextvm/relo";

const result = validateRelatrPluginProgram(`
plugin "demo"
version "1"

plan {
  let exists = do "graph.pubkey_exists" { pubkey: subject }
}

score 1
`);

if (!result.ok) {
  console.error(result.diagnostics);
}
```

Use the named capability constants when generating or analyzing plugin code:

```ts
import { RELATR_CAPABILITIES } from "@contextvm/relo";

console.log(RELATR_CAPABILITIES.graphPubkeyExists);
// => 'graph.pubkey_exists'
```

Inspect metadata for editor hints, autocomplete, or docs generation:

```ts
import { RELATR_CAPABILITY_DEFINITIONS } from "@contextvm/relo";

for (const capability of RELATR_CAPABILITY_DEFINITIONS) {
  console.log(capability.name, capability.argRule?.example);
}
```

## Relationship to the runtime

[`@contextvm/relo`](package.json) defines the Relatr authoring contract only:

- capability names
- argument-shape validation rules
- validation wrappers for [`@contextvm/elo`](../elo/package.json)

The full [`relatr`](../package.json) service remains responsible for runtime concerns such as:

- handler registration in [`registerBuiltInCapabilities()`](../src/capabilities/registerBuiltInCapabilities.ts:33)
- execution policy and enablement in [`CapabilityExecutor`](../src/capabilities/CapabilityExecutor.ts:27)
- graph, relay, network, and environment access

This split keeps browser and editor consumers lightweight while allowing the runtime host to evolve independently.

## Browser and web-client use

`relo` is suitable for:

- validating plugin source before submission to a backend
- powering capability autocomplete and argument hints in editors
- generating authoring UIs from [`RELATR_CAPABILITY_DEFINITIONS`](src/catalog.ts:161)
- checking whether a capability name belongs to the Relatr namespace before sending it to a runtime host

Because [`@contextvm/relo`](package.json) does not execute capabilities, it does not require access to relays, DuckDB, or the social graph.

## Versioning and publishing expectations

- Treat the top-level exports from [`src/index.ts`](src/index.ts:1) as the supported public surface.
- Built npm artifacts are served from [`dist/src`](tsconfig.json:6).
- Capability names exposed through [`RELATR_CAPABILITIES`](src/catalog.ts:152) should remain stable unless a deliberate breaking change is released.
