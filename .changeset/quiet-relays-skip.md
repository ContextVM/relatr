---
"relatr": patch
---

fix(relays): skip unreachable relays instead of stalling every query

- Abort relay WebSocket connection attempts that do not open within 5 seconds
- A relay whose host silently drops packets previously made every `nostr.query`, profile fetch, and search request wait for the 10-second EOSE timeout; it is now marked offline and skipped until its reconnect backoff expires
- Report the aborted attempt as an unclean close when the runtime does not emit one itself (Bun 1.3.3, used by the Docker image, never does for a socket closed while connecting)
