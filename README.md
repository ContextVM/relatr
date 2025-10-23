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

### Building the Application

```bash
# Build the application (bundled JavaScript)
bun run build

# The built application will be in the dist/ directory
bun run dist/index.js --help

# Compile to standalone binary (recommended for production)
bun run compile

# Run the compiled binary
./relatr --help
```

### Running the Service

```bash
# Start the MCP server
bun run mcp

# Or run directly
bun run index.ts

# Or run the built version
bun run dist/index.js
```

## Docker Deployment

Relatr can be easily containerized using Docker for consistent deployment across different environments. The Docker image compiles the application into a standalone binary for optimal performance.

### Building the Docker Image

```bash
# Build the Docker image
docker build --pull -t relatr .

# Or build with a specific tag
docker build --pull -t relatr:latest .
```

### Running with Docker

The Docker image runs the ContextVM MCP server by default, which provides tools for trust score calculation, profile search, and health checks.

```bash
# Minimal configuration - only server secret key required
docker run -d -p 3000:3000 \
  -e SERVER_SECRET_KEY=your_server_privkey_here \
  -e LOG_DESTINATION=file \
  -e LOG_FILE=/tmp/app.log \
  relatr

# With custom relays
docker run -d -p 3000:3000 \
  -e SERVER_SECRET_KEY=your_server_privkey_here \
  -e SERVER_RELAYS=wss://nostr.example.com,wss://relay.com \
  -e LOG_DESTINATION=file \
  -e LOG_FILE=/tmp/app.log \
  relatr

# With persistent data storage
docker run -d -p 3000:3000 \
  -e SERVER_SECRET_KEY=your_server_privkey_here \
  -e LOG_DESTINATION=file \
  -e LOG_FILE=/tmp/app.log \
  -v $(pwd)/data:/usr/src/app/data \
  relatr

# With environment file (recommended for production)
docker run -d -p 3000:3000 \
  --env-file .env \
  relatr
```

### Docker Compose

For more complex deployments, you can use Docker Compose. The container runs the MCP server by default.

```yaml
# docker-compose.yml
version: "0.1"
services:
  relatr:
    build: .
    ports:
      - "3000:3000"
    environment:
      - SERVER_SECRET_KEY=your_server_privkey_here
      - LOG_DESTINATION=file
      - LOG_FILE=/tmp/app.log
      # Optional: Add other environment variables as needed
      # - SERVER_RELAYS=wss://nostr.example.com,wss://relay.com
      # - DEFAULT_SOURCE_PUBKEY=your_pubkey_here
    volumes:
      - ./data:/usr/src/app/data
    restart: unless-stopped
```

## Architecture

### Core Components

1. **RelatrService**: Main service orchestrating all components
2. **SocialGraph**: Manages Nostr social graph data and distance calculations
3. **TrustCalculator**: Computes final trust scores from metrics
4. **MetricsValidator**: Validates profile characteristics
5. **DataStore**: Persistent caching layer using SQLite

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
| Exact Match | Binary (0/1) | 0.05   | Exact name/NIP-05 match           |
| Root NIP-05 | Binary (0/1) | 0.05   | Root domain NIP-05 identifier     |

#### Validation System Architecture

Relatr uses a validation system with complete separation of concerns between validation logic and weight management:

**Core Principles:**

- **Pure Validation Plugins**: Contain only validation logic, no weights
- **Dynamic Weight Profiles**: Separate weight management from plugins
- **Flexible Configuration**: Switch between weight schemes without recreating plugins
- **Automatic Normalization**: Handles weight sums that exceed 1.0 gracefully

**Validation Plugins (Pure Logic):**

- `Nip05Plugin`: Validates NIP-05 identifiers
- `LightningPlugin`: Validates Lightning addresses (lud16/lud06)
- `EventPlugin`: Checks for kind 10002 relay list events
- `ReciprocityPlugin`: Validates mutual follow relationships
- `ExactMatchPlugin`: Checks for exact name/NIP-05 matches
- `RootNip05Plugin`: Validates root domain NIP-05 identifiers

**Weight Profiles (Scoring Strategy):**

- **default**: Balanced approach (50% social, 50% validation)
- **social**: Heavy emphasis on social graph (70% social)
- **validation**: Heavy emphasis on profile validation (75% validation)
- **strict**: Balanced but demanding requirements

**Adding Custom Validation Plugins:**

```typescript
import { ValidationPlugin, ValidationContext } from "./src/validators/plugins";

export class CustomPlugin implements ValidationPlugin {
  name = "customMetric";

  async validate(ctx: ValidationContext): Promise<number> {
    // Your validation logic here
    return 1.0; // or 0.0
  }
}

// Register with the validator
validator.registerPlugin(new CustomPlugin());
// Note: Weights are defined in weight profiles, not in plugins
```

## API Usage

### Calculate Trust Score

```typescript
import { RelatrService } from "./src/service/RelatrService";

const service = new RelatrService(config);
await service.initialize();

const result = await service.calculateTrustScore({
  targetPubkey: "target_pubkey", // Required
  sourcePubkey: "source_pubkey", // Optional, uses default if not provided
  weightingScheme: "validation", // Optional: 'default', 'social', 'validation', 'strict'
});
```

#### MCP Tool Usage

The MCP server provides a simplified interface where only the target pubkey is required:

```bash
# Basic usage - only target pubkey required
calculate_trust_score targetPubkey="abc123..."

# With optional parameters
calculate_trust_score targetPubkey="abc123..." sourcePubkey="def456..." weightingScheme="validation"
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

### Weight Profiles

All trust scores and component values are rounded to 3 decimal places for consistency and readability.

Weight profiles are managed by the `WeightProfileManager` and can be dynamically switched:

- **default**: Balanced approach favoring social graph (50%) with moderate profile validation
  - Distance: 0.50, Validators: NIP-05: 0.15, Lightning: 0.10, Event: 0.10, Reciprocity: 0.15, Exact Match: 0.05, Root NIP-05: 0.05

- **social**: Heavy emphasis on social graph proximity (70%), trusts the network
  - Distance: 0.70, Validators: NIP-05: 0.10, Lightning: 0.05, Event: 0.05, Reciprocity: 0.10, others: 0.00

- **validation**: Heavy emphasis on profile validations (75%), trusts verified identities
  - Distance: 0.25, Validators: NIP-05: 0.25, Lightning: 0.20, Event: 0.15, Reciprocity: 0.15, Exact Match: 0.10, Root NIP-05: 0.10

- **strict**: Balanced but demanding, requires both strong connections AND validations
  - Distance: 0.40, Validators: NIP-05: 0.25, Lightning: 0.15, Event: 0.10, Reciprocity: 0.10, Exact Match: 0.05, Root NIP-05: 0.05

**Automatic Normalization**: If weights in a profile sum to more than 1.0, they are automatically normalized to prevent system errors.

**Creating Custom Weight Profiles:**

```typescript
import { WeightProfileManager } from "./src/validators/weight-profiles";

const manager = new WeightProfileManager();
manager.registerProfile({
  name: "custom",
  description: "Custom weight profile",
  distanceWeight: 0.6,
  validatorWeights: new Map([
    ["nip05Valid", 0.2],
    ["lightningAddress", 0.1],
    ["eventKind10002", 0.1],
  ]),
});
manager.activateProfile("custom");
```

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
├── validators/      # Profile validation system
│   ├── plugins.ts   # Validation plugin implementations
│   ├── weight-profiles.ts # Weight profile management
│   └── MetricsValidator.ts
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
