# Relatr: A Decentralized Web of Trust Metric Service for Nostr

**Relatr** is a comprehensive, high-performance service that computes trust scores for [Nostr](https://nostr.com/) profiles. It provides a decentralized web of trust metric, enabling applications to evaluate profile trustworthiness based on a multi-faceted analysis of social graph data, profile validation, and some activity metrics.

Relatr is designed to be a foundational component for Nostr clients, relays, and other services that need to assess profile quality and authenticity. By leveraging a sophisticated weighting system and a caching layer, it delivers fast and accurate trust scores.

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [API Documentation](#api-documentation)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Trust Score Calculation:** Implements a configurable, multi-factor trust score based on:
    - **Social Graph Distance:** Measures the social distance from a trusted root node.
    - **Profile Validation Metrics:**
        - NIP-05 Verification
        - Lightning Address/LUD-16 Validation
        - Profile and Events
        - Reciprocity (Mutual Follows)
- **High-Performance Caching:** Utilizes an in-memory and SQLite-based caching strategy for rapid score retrieval.
- **Pre-computed Social Graph:** Integrates with a pre-computed social graph for efficient distance calculations.
- **MCP Server:** Exposes trust score data via a standard MCP server interface.
- **Configurable Weighting:** Allows customization of the weighting scheme to tailor trust score calculations to specific needs.
- **Extensible Architecture:** Designed for modularity, allowing new metrics and data sources to be easily integrated.

## Architecture Overview

Relatr's architecture is designed for performance, scalability, and extensibility. The core components include:

- **Service Orchestration Layer:** The main entry point that coordinates the different modules.
- **Database Layer:** Manages the SQLite database for caching social graph data, profile metrics, and trust scores.
- **Social Graph Manager:** Loads and queries the pre-computed social graph.
- **Distance Normalizer:** Calculates and normalizes the social distance between profiles.
- **Profile Metrics Collector:** Gathers and validates profile metrics like NIP-05 and Lightning addresses.
- **Trust Score Calculator:** Computes the final trust score based on the configured weighting scheme.
- **MCP Server:** Provides an MCP interface for clients to query trust scores.

For a more in-depth understanding of the architecture, please refer to our [High-Level Design (HLD)](docs/hdd.md) and the detailed [Low-Level Design (LLD) documents](docs/lld/).

## Installation

To get started with Relatr, follow these steps:

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-repo/relatr.git
    cd relatr
    ```

2.  **Install dependencies:**
    Relatr uses [Bun](https://bun.sh/) as its JavaScript runtime.
    ```bash
    bun install
    ```

3.  **Set up the environment:**
    Copy the example environment file and customize it as needed.
    ```bash
    cp .env.example .env
    ```
    See the [Configuration](#configuration) section for more details on the available options.

4.  **Initialize the database:**
    This script sets up the necessary tables in the SQLite database.
    ```bash
    bun run scripts/init-db.ts
    ```

## Configuration

Relatr is configured via environment variables. The following variables are available:

| Variable                  | Description                                                 | Default                |
| ------------------------- | ----------------------------------------------------------- | ---------------------- |
| `DATABASE_PATH`           | Path to the SQLite database file.                           | `data/relatr.db`       |
| `SOCIAL_GRAPH_PATH`       | Path to the pre-computed social graph file.                 | `data/socialGraph.bin` |
| `ROOT_PUBLIC_KEY`         | The public key of the root node for distance calculations.  |                        |
| `MCP_SERVER_PORT`         | The port for the MCP server.                                | `8080`                 |
| `LOG_LEVEL`               | The log level for the application.                          | `info`                 |
| `WEIGHT_SCHEME`           | The weighting scheme to use for trust score calculations.   | `default`              |

For more details on configuring weighting schemes, see the [Weighting Schemes Guide](docs/weighting-schemes.md).

## Development

We welcome contributions to Relatr! To set up a development environment, follow the [Installation](#installation) instructions.

### Running Tests

To run the test suite, use the following command:

```bash
bun test
```

### Code Structure

The project is organized into the following directories:

- `src/`: The main source code for the application.
  - `config/`: Environment and configuration management.
  - `database/`: SQLite database connection and queries.
  - `distance/`: Social distance normalization.
  - `mcp/`: The MCP server implementation.
  - `metrics/`: Profile metrics collection and validation.
  - `services/`: The main Relatr service orchestrator.
  - `social-graph/`: Social graph management.
  - `trust/`: Trust score calculation and weighting.
- `scripts/`: Utility scripts for database initialization, etc.
- `docs/`: Project documentation.
- `data/`: Data files, including the database and social graph.

For more details, please see the [Implementation Guide](docs/lld/00-implementation-guide.md).

## Contributing

Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.
