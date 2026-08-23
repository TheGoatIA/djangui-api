# Kauri API & Infrastructure — Production Runbook

Ce guide opérationnel décrit les procédures critiques de déploiement, de rotation de secrets, de sauvegarde et de diagnostic pour l'écosystème Kauri (API Node.js, Admin React, Mobile Flutter).

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
- **URL** : `https://api.kauri-app.com/api/v1/payments/webhook/notchpay`
- **Signature Header** : `x-notch-signature`
- **Événements supportés** :
  - `payment.complete` : Crédit du portefeuille / Activation Premium.
  - `transfer.complete` : Confirmation de transfert Mobile Money réussi.
  - `transfer.failed` : Remboursement automatique et notification.

### 3.2 Stripe Webhook
- **URL** : `https://api.kauri-app.com/api/v1/payments/webhook/stripe`
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
