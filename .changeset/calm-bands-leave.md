---
"relatr": patch
---

fix(relays): remove the unreachable relay.nostr.band from default relay lists

- `relay.nostr.band` no longer completes a WebSocket handshake, which stalled default relay queries and left profile search with a single working relay
- Drop it from `COMMON_RELAYS`, `SEARCH_RELAYS`, and the `.env.example` defaults
