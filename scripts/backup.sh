#!/bin/bash
# scripts/backup.sh
# Script automatisé de sauvegarde MongoDB journalière (à lier à un CRON)

# Variables environnement (par défaut ou depuis le .env)
MONGO_URI=${MONGODB_URI:-"mongodb://admin:password@localhost:27017/kauri?authSource=admin"}
BACKUP_DIR=${BACKUP_PATH:-"./backups"}
DATE=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_NAME="kauri_prod_$DATE.gz"
BACKUP_PATH_FULL="$BACKUP_DIR/$BACKUP_NAME"

echo "================================================="
echo "Démarrage de la Sauvegarde MongoDB Kauri - $DATE"
echo "================================================="

# 1. Vérifie si le dossier existe, sinon le crée
mkdir -p "$BACKUP_DIR"

# 2. Exécute mongodump
# Utilise mongodump (qui doit être installé sur la machine exécutant le script)
echo "Extraction des données (mongodump)..."
mongodump --uri="$MONGO_URI" --archive="$BACKUP_PATH_FULL" --gzip

if [ $? -eq 0 ]; then
  echo "✅ Sauvegarde réussie : $BACKUP_PATH_FULL"
else
  echo "❌ ERREUR lors de la sauvegarde MongoDB."
  # Optionnel : Envoyer une alerte Slack/Email ici
  exit 1
fi

# 3. Stratégie de rétention : Supprimer les sauvegardes de plus de 7 jours
echo "Nettoyage des archives obsolètes (> 7 jours)..."
find "$BACKUP_DIR" -type f -name "*.gz" -mtime +7 -exec rm {} \;
echo "✅ Nettoyage terminé."

# Note: Pour envoyer vers MinIO/S3 automatiquement, ajoutez :
# mc cp "$BACKUP_PATH_FULL" local/kauri-backups/
# ou
# aws s3 cp "$BACKUP_PATH_FULL" s3://votre-bucket/backups/

echo "================================================="
echo "Sauvegarde terminée."
echo "================================================="
