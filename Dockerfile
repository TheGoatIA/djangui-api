# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# `npm ci` : installation reproductible, strictement alignée sur package-lock.json
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine

# Install MongoDB tools (including mongodump)
RUN apk add --no-cache mongodb-tools

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/src/i18n ./dist/i18n

# PM2 (gestion du cluster) installé dans /opt/pm2, version ÉPINGLÉE, avec les dépendances
# transitives vulnérables forcées vers leurs versions corrigées (overrides) : pm2@7.0.4 tire
# encore basic-ftp 5.3.1 et js-yaml 4.3.1 (CVE HIGH corrigeables, relevées par Trivy).
# npm/npx/yarn sont ensuite RETIRÉS : inutiles à l'exécution (pm2-runtime + node suffisent)
# et leurs dépendances embarquées étaient une source de CVE de l'image.
RUN mkdir -p /opt/pm2 && cd /opt/pm2 \
    && echo '{"name":"pm2-env","private":true,"dependencies":{"pm2":"7.0.4"},"overrides":{"basic-ftp":"^6.2.1","js-yaml":"^4.3.2"}}' > package.json \
    && npm install --omit=dev --no-audit --no-fund && npm cache clean --force \
    && ln -s /opt/pm2/node_modules/.bin/pm2-runtime /usr/local/bin/pm2-runtime \
    && ln -s /opt/pm2/node_modules/.bin/pm2 /usr/local/bin/pm2 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
              /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm

# Copier la configuration PM2
COPY ecosystem.config.js .

# Répertoires inscriptibles (uploads, logs, backups) puis exécution SANS root :
# un RCE applicatif n'obtient plus les droits root dans le conteneur.
# NB : les dossiers montés depuis l'hôte (./uploads, ./backups) doivent appartenir
# à l'uid 1000 (`chown -R 1000:1000 uploads backups`) — voir DEPLOYMENT.md.
RUN mkdir -p uploads/receipts uploads/avatars uploads/voice-notes logs backups \
    && chown -R node:node /app
USER node

EXPOSE 5000

# /api/health répond 503 si MongoDB ou Redis sont injoignables.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-5000}/api/health" || exit 1

# Lancer via PM2
CMD ["pm2-runtime", "ecosystem.config.js"]
