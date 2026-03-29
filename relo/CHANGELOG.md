# relo

## 0.1.3

### Patch Changes

- style(relo): add .js extensions to relative imports for ES modules compatibility

## 0.1.2

### Patch Changes

- feat(relo): add CLI for building, checking, and publishing Relatr plugins

  Introduces a new CLI tool for the @contextvm/relo package with three core commands:
  - `relo build`: Create canonical Relatr plugin artifacts from source or existing event JSON, with optional signing
  - `relo check`: Validate raw ELO source or plugin event JSON artifacts
  - `relo publish`: Publish signed plugin events to Nostr relays with support for local (--sec) and remote (--bunker) signing

  Also adds the artifact library with functions for building, canonicalizing, validating, and stringifying Relatr plugin events, along with manifest tag handling. Includes unit tests and e2e CLI tests.

## 0.1.1

### Patch Changes

- init
