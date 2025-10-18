High Level Design Document for "Relatr" Web of Trust Service on Nostr

Overview
--------
"Relatr" is a decentralized web of trust metric service for open networks like Nostr. It focuses on computing personalized trust ranks by measuring relative trust distances between public keys and combining them with multiple profile and behavioral validations. Implemented using Bun.js and the "nostr-social-graph" TypeScript library, it dynamically builds and queries social graphs from Nostr follow events, with results cached for performance. "Relatr" exposes an MCP (Model Context Protocol) server interface for interactive and configurable trust metric computation.

Core Components
---------------
1. Social Graph Construction
   - Utilize nostr-social-graph to build and maintain a real-time social graph from Nostr follow events.
   - Support efficient querying of followers, followed users, and relative distances from configurable root pubkeys.
   - Allow dynamic switching of the root user with quick recalculation of graph distances.

2. Relative Distance Calculation
   - Calculate the base trust metric as the shortest path distance (integer hops) between source and target pubkeys.
   - Normalize the integer distance to a floating point score via a linear decay mapping, for example:
     $$
     \text{Distance Score} = \max(0, 1 - \alpha \times (\text{distance} - 1))
     $$
     where $$\alpha$$ is the decay factor (e.g., 0.1) to calibrate trust drop per hop.
   - This produces a floating point score in where a distance of 1 yields 1.0 (highest trust) and larger distances decay accordingly.[11]

3. Profile and Social Validation Metrics
   - Compute various profile-based and social metrics for pubkeys, mostly binary, normalized as:
     - 1.0 if valid/present/true
     - 0.0 if invalid/absent/false
   - Metrics include:
     - Valid NIP05 identifier presence.
     - Availability of a Lightning Network address.
     - Publication of specific event kinds (e.g., kind 10002).
     - Reciprocity checks (whether the target’s contacts include the origin pubkey).
   - Store these computed metrics in a local SQLite cache to reduce redundant calculations.

4. Composite Trust Ranking
   - Combine all metrics into a flexible weighted formula to compute the final "relate score":
     $$
     \text{Trust Score} = \frac{\sum_{i=1}^{n} w_i \cdot v_i^{p_i}}{\sum_{i=1}^{n} w_i}
     $$
     where:
     - $$v_i$$ are normalized metric values in.[11]
     - $$w_i$$ are configurable metric weights reflecting their relative importance.
     - $$p_i \geq 1$$ are optional exponents for influence shaping.
   - This formula allows modular addition/removal of metrics without core refactoring.
   - Intuitive mapping of integer distances along with binary validations yields a robust, interpretable final score.

5. MCP Server API Interface
   - Serve trust metric computations via an MCP server endpoint.
   - Accept calls specifying target pubkey and optionally source pubkey to define trust perspective. If no source is specified, the service should use a default one configured as .env variable.
   - Upon request, fetch cached metrics and compute or refresh relative social graph distances.
   - Return the consolidated "relate score" expressing trust from source to target or an absolute trust measure if no source specified.

6. Caching, Updates, and Extensibility
   - Cache computation results and social graph snapshots in SQLite for fast query times and scalability.
   - Periodically refresh caches asynchronously as new Nostr events are received.
   - Design metric computation modules to be easily extensible with additional trust signals or modified weighting schemes.

Proposed Metrics, Normalization, and Weights
--------------------------------------------
| Metric                        | Type     | Normalization                      | Example Weight |
|------------------------------|----------|----------------------------------|----------------|
| Relative Distance (hops)      | Integer  | Converted to float via linear decay: $$1 - 0.1 \times (distance - 1)$$ capped at 0 | 0.5            |
| NIP05 Validity                | Binary   | 1.0 if valid, 0 otherwise        | 0.15           |
| Lightning Network Address     | Binary   | 1.0 if present, 0 otherwise      | 0.1            |
| Event Kind 10002 Published    | Binary   | 1.0 if published, 0 otherwise    | 0.1            |
| Reciprocity Check             | Binary   | 1.0 if origin pubkey is in target’s contact list, 0 otherwise | 0.15           |

- Weights can be tuned based on empirical data or policy decisions.
- Exponents $$p_i$$ default to 1 for linear influence but can be adjusted per metric for more nuanced impact.

Implementation Notes
--------------------
- Leverage nostr-social-graph in Bun.js to handle graph operations efficiently.
- Normalize integer distances carefully to maintain meaningful differences in closeness trust.
- Use SQLite for lightweight caching of computed metrics and graph states.
- Implement MCP server with Node.js/Bun to provide performant and flexible API access.
- Maintain modularity for easy metric additions and formula adjustments as the network and trust needs evolve.

Summary
-------
"Relatr" provides a comprehensive, extensible platform for assessing trust in Nostr by combining social graph proximity and profile-based validations. The use of a modular weighted floating point formula incorporating normalized integer distances and binary checks enables intuitive yet robust scoring for personalized trust relationships. Its design includes efficient caching, a versatile MCP API, and adaptability to evolving metrics, positioning it as a foundational tool for decentralized identity and reputation in open social ecosystems.