---
"relatr": patch
---

fix(nip05): put unreachable NIP-05 domains on hold instead of caching their names as invalid

- Implement the documented `NIP05_DOMAIN_COOLDOWN_SECONDS`: a network, TLS, timeout, 429, or 5xx failure puts the domain on hold, persisted across restarts
- Skip the remaining names of a domain on hold within the same refresh instead of waiting for each lookup to time out
- Treat unknown names, other HTTP errors, and malformed documents as a definitive negative answer that is cached for `NIP05_CACHE_TTL_SECONDS`; transport failures are no longer cached as invalid for that long
