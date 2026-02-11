# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json automate_shorts.ts get_topic.ts ./
COPY backend ./backend
RUN npm run build

# Run stage
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/backend ./backend
COPY --from=builder /app/automate_shorts.js ./

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "backend/server.js"]
