---
"relatr": patch
---

fix(relays): skip unreachable relays instead of stalling every query

- Abort relay WebSocket connection attempts that do not open within 5 seconds
- Once a failed connection is marked offline, new `nostr.query`, profile fetch, and search requests skip it until the reconnect backoff expires instead of paying its EOSE timeout again. Requests already in flight retain the relay library's existing retry policy.
- Report the aborted attempt as an unclean close when the runtime does not emit one itself (Bun 1.3.3, used by the Docker image, never does for a socket closed while connecting)
