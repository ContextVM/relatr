# Relatr

A decentralized web of trust metric service for Nostr that computes personalized trust scores by combining social graph distances with profile validation metrics.

## Overview

Relatr measures relative trust between Nostr public keys by analyzing social graph proximity and validating profile characteristics. It uses a weighted scoring system to produce a comprehensive trust metric that can be personalized from any source pubkey's perspective.

## Features

- **Social Graph Analysis**: Calculates trust distances using nostr-social-graph
- **Profile Validation**: Validates NIP-05, Lightning addresses, and event publications
- **Reciprocity Checking**: Verifies mutual follow relationships
- **Configurable Scoring**: Flexible weighting schemes for different trust factors
- **Persistent Caching**: SQLite-based caching for performance optimization
- **MCP Server Interface**: Model Context Protocol API for integration

## Quick Start

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd relatr

# Install dependencies
bun install

# Copy environment configuration
cp .env.example .env

# Initialize the database
bun run mcp
```

### Configuration

Edit `.env` with your settings:

```env
DEFAULT_SOURCE_PUBKEY=your_default_pubkey
GRAPH_BINARY_PATH=./data/socialGraph.bin
DATABASE_PATH=./data/relatr.db
NOSTR_RELAYS=wss://relay.nostr.org,wss://relay.damus.io
DECAY_FACTOR=0.1
CACHE_TTL_SECONDS=3600
```

### Running the Service

```bash
# Start the MCP server
bun run mcp

# Or run directly
bun run index.ts
```

## Architecture

### Core Components

1. **RelatrService**: Main service orchestrating all components
2. **SocialGraph**: Manages Nostr social graph data and distance calculations
3. **TrustCalculator**: Computes final trust scores from metrics
4. **MetricsValidator**: Validates profile characteristics
5. **SimpleCache**: Persistent caching layer using SQLite

### Trust Score Calculation

The trust score is computed using a weighted formula:

```
Trust Score = Σ(wi × vi) / Σ(wi)
```

Where:

- `wi` = weight for metric i
- `vi` = normalized value for metric i (0.0-1.0)

### Metrics

| Metric      | Type         | Weight | Description                       |
| ----------- | ------------ | ------ | --------------------------------- |
| Distance    | Float (0-1)  | 0.5    | Social graph proximity with decay |
| NIP-05      | Binary (0/1) | 0.15   | Valid NIP-05 identifier           |
| Lightning   | Binary (0/1) | 0.1    | Lightning Network address         |
| Event 10002 | Binary (0/1) | 0.1    | Published relay list              |
| Reciprocity | Binary (0/1) | 0.15   | Mutual follow relationship        |

## API Usage

### Calculate Trust Score

```typescript
import { RelatrService } from "./src/service/RelatrService";

const service = new RelatrService(config);
await service.initialize();

const result = await service.calculateTrustScore({
  targetPubkey: "target_pubkey", // Required
  sourcePubkey: "source_pubkey", // Optional, uses default if not provided
  weightingScheme: "progressive", // Optional: 'default', 'conservative', 'progressive', 'balanced'
});
```

#### MCP Tool Usage

The MCP server provides a simplified interface where only the target pubkey is required:

```bash
# Basic usage - only target pubkey required
calculate_trust_score targetPubkey="abc123..."

# With optional parameters
calculate_trust_score targetPubkey="abc123..." sourcePubkey="def456..." weightingScheme="progressive"
```

### Health Check

```typescript
const health = await service.healthCheck();
// Returns: { status: 'healthy' | 'unhealthy', database: boolean, socialGraph: boolean }
```

### Cache Management

```typescript
// Clear cache for specific pubkey
await service.manageCache("clear", "target_pubkey");

// Clear all cache
await service.manageCache("clear");

// Clean up expired entries
await service.manageCache("cleanup");

// Get cache statistics
await service.manageCache("stats");
```

## Configuration Options

### Weighting Schemes

- **default**: Balanced approach with standard weights
- **conservative**: Higher emphasis on social distance
- **progressive**: Higher emphasis on profile validations
- **custom**: Provide your own weight configuration

### Cache Settings

- `cacheTtlSeconds`: Time-to-live for cached entries (default: 3600)
- Cache is automatically cleaned up on expiration
- Persistent storage survives application restarts

## Development

### Project Structure

```
src/
├── service/          # Main service orchestration
├── database/         # Database connection and caching
├── graph/           # Social graph management
├── trust/           # Trust score calculation
├── validators/      # Profile validation logic
├── mcp/             # MCP server implementation
└── types.ts         # TypeScript type definitions
```

### Running Tests

```bash
bun test
```

### Database Schema

The service uses SQLite with two main cache tables:

- `profile_metrics`: Stores validated profile characteristics
- `trust_scores`: Stores computed trust scores with component breakdown
