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

## Getting Started

### Docker Compose

The easiest way to run Relatr is using Docker Compose. A complete `docker-compose.yml` is included in the repository.

#### Quick Start

```bash
# Clone the repository
git clone https://github.com/contextvm/relatr.git
cd relatr

# Copy the example environment file
cp .env.example .env

# Generate a server secret key
openssl rand -hex 32

# Edit .env and set your SERVER_SECRET_KEY
nano .env

# Start the service
docker compose up -d

# View logs
docker compose logs -f
```

#### Environment Configuration

Create a `.env` file with at minimum:

```bash
SERVER_SECRET_KEY=your_generated_hex_key_here
```

**Required Variables:**

- `SERVER_SECRET_KEY` - Server's Nostr private key (hex format)

**Optional Variables:**

- `DEFAULT_SOURCE_PUBKEY` - Default perspective pubkey for trust calculations (hex format) (defaults to Gigi's pubkey)
- `NOSTR_RELAYS` - Comma-separated relay URLs for social graph data
- `SERVER_RELAYS` - Comma-separated relay URLs for server operations
- `GRAPH_BINARY_PATH` - Path to social graph binary file (default: ./data/socialGraph.bin)
- `DATABASE_PATH` - SQLite database path (default: ./data/relatr.db)
- `DECAY_FACTOR` - Alpha parameter in distance formula (default: 0.1)
- `NUMBER_OF_HOPS` - Social graph traversal depth (default: 1)
- `CACHE_TTL_SECONDS` - Cache time-to-live (default: 604800 = 1 week)

See `.env.example` for a complete configuration template with all available options.

#### Managing the Service

```bash
# Start the service
docker compose up -d

# View logs
docker compose logs -f

# Stop the service
docker compose down

# Restart the service
docker compose restart

# Update to latest version
docker compose pull
docker compose up -d
```

## Architecture Overview

Relatr uses a modular architecture with clear separation of concerns:

### Core Components

- **RelatrService**: Main service orchestrating all components
- **SocialGraph**: Manages Nostr social graph data and distance calculations
- **TrustCalculator**: Computes final trust scores from metrics
- **MetricsValidator**: Validates profile characteristics using plugin system
- **DataStore**: Persistent caching layer using SQLite

## System Requirements

Relatr is designed to be resource-efficient with minimal hardware requirements:

### Minimum Requirements

- **CPU**: 1 core (x86-64 or ARM64)
- **RAM**: 256MB (50MB app + headroom)
- **Storage**: 256MB

### Recommended for Production

- **CPU**: 2 cores
- **RAM**: 1MB
- **Storage**: 1GB SSD

**Memory is the primary bottleneck** - the social graph binary must be fully loaded in memory for fast distance calculations. CPU requirements are modest for most operations.

## Development

For development and contributing to Relatr, see the development documentation in the repository.
