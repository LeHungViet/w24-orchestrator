# W24 Orchestrator — Railway Deployment
# Multi-tenant OC process manager

FROM node:24-slim

# Install OpenClaw CLI globally
RUN npm install -g openclaw@latest

# Verify openclaw is available
RUN openclaw --version

# Create app directory
WORKDIR /app

# Copy package files first (better Docker layer caching)
COPY package.json package-lock.json ./

# Install dependencies (production only)
RUN npm ci --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm install -D typescript @types/node @types/express @types/node-telegram-bot-api && npm run build

# Create tenants directory (Railway volume will mount here)
RUN mkdir -p /data/w24-tenants

# Set default env vars
ENV NODE_ENV=production
ENV TENANTS_DIR=/data/w24-tenants
ENV PORT=3500

# Expose port (Railway auto-detects)
EXPOSE 3500

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3500/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start
CMD ["node", "dist/index.js"]
