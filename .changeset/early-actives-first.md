---
"relatr": minor
---

feat(validation): score recently active pubkeys first

- Look up which graph pubkeys published any event on the configured relays in the last 30 days, at most once per `SYNC_INTERVAL_HOURS`; only the first run waits for this scan, later runs order by the previous scan while a due scan refreshes in the background
- Authors are queried in batches of 500; authors already found are dropped from the next round so prolific posters cannot hide quieter ones behind the relay result limit
- The run validates recently active pubkeys first, newest activity first; every other pubkey keeps its graph order and is still validated in the same run
- The last-seen timestamp is stored per pubkey in `pubkey_kv` under `last_seen_at`; if activity cannot be fetched, the run falls back to graph order
- An empty completed scan is still a previous scan: its persisted completion timestamp keeps later due scans in the background, including after a restart
