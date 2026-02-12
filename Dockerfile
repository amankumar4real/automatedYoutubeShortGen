# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json automate_shorts.ts get_topic.ts ./
COPY backend ./backend
RUN npm run build

# Run stage (non-root)
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/backend ./backend
COPY --from=builder /app/automate_shorts.js ./

# Ensure app dir is writable by node (for pipeline temp/output when using default cwd)
RUN chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 4000

USER node

CMD ["node", "backend/server.js"]
