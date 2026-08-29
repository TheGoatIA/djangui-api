# Kauri API & Infrastructure — Production Runbook

Ce guide opérationnel décrit les procédures critiques de déploiement, de rotation de secrets, de sauvegarde et de diagnostic pour l'écosystème Kauri (API Node.js, Admin React, Mobile Flutter).

---

## 0. Migration de renommage des conteneurs (29/08/2026)

Le serveur de production héberge plusieurs projets indépendants. Les conteneurs Kauri utilisaient le préfixe implicite `api-*` (dérivé du nom du dossier `/var/www/kauri/api`) — un nom générique déjà source de confusion avérée avec un autre projet (`cvgenius`) par le passé. Tous les conteneurs de production ont été migrés vers le préfixe explicite **`kauri-prod-*`** (`name: kauri-prod` dans `docker-compose.prod.yml`), à l'exception d'un point :

**`api-mongodb-1` reste inchangé et continue de tourner** — ce conteneur MongoDB partagé héberge aussi la base `cvgenius` (projet distinct, hors périmètre Kauri). Un nouveau conteneur dédié `kauri-prod-mongodb-1` a été créé avec sa propre base (`kauri` + `graylog`, restaurées par `mongodump`/`mongorestore` avec `--nsInclude`, en excluant explicitly `cvgenius.*`) — vérifié après coup : chaque compteur de collection (563 utilisateurs, 727 transactions, etc.) identique à l'instant précis de la coupure. `api-mongodb-1` continue de tourner pour ne pas casser `cvgenius`, qui ne dépend plus de rien côté Kauri.

**Staging** a été entièrement migré vers **`kauri-staging-*`**, y compris son MongoDB (`kauri-staging-mongodb-1`) — pas de partage avec un autre projet côté staging, donc aucune exclusion nécessaire (restauration complète par `mongodump`/`mongorestore`, comptes vérifiés identiques : 4 utilisateurs, 12 transactions, etc.).

**Ce qui a été migré, dans l'ordre** (répété pour prod puis staging) :
1. Volumes non critiques copiés à chaud (`opensearch_data`, `graylog_data`, `grafana_data`, `prometheus_data`, `minio_data` pour staging) — zéro coupure, ancien conteneur toujours actif pendant la copie.
2. MongoDB — coupure ~60s en prod (API arrêtée, `mongodump` intégral, nouveau conteneur + restauration filtrée, vérification des compteurs, redémarrage de l'API) ; migration staging similaire, restauration complète.
3. Redis, OpenSearch, Graylog, Grafana, Prometheus, MinIO (staging), Jaeger, OTel Collector, API — recréés sous le nouveau nom, connectés au nouveau réseau `kauri-{prod,staging}_kauri-network`.
4. Coupure finale de bascule API pour pointer vers le nouveau MongoDB/Redis (~9s en prod).

**Incidents rencontrés et corrigés pendant la migration** (déjà présents avant sur les deux environnements, pas des régressions introduites) :
- `GRAYLOG_PASSWORD_SECRET` et `GRAYLOG_ROOT_PASSWORD_SHA2` étaient vides dans le `.env` de prod depuis le début (l'ancien Graylog tournait déjà en `unhealthy`) — régénérés et appliqués.
- `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` étaient absents du `.env` de staging (le conteneur MinIO démarrait par une autre voie non documentée) — réutilisé `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` (déjà fonctionnels côté applicatif) comme identifiants root.
- `JAEGER_COLLECTOR_HTTP_PORT`/`JAEGER_COLLECTOR_GRPC_PORT` n'étaient définis nulle part (repli sur les ports par défaut 14268/14250, déjà occupés par un autre projet sur ce serveur mutualisé) — nouveaux ports dédiés attribués et ajoutés au `.env` (prod : 15011/15012, staging : 16013/16014).
- La copie du volume `opensearch_data` de prod s'est révélée incompatible (erreur de codec Lucene, résidu d'une version antérieure jamais nettoyée) — un volume neuf a été utilisé à la place. **Conséquence : l'historique de recherche dans l'interface Graylog de production est reparti à zéro** ; les logs applicatifs bruts (fichiers, non concernés) et toutes les données Kauri (MongoDB) n'ont subi aucune perte. La copie côté staging s'est faite sans ce problème.
- L'image de staging utilise PM2 (`instances: 'max'`, un worker par CPU détecté par le conteneur — 12 sur ce serveur) : la première tentative de bascule limitait le conteneur à `--cpus=1.0`, ce qui affamait les 12 workers et les empêchait de terminer leur démarrage (aucun log, aucun port ouvert malgré un statut PM2 "online"). Résolu en donnant davantage de quota CPU (`--cpus=4.0`).

**Nettoyage** : tous les anciens conteneurs/volumes/images `api-*` et `staging-api-*` ont été supprimés le 29/08/2026, **à l'exception de `api-mongodb-1` et de son volume `api_mongodb_data`, volontairement conservés** — ce conteneur héberge encore la base `cvgenius` (projet distinct). Ne jamais le supprimer sans avoir vérifié au préalable que `cvgenius` n'en dépend plus.

---

## 1. Procédure de Rotation des Secrets

### 1.1 Secrets JWT (Access & Refresh)
1. Générer deux nouvelles clés 256-bit hexadécimales :
   ```bash
   openssl rand -hex 32 # pour JWT_ACCESS_SECRET
   openssl rand -hex 32 # pour JWT_REFRESH_SECRET
   ```
2. Mettre à jour les variables d'environnement sur le serveur de production / Kubernetes secrets.
3. Redémarrer les instances de l'API Node.js :
   ```bash
   pm2 reload kauri-api --update-env
   ```
4. **Impact** : Les utilisateurs existants seront déconnectés lors de l'expiration de leur refresh token et invités à se reconnecter.

### 1.2 Rotation des Clés MinIO / S3
1. Créer un nouvel utilisateur IAM ou un nouvel `AccessKey` dans la console MinIO/AWS S3.
2. Assigner les politiques restrictives (accès uniquement aux buckets `kauri-private-docs` et `kauri-public-assets`).
3. Mettre à jour `MINIO_ACCESS_KEY` et `MINIO_SECRET_KEY` dans l'environnement.
4. Supprimer l'ancienne clé après confirmation du bon fonctionnement des uploads KYC.

### 1.3 Clé de Chiffrement MongoDB (`mongodb.key`)
1. Générer une nouvelle clé pour le Replica Set MongoDB :
   ```bash
   openssl rand -base64 756 > /etc/mongodb/mongodb.key
   chmod 400 /etc/mongodb/mongodb.key
   chown mongodb:mongodb /etc/mongodb/mongodb.key
   ```
2. Appliquer la clé nœud par nœud avec un rolling restart.

### 1.4 Clé SSH de déploiement (`PROD_SSH_KEY`)
Le déploiement CI/CD (`.github/workflows/deploy.yml`) se connecte au serveur par clé SSH, pas par mot de passe. À roter en cas de suspicion de compromission, ou selon votre cadence habituelle :
1. Générer une nouvelle paire de clés dédiée :
   ```bash
   ssh-keygen -t ed25519 -C "kauri-deploy-$(date +%Y%m%d)" -f deploy_key_new
   ```
2. Ajouter la nouvelle clé **publique** sur le serveur (en plus de l'ancienne, pas à sa place — pour ne pas se couper l'accès pendant la transition) :
   ```bash
   ssh-copy-id -i deploy_key_new.pub <PROD_USERNAME>@<PROD_SERVER_IP>
   ```
3. Mettre à jour le secret GitHub `PROD_SSH_KEY` avec le contenu de `deploy_key_new` (la clé privée).
4. Déclencher un déploiement staging manuel (`workflow_dispatch`) pour valider que la nouvelle clé fonctionne.
5. Une fois confirmé, retirer l'**ancienne** clé publique de `~/.ssh/authorized_keys` sur le serveur.
6. Supprimer les fichiers de clé locaux (`deploy_key_new`, `deploy_key_new.pub`) — ils ne doivent exister nulle part après avoir été copiés dans le secret GitHub.

---

## 2. Procédure de Purge de l'Historique Git (`git filter-repo`)

Pour purger définitivement les anciens secrets ayant pu être commités dans l'historique :
```bash
# 1. Cloner une copie fraîche en mode bare
git clone --bare https://github.com/TheGoatIA/djangui-api.git djangui-api-clean
cd djangui-api-clean

# 2. Remplacer les chaînes sensibles par des placeholders
git filter-repo --replace-text <(echo 'e98f72a4c13b56d89e2104fa3b7c859d0124e6a892b1574d68e90c1f23b45a67==>REPLACED_SECRET')

# 3. Supprimer les fichiers .env de l'historique
git filter-repo --invert-paths --path .env --path mongodb.key

# 4. Forcer le push vers le remote principal
git push origin --force --all
git push origin --force --tags
```

---

## 3. Gestion des Webhooks de Paiement (Stripe & NotchPay)

### 3.1 NotchPay Webhook
- **URL** : `https://api.kauri-app.com/api/v1/webhooks/notchpay` (voir `src/routes/index.ts`)
- **Signature Header** : `x-notchpay-signature` (vérifiée dans `WebhookController.notchpayWebhook` contre les octets bruts du corps, pas le JSON re-sérialisé — voir `src/utils/cryptoUtils.ts`)
- **Événements supportés** :
  - `payment.complete` : Crédit du portefeuille / Activation Premium.
  - `transfer.complete` : Confirmation de transfert Mobile Money réussi.
  - `transfer.failed` : Remboursement automatique (montant + frais) et alerte Slack si le remboursement échoue.

### 3.2 Stripe Webhook
- **URL** : `https://api.kauri-app.com/api/v1/webhooks/stripe` (voir `src/routes/index.ts`)
- **Signature Header** : `stripe-signature`
- **Événements supportés** :
  - `checkout.session.completed` : Activation abonnement.
  - `customer.subscription.deleted` : Résiliation d'abonnement.

---

## 4. Sauvegardes & Restauration Base de Données

### 4.1 Sauvegarde manuelle
```bash
# Sauvegarde locale instantanée
curl -X GET https://api.kauri-app.com/api/v1/admin/db/backup \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

### 4.2 Restauration d'urgence
```bash
# Restauration d'un snapshot
mongorestore --uri="mongodb://localhost:27017/kauri" --gzip --archive=/path/to/backup.gz
```
Ou via l'endpoint admin (`DbBackupService.restoreBackup`), qui valide strictement le nom de fichier (whitelist regex + vérification anti path-traversal) avant d'exécuter `mongorestore --drop`.

**⚠️ Aucun exercice de restauration automatisé n'existe dans ce dépôt.** Une sauvegarde jamais restaurée n'est qu'une hypothèse — planifiez un test de restauration réel (sur un environnement isolé, jamais directement en production) à intervalle régulier, et documentez-le ici avec sa date une fois effectué.

---

## 5. Construction des Applications Mobiles (Flutter)

Ne jamais inclure de secrets dans le code Flutter. Injecter les variables non sensibles via `--dart-define-from-file` :
```bash
# Développement
flutter run --dart-define-from-file=dart_defines.dev.json

# Production Release Android (Obfuscation + R8)
flutter build appbundle \
  --dart-define-from-file=dart_defines.prod.json \
  --obfuscate \
  --split-debug-info=./build/app/outputs/symbols
```
