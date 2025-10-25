#!/bin/sh
set -e

# Default data directory
DATA_DIR=${DATA_DIR:-/usr/src/app/data}

# Create data directory if it doesn't exist (with fallback)
if [ ! -d "$DATA_DIR" ]; then
    echo "Creating data directory: $DATA_DIR"
    mkdir -p "$DATA_DIR" 2>/dev/null || {
        echo "Warning: Could not create data directory $DATA_DIR"
        echo "This is normal when using mounted volumes - continuing..."
    }
fi

# Ensure proper ownership of data directory (with fallback)
# This allows the container user to write to mounted volumes
chown -R bun:bun "$DATA_DIR" 2>/dev/null || {
    echo "Warning: Could not change ownership of $DATA_DIR"
    echo "This is normal when using mounted volumes - continuing..."
}

# Set proper permissions (750 for directories, 640 for files) with fallback
find "$DATA_DIR" -type d -exec chmod 750 {} \; 2>/dev/null || true
find "$DATA_DIR" -type f -exec chmod 640 {} \; 2>/dev/null || true

# Set environment variables for the application
export DATABASE_PATH="${DATABASE_PATH:-$DATA_DIR/relatr.db}"
export GRAPH_BINARY_PATH="${GRAPH_BINARY_PATH:-$DATA_DIR/socialGraph.bin}"

echo "Using database path: $DATABASE_PATH"
echo "Using graph binary path: $GRAPH_BINARY_PATH"

# Execute the main application
exec "$@"