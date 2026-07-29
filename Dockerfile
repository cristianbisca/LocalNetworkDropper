# Syntax directive for buildkit features
# syntax=docker/dockerfile:1

# ─── Stage 1: Build/Install dependencies ─────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production --ignore-scripts

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy installed dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY package.json ./
COPY server.js ./
COPY public/ ./public/

# Create uploads directory with proper permissions
RUN mkdir -p /app/uploads && chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose the port (default 4200, can be overridden via LND_PORT env var)
EXPOSE 4200

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:4200/api/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Make stdout/stderr unbuffered for docker logs visibility
ENV FORCE_COLOR=1

# Start the server
CMD ["node", "server.js"]
