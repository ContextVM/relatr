---
"relatr": patch
---

fix(deps): resolve a single @duckdb/node-api version

- `nostr-social-duck` still depends on `@duckdb/node-api@^1.4.4`, so two DuckDB bindings were installed and the connection relatr passes to the graph library had a mismatched type
- Override the dependency to the version relatr uses; `bun run typecheck` no longer reports the `SocialGraph` connection mismatch
