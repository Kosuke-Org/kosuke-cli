#!/bin/bash
# docker-dev.sh - Run kosuke-cli in Docker for development
#
# This script builds and runs the kosuke-cli Docker container with:
# - Connection to kosuke_network
# - Current directory mounted for live development
# - Environment variables from .env file
# - Hot reload (build:watch) in left pane
# - Interactive shell in right pane

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="kosuke-cli-dev"
SESSION_NAME="kosuke-dev"

# Check for tmux
if ! command -v tmux &> /dev/null; then
    echo -e "${YELLOW}⚠️  tmux not found. Install with: brew install tmux${NC}"
    exit 1
fi

echo -e "${BLUE}🐋 Kosuke CLI - Docker Development Environment${NC}\n"

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  Warning: .env file not found${NC}"
    echo "Create a .env file with:"
    echo "  ANTHROPIC_API_KEY=your_key"
    echo "  GITHUB_TOKEN=your_token"
    echo ""
fi

# Check if tmux session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo -e "${BLUE}✓ Session already exists, attaching...${NC}"
    tmux attach -t "$SESSION_NAME"
    exit 0
fi

# Check if container is already running
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${BLUE}✓ Container already running${NC}"
else
    # Check if image exists, build if not
    if [[ "$(docker images -q kosuke-cli:dev 2> /dev/null)" == "" ]]; then
        echo -e "${BLUE}📦 Building Docker image (first time)...${NC}"
        docker build -t kosuke-cli:dev .
    else
        echo -e "${BLUE}✓ Using existing Docker image${NC}"
    fi

    echo -e "${BLUE}🚀 Starting container...${NC}\n"

    # Start container in detached mode
    docker run -d --rm \
      --name "$CONTAINER_NAME" \
      --network kosuke_network \
      -v "$(pwd):/workspace" \
      --env-file .env \
      kosuke-cli:dev \
      bash -c '
        # Run init without build:watch (we run it separately)
        if [ ! -d "node_modules" ]; then npm ci; fi
        if [ ! -d "dist" ]; then npm run build; fi
        if ! command -v kosuke &> /dev/null; then npm link; fi
        tail -f /dev/null
      '

    # Wait for container to be ready
    sleep 2
fi


# Cleanup function
cleanup() {
    echo -e "\n${BLUE}🧹 Stopping container...${NC}"
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
}

# Create tmux session with two panes
tmux new-session -d -s "$SESSION_NAME" -n "kosuke"

# Enable mouse support (scroll, click, resize panes)
tmux set-option -t "$SESSION_NAME" -g mouse on

# Left pane: build:watch
tmux send-keys -t "$SESSION_NAME" "docker exec -it $CONTAINER_NAME bash -c 'npm run build:watch'" Enter

# Split vertically (right pane)
tmux split-window -h -t "$SESSION_NAME"

# Right pane: interactive shell
tmux send-keys -t "$SESSION_NAME" "docker exec -it $CONTAINER_NAME bash -c 'kosuke'" Enter

# Focus on right pane (interactive shell)
tmux select-pane -t "$SESSION_NAME":0.1

# Attach to session
tmux attach -t "$SESSION_NAME"

# Always cleanup on exit
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
cleanup

echo ""
echo -e "${GREEN}✅ Done.${NC}"
echo ""
