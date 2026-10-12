---
"relatr": patch
---

fix(validation): refresh metadata and NIP-05 facts per batch instead of for the whole graph upfront

- Scoring starts with the first batch instead of waiting until facts for every pubkey in the graph are refreshed
- Fact cache entries are written throughout the run, so they no longer all expire at the same time and block the next run
- Stage timings are summed per stage across batches; per-batch no-op messages are logged at debug level
- Remove the bootstrap metadata tracker, which could only skip a refresh for the full pubkey list
