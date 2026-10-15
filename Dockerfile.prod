# WA-AKG Production Dockerfile
# Builds the full app with PostgreSQL (Neon) support + custom server (Socket.io)

FROM node:22-alpine AS builder
RUN apk add --no-cache openssl ca-certificates python3 make g++
WORKDIR /app

# Copy dependency files
COPY package*.json ./
COPY patches ./patches/
COPY prisma ./prisma/

# Install dependencies
RUN npm ci --legacy-peer-deps && npm cache clean --force

# Swap to PostgreSQL schema for production
RUN cp prisma/schema.postgres.prisma prisma/schema.prisma

# Generate Prisma client
RUN npx prisma generate

# Copy source and build
COPY . .
RUN npm run build

# Strip devDeps, keep tsx for runtime
RUN npm prune --omit=dev && npm install --no-save tsx typescript

# ============ Production Image ============
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl ca-certificates
WORKDIR /app

# Copy built application
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/ecosystem.config.js ./

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

# Start: push schema → create admin (if env vars set) → start custom server with Socket.io
CMD ["sh", "-c", "npx prisma db push && (if [ -n \"$ADMIN_EMAIL\" ] && [ -n \"$ADMIN_PASSWORD\" ]; then node scripts/setup-admin.js \"$ADMIN_EMAIL\" \"$ADMIN_PASSWORD\"; fi) && node node_modules/tsx/dist/cli.mjs src/server/index.ts"]
