# Dockerfile for kosuke-cli development
# Use Node.js LTS version
FROM node:20-slim

# Install git (required for simple-git operations)
RUN apt-get update && \
    apt-get install -y git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Set environment to development
ENV NODE_ENV=development

# Note: Source code and dependencies are mounted as volumes at runtime
# This allows for live development without rebuilding the image

# Default command: bash for interactive development
CMD ["/bin/bash"]

