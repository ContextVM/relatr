# API Specification: Relatr MCP Server

## Overview

Relatr exposes a single MCP tool `calculate_trust_score` that computes trust scores between Nostr pubkeys based on social graph distance and profile validations.

## MCP Tool: `calculate_trust_score`

### Description
Computes a trust score between two Nostr public keys by analyzing social graph distance, NIP-05 validity, Lightning Network address presence, relay list metadata, and reciprocal follows.

### Input Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `targetPubkey` | string | ✅ Yes | Nostr pubkey to assess (64-char hex) | `"84dee6e676e5bb67..."` |
| `sourcePubkey` | string | ❌ No | Perspective pubkey (defaults to `DEFAULT_SOURCE_PUBKEY`) | `"020f2d21ae09bf35..."` |
| `scheme` | string | ❌ No | Weighting scheme: `default`, `conservative`, `progressive`, `balanced` | `"default"` |
| `forceRefresh` | boolean | ❌ No | Bypass cache and recompute | `false` |

### Input Schema (Zod)

```typescript
{
  targetPubkey: z.string().length(64),
  sourcePubkey: z.string().length(64).optional(),
  scheme: z.enum(['default', 'conservative', 'progressive', 'balanced']).optional(),
  forceRefresh: z.boolean().optional()
}
```

### Output

```typescript
{
  score: number;              // Trust score [0.0 - 1.0]
  sourcePubkey: string;       // Perspective used
  targetPubkey: string;       // Assessed pubkey
  metrics: {
    distance: number;         // Social graph hops (0, 1, 2, ..., 1000)
    distanceWeight: number;   // Normalized [0.0 - 1.0]
    nip05Valid: number;       // 0.0 or 1.0
    lightningAddress: number; // 0.0 or 1.0
    eventKind10002: number;   // 0.0 or 1.0
    reciprocity: number;      // 0.0 or 1.0
  };
  computedAt: number;         // Unix timestamp
  cached: boolean;            // Was result from cache
}
```

### Example Request/Response

**Request:**
```json
{
  "targetPubkey": "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
  "sourcePubkey": "020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e",
  "scheme": "default"
}
```

**Response:**
```json
{
  "score": 0.875,
  "sourcePubkey": "020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e",
  "targetPubkey": "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
  "metrics": {
    "distance": 2,
    "distanceWeight": 0.9,
    "nip05Valid": 1.0,
    "lightningAddress": 1.0,
    "eventKind10002": 0.0,
    "reciprocity": 1.0
  },
  "computedAt": 1734354789,
  "cached": false
}
```

### Error Responses

**Invalid Pubkey:**
```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "Error: Invalid targetPubkey format. Must be 64-character hex string."
  }]
}
```

**Relay Unavailable:**
```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "Error: Failed to connect to Nostr relays"
  }]
}
```

## Weighting Schemes

### Default
- Distance: 50%
- NIP-05: 15%
- Lightning: 10%
- Event Kind 10002: 10%
- Reciprocity: 15%

### Conservative
- Distance: 70%
- NIP-05: 10%
- Lightning: 5%
- Event Kind 10002: 5%
- Reciprocity: 10%

### Progressive
- Distance: 30%
- NIP-05: 25%
- Lightning: 15%
- Event Kind 10002: 10%
- Reciprocity: 20%

### Balanced
- All metrics: 20% each

## Trust Score Interpretation

| Score Range | Interpretation |
|-------------|----------------|
| 0.9 - 1.0 | Very High Trust |
| 0.7 - 0.89 | High Trust |
| 0.5 - 0.69 | Moderate Trust |
| 0.3 - 0.49 | Low Trust |
| 0.0 - 0.29 | Very Low Trust |

## Rate Limiting

No explicit rate limits. Performance depends on:
- **Warm cache:** ~10ms per request
- **Cold cache:** ~500ms per request
- **Relay availability:** Variable

## Caching Behavior

- **Profile Metrics:** Cached for 1 hour
- **Trust Scores:** Cached for 1 hour
- **Social Graph:** Static until manual update

Use `forceRefresh: true` to bypass cache.

## Usage Examples

### Basic Usage (Default Source)
```typescript
const result = await mcp.callTool('calculate_trust_score', {
  targetPubkey: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240'
});

console.log(`Trust Score: ${result.score}`);
```

### Custom Source Pubkey
```typescript
const result = await mcp.callTool('calculate_trust_score', {
  targetPubkey: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
  sourcePubkey: '020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e'
});
```

### Conservative Weighting
```typescript
const result = await mcp.callTool('calculate_trust_score', {
  targetPubkey: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
  scheme: 'conservative'
});
```

### Force Refresh
```typescript
const result = await mcp.callTool('calculate_trust_score', {
  targetPubkey: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
  forceRefresh: true
});
```

## MCP Server Configuration

### Server Info
```json
{
  "name": "relatr",
  "version": "1.0.0",
  "transport": "stdio"
}
```

### Running the Server
```bash
bun run src/mcp/server.ts
```

### Environment Requirements
See `.env.example` for required environment variables:
- `DEFAULT_SOURCE_PUBKEY` (required)
- `GRAPH_BINARY_PATH` (required)
- `NOSTR_RELAYS` (required)

## Limitations

1. **Social Graph Updates:** Requires external process to regenerate
2. **Relay Dependency:** Metrics depend on relay availability
3. **No Batch Operations:** One pubkey pair per request
4. **No Pagination:** Single score per request

## Future API Extensions

Potential additions:
- Batch trust score calculation
- Trust score history/trends
- Custom metric weights per request
- Real-time graph updates
- Pubkey search by trust score threshold

## Support

For issues or questions:
- Review documentation in `docs/lld/`
- Check logs for error details
- Verify environment configuration
