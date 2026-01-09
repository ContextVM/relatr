# Trusted Assertions (TA) Provider

Relatr can now act as a **Trusted Assertion Provider** following [NIP-85](https://nostrhub.io/naddr1qvzqqqrcvypzq3svyhng9ld8sv44950j957j9vchdktj7cxumsep9mvvjthc2pjuqyt8wumn8ghj7un9d3shjtnswf5k6ctv9ehx2aqqzf68yatnw3jkgttpwdek2un5d9hkuuctys9zn). This feature allows Relatr to publish **Kind 30382** Nostr events that assert a computed trust rank (0–100) for users, enabling clients to verify trustworthiness based on Relatr’s social graph and metrics.

---

## Overview

When enabled, Relatr:

- Accepts **TA user registrations** via the MCP `register_ta_provider` tool.
- Computes a **trust rank** (0–100) for each user using the same trust calculation used internally.
- Publishes **Kind 30382** events to configured relays, asserting the rank for the user.
- Updates ranks automatically after social graph syncs.

---

## Configuration

### Environment Variables

Add the following to your `.env` file:

```env
# Enable TA provider feature
TA_ENABLED=true
```

> **Note**: `SERVER_SECRET_KEY` must be a valid hex-encoded Nostr private key. The corresponding public key will be used as the publisher of TA events.

---
