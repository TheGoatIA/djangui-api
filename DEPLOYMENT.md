# Guide de Déploiement Kauri

Ce guide couvre le déploiement de l'API Kauri de bout en bout : environnements Docker disponibles, variables d'environnement (applicatives et infrastructure), pipeline CI/CD, bootstrap du premier compte admin, sauvegardes, et — tout aussi important — ce qui **n'est pas** couvert par ce dépôt et reste à votre charge avant une mise en production réelle.

Pour la logique derrière ces choix, voir [ARCHITECTURE.md](ARCHITECTURE.md). Pour les procédures opérationnelles (rotation de secrets, incidents), voir [RUNBOOK.md](RUNBOOK.md).

---

## 1. Prérequis

| Outil | Version | Nécessaire pour |
| :-- | :-- | :-- |
| Docker + Docker Compose | 24+ / v2 | Tous les modes de déploiement (recommandé) |
| Node.js | 22 ou 24 (LTS) | Développement local sans Docker, ou build manuel (Node 18/20 : fin de vie) |
| Compte Google Gemini | — | Coach IA, OCR, analyse KYC (requis en production) |
| Compte Stripe et/ou NotchPay | — | Au moins un moyen de paiement requis en production |
| Firebase (Admin SDK) | — | Connexion Google/Apple/téléphone et notifications push (**requis en production**) |

---

## 2. Fichiers Docker Compose disponibles

Le dépôt fournit **cinq** fichiers compose, chacun pour un usage différent :

| Fichier | Usage | Contenu |
| :-- | :-- | :-- |
| `docker-compose.dev.yml` | Développement local | API + Mongo + Redis + MinIO (léger, ~2 Go RAM) |
| `docker-compose.minio.yml` | Stockage seul | MinIO isolé, utile pour tester le storage sans lancer toute la stack |
| `docker-compose.staging.yml` | Pré-production | Stack complète avec observabilité, pour valider en conditions réelles |
| `docker-compose.yml` | Référence infrastructure | API + Mongo (replica set) + Redis + observabilité complète (Prometheus, Grafana, Alertmanager, Graylog, Jaeger, OTel, MinIO) |
| `docker-compose.prod.yml` | **Production** | Copie fidèle de `docker-compose.yml`, utilisée par le job `deploy_production` |

> **Historique résolu (vérifié en se connectant en lecture seule au serveur de production le 29/08/2026)** : `docker-compose.prod.yml` n'existait ni dans le dépôt, ni sur le serveur — le job `deploy_production` de `deploy.yml` n'a donc **jamais fonctionné**. La production tournait en réalité depuis le début via `docker-compose.yml` lancé manuellement sur le serveur (commit `7b60794`, merge PR #90, 16 février 2026), avec les ports réels définis dans le `.env` du serveur. `docker-compose.prod.yml` a été créé comme copie fidèle de `docker-compose.yml` — comportement identique à ce qui tourne déjà, le pipeline automatisé devient enfin fonctionnel.
>
> **⚠️ Conséquence à traiter séparément** : la production tournant sur un commit de février, **aucune des corrections de sécurité de ce dépôt (Redis non exposé sur l'hôte, gate `npm audit`, etc.) n'est actuellement live**. Un redéploiement (staging d'abord, puis production via le workflow manuel) est nécessaire pour que ces corrections prennent effet — voir § 4.3.
>
> **⚠️ Serveur mutualisé** : ce serveur héberge plusieurs projets indépendants de Kauri sur le même hôte Docker. Toute commande `docker compose` exécutée à la racine sans `-f` explicite, ou tout `docker system prune`, risque d'affecter des conteneurs d'autres projets — toujours cibler explicitement le bon fichier compose et le bon répertoire (`/var/www/kauri/api`).

---

## 3. Variables d'environnement

### 3.1 Variables applicatives (lues par le process Node)

Documentées exhaustivement, avec explication de chacune, dans [`.env.example`](.env.example) — copiez ce fichier en `.env` à la racine. Catégories couvertes : serveur, MongoDB/Redis (+ TLS), JWT, chiffrement au repos (`VAULT_ENCRYPTION_KEY`), CORS, Swagger, MinIO, métriques, Stripe/NotchPay, Gemini, Firebase, Slack, Mailgun, compte admin de démarrage, rétention d'audit.

`src/server.ts` (`validateEnvironment()`) **refuse de démarrer** si une variable marquée `[REQUIS]` dans `.env.example` est absente, trop courte, ou contient une valeur par défaut faible connue (ex. `changeme`, `kaurisecret`). En production, des contrôles supplémentaires s'appliquent (TLS Mongo/Redis obligatoire, `SWAGGER_PASSWORD` ≥12 caractères, au moins un provider de paiement configuré).

### 3.2 Variables d'infrastructure (lues uniquement par `docker-compose*.yml`)

Ces variables ne sont **jamais** lues par le code Node — elles configurent les conteneurs annexes (base de données, observabilité). Créez un `.env` à la racine (le même fichier docker-compose le lit aussi) avec, en plus des variables applicatives ci-dessus :

```bash
# --- MongoDB (conteneur) ---
MONGODB_USER=admin
MONGODB_PASSWORD=            # requis — le conteneur refuse de démarrer sinon

# --- Redis (conteneur) ---
REDIS_PORT=6379              # port interne au réseau Docker (plus exposé sur l'hôte)

# --- MinIO (conteneur) ---
MINIO_ROOT_USER=kauriadmin
MINIO_ROOT_PASSWORD=         # requis

# --- Grafana ---
GRAFANA_PORT=3001
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=      # requis
GRAFANA_ROOT_URL=http://localhost:3001
GRAFANA_SMTP_HOST=smtp.gmail.com:587
GRAFANA_SMTP_USER=alerts@kauri-app.com
GRAFANA_SMTP_PASSWORD=
GRAFANA_SMTP_FROM=alerts@kauri-app.com
GRAFANA_ALERT_EMAIL_TO=ops@kauri-app.com
# Un webhook Slack RÉEL par canal — les valeurs par défaut du compose
# (https://hooks.slack.com/services/CHANGE/ME) sont des placeholders qui
# échouent silencieusement. Si vous ne les remplacez pas, ces alertes ne
# préviendront jamais personne — voir § 7.
GRAFANA_SLACK_WEBHOOK_CRITICAL=
GRAFANA_SLACK_WEBHOOK_WARNINGS=
GRAFANA_SLACK_WEBHOOK_FINTECH=
GRAFANA_SLACK_WEBHOOK_SECURITY=

# --- Alertmanager ---
ALERTMANAGER_PORT=9093
ALERTMANAGER_SMTP_HOST=smtp.gmail.com:587
ALERTMANAGER_SMTP_FROM=alerts@kauri-app.com
ALERTMANAGER_SMTP_USER=alerts@kauri-app.com
ALERTMANAGER_SMTP_PASSWORD=
ALERTMANAGER_EMAIL_TO=ops@kauri-app.com
ALERTMANAGER_FINTECH_EMAIL=fintech@kauri-app.com
ALERTMANAGER_SECURITY_EMAIL=security@kauri-app.com
ALERTMANAGER_SLACK_WEBHOOK_URL=

# --- Graylog ---
GRAYLOG_HTTP_PORT=9000
GRAYLOG_GELF_PORT=12201
# Générer : pwgen -N 1 -s 96   (96 caractères, unique par installation)
GRAYLOG_PASSWORD_SECRET=
# Générer : echo -n "votre_mot_de_passe_root" | sha256sum
GRAYLOG_ROOT_PASSWORD_SHA2=

# --- Jaeger / OpenTelemetry ---
JAEGER_PORT=16686
JAEGER_COLLECTOR_HTTP_PORT=14268
JAEGER_COLLECTOR_GRPC_PORT=14250
OTEL_PORT_GRPC=4317
OTEL_PORT_HTTP=4318
# Interface d'écoute des ports publiés (API, MinIO, Grafana, Prometheus, Jaeger, Graylog, console MinIO...).
# Apache (sur l'hôte) joint ces services via localhost : aucun n'a besoin d'être exposé sur Internet.
# 127.0.0.1 = joignable uniquement depuis l'hôte (reverse proxy / tunnel SSH). Ne pas mettre 0.0.0.0.
INTERNAL_BIND_ADDR=127.0.0.1
# OTLP/HTTP : 0.0.0.0 si l'app mobile exporte directement ses traces, sinon 127.0.0.1.
OTEL_HTTP_BIND_ADDR=0.0.0.0
# Versions épinglées (surcharger ici pour monter de version de façon contrôlée)
JAEGER_VERSION=1.76.0
OTEL_COLLECTOR_VERSION=0.162.0

# --- Prometheus ---
PROMETHEUS_PORT=9090
```

### 3.3 Secrets GitHub Actions (CI/CD — pas des variables d'environnement du serveur)

Configurés dans **Settings → Secrets and variables → Actions** du dépôt GitHub, jamais dans un fichier `.env` :

| Secret | Utilisé par | Rôle |
| :-- | :-- | :-- |
| `PROD_SERVER_IP` | `deploy.yml` | Adresse du serveur cible (staging et production) |
| `PROD_USERNAME` | `deploy.yml` | Utilisateur SSH |
| `PROD_SSH_KEY` | `deploy.yml` | **Clé privée SSH** (voir § 5.3 — remplace l'ancienne authentification par mot de passe) |
| `GITHUB_TOKEN` | `deploy.yml` | Fourni automatiquement par GitHub — pousse l'image vers GHCR et sert aussi à `docker login` **depuis le serveur** lors du déploiement (l'accès en lecture du package est nécessaire pour le `pull`) |
| `SONAR_TOKEN` | `build.yml` | Jeton d'authentification SonarQube (analyse statique de qualité/sécurité du code) |
| `SONAR_HOST_URL` | `build.yml` | URL de l'instance SonarQube (SonarCloud ou self-hosted) |

---

## 4. Démarrage rapide par environnement

### 4.1 Développement local

```bash
cp .env.example .env
# Remplir au minimum : JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, VAULT_ENCRYPTION_KEY,
# MONGODB_URI, GEMINI_API_KEY
docker compose -f docker-compose.dev.yml up --build
```
Inclut API + MongoDB + Redis + MinIO. Pas d'observabilité (Prometheus/Grafana) — volontairement léger pour coder au quotidien.

Alternative sans Docker (Node local, DB/Redis externes) :
```bash
npm install
npm run dev          # nodemon sur src/server.ts, rechargement à chaud
```

### 4.2 Staging (pré-production, observabilité complète)

```bash
cp .env.example .env
# + toutes les variables d'infrastructure du § 3.2
docker compose -f docker-compose.staging.yml up --build -d
docker compose -f docker-compose.staging.yml logs -f api
```
Le job `deploy_staging` de `deploy.yml` automatise ce déploiement à chaque push sur `main` ou `dev` (voir § 6).

### 4.3 Production

```bash
cp .env.example .env
# + toutes les variables d'infrastructure du § 3.2, avec de VRAIES valeurs
# (pas de placeholders — voir § 7 pour les webhooks d'alerte en particulier)
docker compose -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.prod.yml logs -f api
```
Le job `deploy_production` de `deploy.yml` ne se déclenche **jamais automatiquement** — uniquement via le bouton "Run workflow" de GitHub Actions avec `deploy_to: production` (garde-fou volontaire contre un déploiement accidentel).

**Redéploiement du serveur existant** : sur ce serveur, `.env` existe déjà à la racine de `/var/www/kauri/api` — pas besoin de le recréer, seulement de vérifier qu'il contient bien les nouvelles variables ajoutées récemment (`ALLOW_INSECURE_DB_TLS`, `METRICS_ALLOWED_IPS`, etc. — voir `.env.example` pour la liste à jour). Le prochain `git pull origin main && docker compose -f docker-compose.prod.yml up --build -d` fera passer la production du commit de février aux corrections de sécurité actuelles (Redis non exposé, limite JSON explicite, etc.) — recommandé de le tester d'abord via `deploy_staging` avant de déclencher `deploy_production`.

### 4.4 Vérification post-déploiement

```bash
curl https://votre-domaine/api/health
# {"status":"success","services":{"database":{"status":"connected"},"cache":{"status":"connected"}}}
```
`GET /api/health` est public et n'expose aucun détail interne — utilisez-le comme cible de health check pour votre load balancer.

---

## 5. Pipeline CI/CD (GitHub Actions)

**Depuis le 29/08/2026, un `git push` suffit — aucune action manuelle sur le serveur n'est nécessaire pour déployer.** `cd.yml` a été supprimé et fusionné dans `deploy.yml` (avoir deux workflows séparés déclenchés par le même `push` créait une course : le déploiement pouvait démarrer avant que l'image taguée ne soit prête, et le serveur reconstruisait de toute façon le code depuis les sources au lieu d'utiliser l'image construite par la CI — l'image versionnée ne servait donc jamais à rien).

### 5.1 `ci.yml` — Qualité du code (à chaque push/PR sur `main`/`dev`)
Garde-fou de qualité générale, indépendant du déploiement (tourne aussi sur les Pull Requests, pas seulement les push) :
1. **`security-audit`** — `npm audit --omit=dev --audit-level=high` (dépendances de production), échoue le build sur vulnérabilité haute/critique.
2. **`build-and-test`** — `npm run lint` (échoue sur erreur), contrôle Prettier, build et **tests Jest** sur Node 22.x et 24.x (avec MongoDB et Redis en services).

### 5.1bis `build.yml` — Analyse statique SonarQube (à chaque push sur `dev`)
Scan SonarQube (couverture, duplication, code smells, vulnérabilités), non bloquant par défaut.

### 5.2 `deploy.yml` — Pipeline de déploiement complet (le seul qui déploie)

Un push sur `dev` ou `main` déclenche automatiquement, dans l'ordre :

1. **`test`** — tests unitaires (Mongo/Redis éphémères), doit passer avant tout le reste.
2. **`build-and-push`** — calcule le tag de version au format **`yyyyMMdd.N`** (`N` = numéro de build du jour, déduit des tags Git existants pour la date du jour, incrémenté — aucun état externe requis), construit l'image Docker, la pousse sur `ghcr.io/thegoatia/djangui-api` avec ce tag **et** un tag flottant (`latest` sur `main`, `staging-latest` sur `dev`), puis crée ce même tag comme **tag Git** sur le commit — traçabilité immédiate image ↔ commit.
3. **`deploy_staging`** (uniquement si la branche est `dev`) **ou `deploy_production`** (uniquement si la branche est `main`) — se connecte en SSH, `git pull` (pour les fichiers compose/config), `docker login ghcr.io`, **`docker compose pull`** (récupère l'image exacte qui vient d'être construite et taguée — le serveur ne compile plus jamais rien lui-même), puis `up -d`.

Le déclenchement manuel (`workflow_dispatch`, bouton "Run workflow") reste disponible pour rejouer un déploiement sans nouveau commit — utile pour un rollback : passez `IMAGE_TAG=<ancien-tag>` en relançant, ou déployez directement une ancienne image avec `docker compose -f docker-compose.prod.yml pull && IMAGE_TAG=20260815.2 docker compose -f docker-compose.prod.yml up -d` en SSH si besoin d'un rollback immédiat hors pipeline.

La connexion SSH utilise **une clé privée** (`secrets.PROD_SSH_KEY`), pas un mot de passe. Pour générer et installer cette clé :

```bash
# 1. Générer une paire de clés dédiée au déploiement (sans passphrase, pour l'automatisation)
ssh-keygen -t ed25519 -C "kauri-deploy" -f deploy_key

# 2. Copier la clé PUBLIQUE sur le serveur, pour l'utilisateur PROD_USERNAME
ssh-copy-id -i deploy_key.pub <PROD_USERNAME>@<PROD_SERVER_IP>
# ou manuellement : ajouter le contenu de deploy_key.pub à
# ~/.ssh/authorized_keys sur le serveur

# 3. Dans GitHub → Settings → Secrets and variables → Actions :
#    - Créer PROD_SSH_KEY avec le contenu de deploy_key (la clé PRIVÉE)
#    - Supprimer l'ancien secret PROD_PASSWORD s'il existe encore
```

---

## 6. Bootstrap du premier compte admin

Après le tout premier déploiement, aucune interface ne permet de créer un compte administrateur (par conception — un endpoint public de création d'admin serait une faille en soi). Utilisez le script fourni, exécuté **sur le serveur** (ou en local contre la base de production, avec prudence) :

```bash
# Crée le compte s'il n'existe pas encore (email par défaut : admin@kauri.app)
ADMIN_EMAIL=vous@kauri-app.com npm run seed:admin

# Réinitialise le mot de passe d'un admin existant
ADMIN_EMAIL=vous@kauri-app.com ADMIN_PASSWORD=un_mot_de_passe_fort npm run seed:admin -- --reset-password
```
Sans `ADMIN_PASSWORD`, le script génère un mot de passe aléatoire fort et l'affiche une seule fois dans la sortie console — notez-le immédiatement, il n'est pas stocké en clair.

---

## 7. Monitoring — mise en route

1. Démarrer la stack (staging ou production, § 4) — Prometheus, Grafana, Alertmanager, Graylog et Jaeger démarrent avec l'API.
> **Accès aux interfaces d'observabilité.** Depuis cette version, Grafana, Prometheus, Alertmanager, Jaeger, Graylog, la console MinIO et les ports internes OpenTelemetry sont publiés sur `127.0.0.1` uniquement (variable `INTERNAL_BIND_ADDR`, défaut `127.0.0.1`). Passez par le reverse proxy Apache (vhost → `127.0.0.1:<port>`) ou un tunnel SSH. Le port OTLP/HTTP 4318 reste lié à `OTEL_HTTP_BIND_ADDR` (défaut `0.0.0.0`, car l'app mobile peut y exporter directement) : mettez `OTEL_HTTP_BIND_ADDR=127.0.0.1` si l'app utilise le proxy de télémétrie de l'API.

2. **Grafana** (`http://<host>:3001`, identifiants `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`) charge automatiquement le dashboard `grafana/dashboards/kauri-api.json` via le provisioning (`./grafana/provisioning`) — 121 panneaux couvrant l'intégralité des métriques exposées par `MonitoringService` (HTTP, DB, transactions, wallets, auth, KYC, fraude, webhooks, notifications, sécurité/compliance, jobs, IA, métier).
3. **Prometheus** (`http://<host>:9090`) scrape `/metrics`, protégé par whitelist IP ou jeton bearer (`METRICS_TOKEN`) — voir `.env.example`.
4. **Vérifiez impérativement que les webhooks Slack et le mot de passe SMTP sont de vraies valeurs**, pas les placeholders du compose (`https://hooks.slack.com/services/CHANGE/ME`, `changeme`). Avec un placeholder, Grafana/Alertmanager croient être configurés, tentent d'envoyer l'alerte, échouent silencieusement contre une URL invalide — **aucune alerte ne vous prévient que les alertes ne partent pas**. C'est le point le plus facile à oublier et le plus dangereux à oublier.
5. **Graylog** (`http://<host>:9000`) centralise les logs si `GRAYLOG_HOST`/`GRAYLOG_PORT` sont configurés côté application (optionnel — sans eux, les logs restent en fichiers locaux rotatifs + console).
6. **Jaeger** (`http://<host>:16686`) affiche les traces distribuées si `ENABLE_TRACING=true`.

---

## 7bis. Canaux Slack dédiés

L'application route ses notifications Slack vers 5 canaux distincts (`src/services/slackService.ts`), chacun avec son propre webhook — **la création des canaux et des webhooks se fait à la main dans Slack, ce dépôt ne peut pas le faire pour vous.** Sans configuration spécifique, tout retombe sur `SLACK_WEBHOOK_URL` (un seul canal fourre-tout) — ce qui fonctionne, mais mélange tout.

| Canal suggéré | Variable `.env` | Reçoit |
| :-- | :-- | :-- |
| `#kauri-audit` | `SLACK_WEBHOOK_AUDIT` | Actions admin à fort impact : crédit wallet manuel, changement de rôle, export DB, approbation/rejet de relance de paiement, révocation de sessions |
| `#kauri-alerts` | `SLACK_WEBHOOK_ALERT` | Erreurs système critiques : échec de sauvegarde/restauration, échec du remboursement automatique, exceptions non gérées (`CriticalAlertTransport`), fonds de tontine immobilisés |
| `#kauri-security` | `SLACK_WEBHOOK_SECURITY` | Fraude détectée (score ≥50), activité suspecte, signature de webhook Stripe/NotchPay invalide |
| `#kauri-finance` | `SLACK_WEBHOOK_FINANCE` | Réconciliation (interne + NotchPay), écarts détectés, abonnements activés/annulés, churn |
| `#kauri-transactions` | `SLACK_WEBHOOK_TRANSACTIONS` | Paiements individuels complétés, transactions de montant élevé (>500 000 XAF) |

**Procédure, pour chaque canal (répéter 5 fois) :**
1. Dans Slack : créer le canal (ex. `#kauri-audit`).
2. Aller sur https://api.slack.com/apps → votre app Slack (ou en créer une : "Create New App" → "From scratch") → **Incoming Webhooks** → activer → "Add New Webhook to Workspace" → sélectionner le canal créé à l'étape 1.
3. Copier l'URL générée (`https://hooks.slack.com/services/...`) dans la variable `.env` correspondante (tableau ci-dessus), sur le serveur, pour prod **et** staging séparément (deux workspaces/canaux différents recommandé, ou au minimum deux webhooks différents vers les mêmes canaux pour distinguer l'origine).
4. Redéployer (ou juste recréer le conteneur `api` : `docker compose -f docker-compose.prod.yml up -d --no-deps api`) pour que la nouvelle variable soit prise en compte.

**Vérification qu'une alerte arrive vraiment** — après configuration, déclenchez un test réel plutôt que de supposer que ça marche :
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"text":"✅ Test canal kauri-audit"}' \
  "$SLACK_WEBHOOK_AUDIT"
```
Répétez pour chacun des 5 webhooks. Un `ok` en réponse et un message qui apparaît dans le bon canal confirment que le routage est correct — ne faites confiance à la config que si vous l'avez vu arriver.

---

## 8. Sauvegardes & restauration

`DbBackupService` (voir aussi [RUNBOOK.md](RUNBOOK.md) § 4) sauvegarde MongoDB (`mongodump`) et le dossier `uploads/` (`tar`), chiffre et upload vers **deux destinations** (MinIO primaire + Firebase Storage secondaire pour la reprise après sinistre), avec purge automatique après 15 jours. Déclenchée par cron interne (voir `cronService.ts`) ou manuellement par un admin.

**⚠️ Non couvert par ce dépôt** : aucun test automatisé n'exerce le chemin de restauration (`restoreBackup()`). Une sauvegarde jamais restaurée n'est qu'une hypothèse — planifiez un exercice de restauration réel (sur un environnement isolé, jamais directement en production) avant de considérer les sauvegardes comme fiables.

---

## 9. Recommandations de sécurité au déploiement

1. **Proxy inverse & TLS** — **existe déjà sur le serveur actuel, mais hors de ce dépôt** : un Apache2 tournant directement sur l'hôte (pas en conteneur) fait office de reverse proxy pour tous les sous-domaines `*.kauri-app.com` (`api`, `admin`, `grafana`, `graylog`, `staging`, `storage`, `minio-staging`), avec certificats Let's Encrypt (`certbot`) et renouvellement automatique. **Ces vhosts (`/etc/apache2/sites-available/*.kauri-app.com*.conf`) ne sont pas versionnés** — un changement de config n'est ni revu, ni traçable, ni reproductible sur un nouveau serveur. À terme, envisager de les commiter (même dans un dossier séparé du dépôt applicatif) ou de migrer vers un reverse proxy conteneurisé piloté par ce dépôt.
2. **Firewall — piège vérifié sur ce serveur** : `ufw` ne protège **pas** un port publié par Docker quand `docker-proxy` (mode userland, actif ici) écoute directement sur `0.0.0.0` — les règles `ufw`/`iptables INPUT` standard sont contournées par une redirection DNAT qui s'applique avant elles. C'est exactement ce qui a permis à Redis de production d'être joignable depuis internet malgré `ufw` actif (voir incident du 29/08/2026). **Ne publiez jamais un port Docker (`ports:`) pour un service qui n'a pas besoin d'être joignable depuis l'extérieur** — utilisez `expose:` (réseau Docker interne uniquement), comme c'est désormais le cas pour Redis et MongoDB dans `docker-compose.prod.yml`. Si un port doit être public, passez par le reverse proxy Apache (point 1), jamais par une publication Docker directe.
3. **Secrets** — ce dépôt ne fournit pas d'intégration à un gestionnaire de secrets externe (Vault, AWS Secrets Manager). Les secrets vivent dans le `.env` du serveur, protégé uniquement par les permissions du système de fichiers — envisagez un vrai gestionnaire de secrets si votre menace le justifie.
4. **Conteneur API non-root** — l'image s'exécute avec l'utilisateur `node` (uid 1000). Les dossiers montés depuis l'hôte doivent lui appartenir, sinon les uploads et sauvegardes échouent : `chown -R 1000:1000 uploads backups logs` avant le premier démarrage de cette image.
5. **Variables désormais obligatoires en production** (le serveur refuse de démarrer sinon) : `REDIS_URL`, `ADMIN_URL`, `SWAGGER_USER`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MOBILE_CLIENT_API_KEY`, `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`, plus `STRIPE_WEBHOOK_SECRET` / `NOTCHPAY_WEBHOOK_SECRET` dès que la passerelle correspondante est configurée.
5bis. **Paiements sans webhook (mode actuel de la production).** `STRIPE_WEBHOOK_SECRET` et `NOTCHPAY_WEBHOOK_SECRET` ne sont plus bloquants au démarrage (simple avertissement). Tant qu'ils sont absents, les webhooks sont rejetés (400/401) et les paiements sont confirmés par **sondage actif du fournisseur** : `PaymentPollingService` interroge Stripe/NotchPay **chaque minute** pour tout paiement `pending` de moins de 48 h (puis au plus toutes les 10 min au-delà de 10 min d'âge) et le finalise via le même chemin idempotent que le webhook (aucun risque de double crédit). Délai typique de crédit : 1 à 2 minutes ; le mobile accélère en appelant `GET /payments/verify/:reference` au retour de paiement. La réconciliation 30 min (NotchPay : paiements, transferts, remboursements) reste active. Dès que les webhooks seront configurés, rien à changer : le sondage devient un filet de sécurité.
6. **Origines CORS / CSRF** — `ADMIN_URL` et `CORS_ALLOWED_ORIGINS` (liste séparée par des virgules) sont ajoutées à la liste des origines autorisées. Toute requête mutante authentifiée uniquement par cookie doit venir d'une de ces origines (sinon 403).
7. **Images non épinglées** — Jaeger et le collecteur OpenTelemetry sont épinglés (`JAEGER_VERSION`, `OTEL_COLLECTOR_VERSION`). MinIO/mc restent surchargeables via `MINIO_IMAGE` / `MINIO_MC_IMAGE` : épinglez-les sur un tag ou un digest précis dans le `.env` du serveur.
8. **`npm audit` désormais gaté en CI** (`ci.yml`) — un merge introduisant une dépendance vulnérable haute/critique échoue le build automatiquement.

---

## 10. Ce qui n'est pas dans ce dépôt

Pour être direct sur les limites de ce guide : les points suivants sont des responsabilités d'infrastructure/organisation qui ne peuvent pas être résolues par un fichier de configuration dans ce dépôt, et doivent être validés séparément avant une mise en production réelle :

- Configuration Apache/Let's Encrypt (existe et fonctionne sur le serveur actuel, mais n'est pas versionnée — voir § 9.1)
- Gestionnaire de secrets externe et rotation automatisée
- Exercice de restauration de sauvegarde testé en conditions réelles
- Tests de charge (aucun script k6/artillery fourni)
- Statut légal (licence d'établissement de monnaie électronique / partenariat bancaire selon juridiction) et programme AML/KYC opérationnel au-delà du scoring automatique déjà en place côté code
- **MongoDB de production reste publié sur l'hôte** (`0.0.0.0:15001`, protégé par mot de passe uniquement) tant que le conteneur n'a pas été recréé via `docker-compose.prod.yml` — corrigé automatiquement au premier déploiement via le nouveau pipeline CI/CD (§ 5.2), mais pas avant

## 11. Qualité, tests & SonarQube

Les contrôles ci-dessous tournent sur **chaque PR** (dont Dependabot, qui arrive sur `dev`) et, via `deploy.yml`, sur **chaque push `dev`/`main` avant build et déploiement** : rien n'est déployé si l'un échoue.

| Contrôle | Où | Bloquant |
| :-- | :-- | :-- |
| ESLint (erreurs), Prettier, `tsc --noEmit` | job `quality` | oui |
| Tests unitaires + **intégration sécurité** (`tests/integration/security.test.ts`) + **paiements** (replica set Mongo, `payments.test.ts`) | job `test` (Node 22 et 24) | oui |
| Couverture : plancher global **et** par fichier critique (`jest.config.js`, `npm run test:ci`) | job `test` | oui |
| `npm audit --omit=dev` (HIGH+) | job `security` | oui |
| Secrets (gitleaks, `.gitleaks.toml`) | job `security` | oui |
| SAST Semgrep (TypeScript/Node/Express/JWT, sévérité ERROR) | job `security` | oui |
| Image Docker construite + scan Trivy (HIGH/CRITICAL corrigeables) | job `security` | oui |
| SonarQube : analyse + **Quality Gate** (`sonar.qualitygate.wait`) | job `sonar` | oui (si secrets définis) |

**Règles d'or** : les planchers de couverture ne se baissent jamais (on les relève quand on ajoute des tests) ; chaque correctif de sécurité s'accompagne d'un test de non-régression dans `tests/integration/security.test.ts`.

### SonarQube (instance dédiée Kauri)
- Dossier serveur : `/var/www/kauri/sonarqube` (`docker-compose.yml`, `.env` 600). Conteneurs `kauri-sonarqube` et `kauri-sonarqube-db`, port `127.0.0.1:19200` (jamais exposé), image `sonarqube:26.4.0.121862-community`, plugin **Flutter/Dart** monté depuis `extensions/plugins/`.
- **Indépendante** de l'ancienne instance partagée `/var/www/sonarqube` (non modifiée).
- URL publique : `https://sonar.kauri-app.com` (vhost Apache `sonar.kauri-app.com.conf` → `127.0.0.1:19200`). **Prérequis DNS** : enregistrement A `sonar` → IP du VPS, puis `certbot --apache -d sonar.kauri-app.com`.
- Identifiants et jetons CI (un par dépôt) : `/root/kauri-sonarqube-credentials.txt` (600). À reporter dans les **secrets GitHub** de chaque dépôt : `SONAR_HOST_URL` et `SONAR_TOKEN` (jeton `ci-kauri-api` / `ci-kauri-admin` / `ci-kauri-mobile`).
- Projets : `kauri-api`, `kauri-admin`, `kauri-mobile` (Quality Gate « Sonar way »).
