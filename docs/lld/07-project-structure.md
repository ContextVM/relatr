# Low-Level Design: Project Directory Structure

## Overview

This document defines the complete directory structure for the Relatr project, organized by module with clear separation of concerns.

## Directory Tree

```
relatr/
├── src/
│   ├── mcp/
│   │   └── server.ts                 # MCP server entry point
│   ├── services/
│   │   └── RelatrService.ts          # Main orchestrator service
│   ├── social-graph/
│   │   ├── SocialGraphManager.ts     # Graph manager
│   │   ├── GraphPersistence.ts       # Binary serialization
│   │   └── types.ts                  # Type definitions
│   ├── distance/
│   │   ├── DistanceNormalizer.ts     # Distance normalization
│   │   ├── DecayProfiles.ts          # Pre-defined decay configs
│   │   └── types.ts
│   ├── metrics/
│   │   ├── ProfileMetricsCollector.ts
│   │   ├── validators/
│   │   │   ├── Nip05Validator.ts
│   │   │   ├── LightningValidator.ts
│   │   │   ├── EventValidator.ts
│   │   │   └── ReciprocityValidator.ts
│   │   ├── cache/
│   │   │   └── MetricsCache.ts
│   │   └── types.ts
│   ├── trust/
│   │   ├── TrustScoreCalculator.ts
│   │   ├── WeightingScheme.ts
│   │   ├── TrustScoreCache.ts
│   │   └── types.ts
│   ├── database/
│   │   ├── schema.sql                # Database schema
│   │   └── migrations/               # Schema migrations
│   │       └── 001_initial.ts
│   └── config/
│       └── environment.ts            # Environment config loader
├── data/
│   ├── socialGraph.bin               # Pre-computed social graph
│   └── relatr.db                     # SQLite database
├── tests/
│   ├── social-graph/
│   ├── distance/
│   ├── metrics/
│   ├── trust/
│   └── integration/
├── docs/
│   ├── hdd.md                        # High-Level Design
│   └── lld/                          # Low-Level Designs
│       ├── 01-database-schema.md
│       ├── 02-social-graph-integration.md
│       ├── 03-distance-normalization.md
│       ├── 04-profile-validation-metrics.md
│       ├── 05-trust-score-computation.md
│       ├── 06-mcp-server-interface.md
│       ├── 07-project-structure.md
│       └── 08-data-flow.md
├── scripts/
│   ├── init-db.ts                    # Initialize database
│   ├── crawl-graph.ts                # Generate social graph
│   └── test-trust-score.ts           # Manual testing script
├── .env.example                      # Environment template
├── .gitignore
├── package.json
├── tsconfig.json
├── bunfig.toml                       # Bun configuration
└── README.md
```

## Module Organization

### `/src/mcp/` - MCP Server
Entry point for the Model Context Protocol server.

### `/src/services/` - Service Layer
Orchestrates all modules to fulfill business logic.

### `/src/social-graph/` - Social Graph Module
Manages the nostr-social-graph integration.

### `/src/distance/` - Distance Normalization
Converts graph distances to normalized weights.

### `/src/metrics/` - Profile Validation Metrics
Validates NIP-05, Lightning, event kinds, and reciprocity.

### `/src/trust/` - Trust Score Computation
Calculates final trust scores using weighted formula.

### `/src/database/` - Database Layer
Schema definitions and migrations.

### `/src/config/` - Configuration
Environment and configuration management.

## Data Files

### `/data/socialGraph.bin`
Pre-computed social graph in binary format from `nostr-social-graph`.

### `/data/relatr.db`
SQLite database for caching metrics and trust scores.

## Key Configuration Files

### `package.json`
```json
{
  "name": "relatr",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "mcp": "bun run src/mcp/server.ts",
    "init-db": "bun run scripts/init-db.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "nostr-tools": "^2.0.0",
    "nostr-social-graph": "^1.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "bun-types": "latest"
  }
}
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### `.env.example`
```bash
DEFAULT_SOURCE_PUBKEY=
GRAPH_BINARY_PATH=data/socialGraph.bin
DB_PATH=data/relatr.db
NOSTR_RELAYS=wss://relay.damus.io,wss://relay.nostr.band
DECAY_FACTOR=0.1
CACHE_TTL=3600
```

## File Naming Conventions

- **Classes**: PascalCase (e.g., `TrustScoreCalculator.ts`)
- **Types**: PascalCase (e.g., `types.ts` exports PascalCase types)
- **Utilities**: camelCase (e.g., `helpers.ts`)
- **Constants**: UPPER_SNAKE_CASE in `constants.ts` files
- **Tests**: `*.test.ts` or `*.spec.ts`

## Import Path Aliases

Configure in `tsconfig.json`:
```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@social-graph/*": ["./src/social-graph/*"],
      "@metrics/*": ["./src/metrics/*"],
      "@trust/*": ["./src/trust/*"],
      "@distance/*": ["./src/distance/*"]
    }
  }
}
```

Usage:
```typescript
import { SocialGraphManager } from '@social-graph/SocialGraphManager';
import { TrustScoreCalculator } from '@trust/TrustScoreCalculator';
```

## Build Output

For deployment, consider:
```
dist/
├── mcp-server.js           # Bundled MCP server
└── types/                  # TypeScript declarations
```

Build command:
```bash
bun build src/mcp/server.ts --outdir dist --target node