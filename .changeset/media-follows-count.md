---
"relatr": minor
---

feat(graph): configurable follow list kinds for the trust graph

- New `FOLLOW_LIST_KINDS` setting (default `3`) selects which event kinds define follows, e.g. `3,10020` to also use NIP-51 media follow lists
- Each author's newest list of every configured kind is merged into one follow set before graph ingestion, both when building the graph and when integrating discovered pubkeys
- The graph bootstrap signature records the configured kinds, so changing them rebuilds the graph on the next start; graphs built before this change are treated as kind-3-only and are reused as long as the default is kept
