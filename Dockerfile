# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine

# Install MongoDB tools (including mongodump)
RUN apk add --no-cache mongodb-tools

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/src/i18n ./dist/i18n

# Create uploads directory
RUN mkdir -p uploads/receipts uploads/avatars

EXPOSE 5000

CMD ["npm", "start"]
