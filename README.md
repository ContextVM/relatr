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

### Pull the Latest Docker Image

Relatr is automatically built and published to GitHub Container Registry on every commit to the master branch. You can pull the latest image using:

```bash
# Pull the latest image from GitHub Container Registry
docker pull ghcr.io/contextvm/relatr:latest

# Or pull a specific commit-based tag (example)
docker pull ghcr.io/contextvm/relatr:master-5d0b2be
```

### Run the Container

The Docker image runs the ContextVM MCP server by default, which provides tools for trust score calculation, profile search, and health checks.

#### Basic Configuration

```bash
# Minimal configuration - only server secret key required
docker run -d -p 3000:3000 \
  -e SERVER_SECRET_KEY=your_server_privkey_here \
  ghcr.io/contextvm/relatr:latest
```

#### Advanced Configuration

```bash
# With custom relays and persistent data storage
docker run -d -p 3000:3000 \
  -e SERVER_SECRET_KEY=your_server_privkey_here \
  -e SERVER_RELAYS=wss://nostr.example.com,wss://relay.com \
  -e LOG_DESTINATION=file \
  -e LOG_FILE=/tmp/app.log \
  -v $(pwd)/data:/usr/src/app/data \
  ghcr.io/contextvm/relatr:latest

# With environment file (recommended for production)
docker run -d -p 3000:3000 \
  --env-file .env \
  ghcr.io/contextvm/relatr:latest
```

### Docker Compose

For production deployments, use Docker Compose:

```yaml
# docker-compose.yml
version: "3.8"
services:
  relatr:
    image: ghcr.io/contextvm/relatr:latest
    ports:
      - "3000:3000"
    environment:
      - SERVER_SECRET_KEY=your_server_privkey_here
      - LOG_DESTINATION=file
      - LOG_FILE=/tmp/app.log
    volumes:
      - ./data:/usr/src/app/data
    restart: unless-stopped
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