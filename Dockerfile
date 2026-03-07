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

# Installer PM2 Globalement pour gérer les clusters
RUN npm install pm2 -g

# Copier la configuration PM2
COPY ecosystem.config.js .

EXPOSE 5000

# Lancer via PM2
CMD ["pm2-runtime", "ecosystem.config.js"]
