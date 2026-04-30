FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

FROM deps AS build
COPY . .
RUN DATABASE_URL="postgresql://user:password@localhost:5432/stackaura?schema=public" \
    DIRECT_URL="postgresql://user:password@localhost:5432/stackaura?schema=public" \
    npx prisma generate
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --omit=dev && \
    DATABASE_URL="postgresql://user:password@localhost:5432/stackaura?schema=public" \
    DIRECT_URL="postgresql://user:password@localhost:5432/stackaura?schema=public" \
    npx prisma generate && \
    npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["npm", "run", "start:prod"]
