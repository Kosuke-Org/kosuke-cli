#!/bin/bash

# docker-dev.sh - Run kosuke-cli in Docker for development
#
# This script builds and runs the kosuke-cli Docker container with:
# - Connection to kosuke_network
# - Current directory mounted for live development
# - Environment variables from .env file
# - Memory limits to prevent host system freeze
#
# Usage:
#   ./docker-dev.sh                    # Default 6GB memory limit
#   ./docker-dev.sh --memory=8g        # Custom memory limit
#   ./docker-dev.sh --memory=4g        # Lower limit for constrained systems

set -e

# Default memory limit (prevents container from freezing host)
MEMORY_LIMIT="6g"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --memory=*)
      MEMORY_LIMIT="${1#*=}"
      shift
      ;;
    --help|-h)
      echo "Usage: ./docker-dev.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --memory=SIZE    Set container memory limit (default: 6g)"
      echo "                   Examples: --memory=4g, --memory=8g"
      echo "  --help, -h       Show this help message"
      echo ""
      echo "The memory limit prevents the container from consuming all host RAM"
      echo "and freezing your system during long-running operations like 'kosuke build'."
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🐋 Kosuke CLI - Docker Development Environment${NC}"
echo -e "${BLUE}📊 Memory limit: ${MEMORY_LIMIT}${NC}\n"

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  Warning: .env file not found${NC}"
    echo "Create a .env file with:"
    echo "  ANTHROPIC_API_KEY=your_key"
    echo "  GITHUB_TOKEN=your_token"
    echo ""
fi

# Check if image exists, build if not
if [[ "$(docker images -q kosuke-cli:dev 2> /dev/null)" == "" ]]; then
    echo -e "${BLUE}📦 Building Docker image (first time)...${NC}"
    docker build -t kosuke-cli:dev .
else
    echo -e "${BLUE}✓ Using existing Docker image${NC}"
    echo -e "${BLUE}  (Run 'docker build -t kosuke-cli:dev .' to rebuild)${NC}\n"
fi

# Run the container
echo -e "${BLUE}🚀 Starting container...${NC}"
echo -e "${BLUE}📦 Installing dependencies (if needed)...${NC}\n"

docker run -it --rm \
  --name kosuke-cli-dev \
  --network kosuke_network \
  --memory="${MEMORY_LIMIT}" \
  --memory-swap="${MEMORY_LIMIT}" \
  -v "$(pwd):/workspace" \
  --env-file .env \
  kosuke-cli:dev \
  bash -c '
    # Install dependencies if node_modules doesn't exist
    if [ ! -d "node_modules" ]; then
      echo "📦 Installing dependencies..."
      npm ci
    else
      echo "✓ Dependencies already installed"
    fi

    # Build the CLI if dist doesn't exist
    if [ ! -d "dist" ]; then
      echo "🔨 Building CLI..."
      npm run build
    else
      echo "✓ CLI already built"
    fi

    # Link globally if not already linked
    if ! command -v kosuke &> /dev/null; then
      echo "🔗 Linking CLI globally..."
      npm link
    else
      echo "✓ CLI already linked"
    fi

    echo ""
    echo "✅ Setup complete! Kosuke CLI is ready."
    echo ""
    echo "Available commands:"
    echo "  kosuke sync-rules"
    echo "  kosuke analyse"
    echo "  kosuke lint"
    echo "  kosuke requirements"
    echo "  kosuke plan"
    echo "  kosuke getcode \"query\""
    echo ""
    echo "Development:"
    echo "  npm run build          # Rebuild after changes"
    echo "  npm run build:watch    # Auto-rebuild on changes"
    echo "  npm test               # Run tests"
    echo "  exit                   # Exit container"
    echo ""

    exec bash
  '

echo -e "\n${GREEN}✅ Container stopped${NC}"

