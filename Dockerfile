FROM node:20-slim AS deps
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/eslint-config/package.json ./packages/eslint-config/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN cd packages/database && npx prisma generate --schema=prisma/platform/schema.prisma
RUN pnpm --filter @campusos/shared build
RUN pnpm --filter @campusos/database build
RUN pnpm --filter @campusos/api build

FROM node:20-slim AS runner
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN addgroup --system campusos && adduser --system --ingroup campusos campusos
WORKDIR /app
COPY --from=builder /app/ ./
USER campusos
EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000
CMD ["node", "apps/api/dist/main.js"]
