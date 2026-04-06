# Plugin lifecycle: draft to publication

Portable Relatr plugins are published as Nostr kind `765` events. The Elo program goes in `content`, and manifest metadata goes in `tags`.

## Lifecycle at a glance

1. write the plugin source
2. validate the structure and capability usage
3. build a canonical artifact
4. publish the signed kind `765` event
5. discover or install it by event id or `nevent`
6. enable it and tune weight on the Relatr server

## Required event structure

- `kind`: `765`
- `content`: complete Elo plugin source
- `tags`: manifest metadata

Required tags:

- `n`
- `relatr-version`

Recommended tags:

- `title`
- `description`
- `weight`

## Example manifest payload

```json
{
  "kind": 765,
  "content": "plan notes = do 'nostr.query' {...} in ...",
  "tags": [
    ["n", "activity_notes"],
    ["relatr-version", "^0.2.0"],
    ["title", "Recent note activity"],
    ["description", "Scores higher for recent note activity."],
    ["weight", "0.40"]
  ]
}
```

## CLI workflow with `relo`

Check raw source:

```bash
npx @contextvm/relo check plugin.elo
```

Build a canonical artifact from raw source:

```bash
npx @contextvm/relo build plugin.elo --name activity_notes --relatr-version '^0.2.0'
```

Check an artifact:

```bash
npx @contextvm/relo check activity_notes.json
```

Publish an artifact:

```bash
npx @contextvm/relo publish activity_notes.json --relay wss://relay.example --sec <hex-or-nsec>
```

## Website flow

The website publisher is appropriate when the user wants browser-based editing, validation, preview, and relay publishing. The CLI is better for local files, version control, automation, or LLM-assisted workflows.

## Compatibility guidance

- set `relatr-version` to the range you actually tested
- do not advertise wider compatibility than you validated
- if a plugin depends on newer capabilities or behavior, raise the minimum version

## Versioning model

Published revisions are tracked by:

- same author pubkey
- same `n` tag
- newer `created_at` means newer version
- if tied, compare ids lexicographically

## Post-publish verification

After publishing:

1. install by event id, note id, or `nevent`
2. verify the plugin appears in the installed list
3. enable or disable it as needed
4. confirm its effective weight

## Pre-publish checklist

- source is structurally valid
- capability args are strict JSON
- all nullable results have fallbacks
- query filters are bounded
- `n` is stable and machine-safe
- `relatr-version` matches validated host versions
- title and description explain the scoring signal clearly
