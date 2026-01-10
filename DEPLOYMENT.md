# Guide de Déploiement Kauri

Ce guide explique comment déployer l'API Kauri dans divers environnements.

## 📋 Prérequis

- **Node.js** : v18 ou supérieur.
- **MongoDB** : v6.0 ou supérieur.
- **Redis** : v7.0 ou supérieur.
- **Firebase Admin SDK** : Fichier JSON des identifiants du compte de service.
- **Environnement** : Linux/Unix ou macOS (Windows supporté via WSL ou Docker).

---

## 🏗️ 1. Déploiement Docker (Recommandé)

Docker est la méthode préférée car il empaquette l'API et toutes ses dépendances.

### Étape 1 : Configuration de l'environnement
Créez un fichier `.env` à la racine à partir de `.env.example`.

### Étape 2 : Build et Lancement
Lancez la commande suivante pour construire l'image et démarrer les conteneurs (API, MongoDB, Redis) :
```bash
docker-compose up --build -d
```

### Étape 3 : Vérification
Vérifiez les logs pour vous assurer que tout fonctionne :
```bash
docker-compose logs -f app
```

---

## 🧊 2. Déploiement Manuel en Production

### Étape 1 : Préparer l'environnement
Assurez-vous que MongoDB et Redis sont installés et actifs.

### Étape 2 : Build de l'Application
```bash
npm install
npm run build
```

### Étape 3 : Gestion de Processus (avec PM2)
Nous recommandons PM2 pour maintenir l'application active.
```bash
npm install -g pm2
pm2 start dist/server.js --name kauri-api
```

---

## 🔑 3. Variables d'Environnement Critiques

| Variable | Description |
| :--- | :--- |
| `NODE_ENV` | Mettre à `production`. |
| `PORT` | Port d'écoute (défaut 3000). |
| `MONGODB_URI` | Chaîne de connexion MongoDB de production. |
| `JWT_ACCESS_SECRET` | Chaîne secrète pour les JWT. |
| `FIREBASE_PRIVATE_KEY` | Clé privée pour Firebase Admin. |

---

## 🛡️ 4. Recommandations de Sécurité

1.  **Proxy Inverse** : Utilisez toujours un proxy inverse comme **Nginx**.
2.  **SSL/TLS** : Activez HTTPS avec Let's Encrypt.
3.  **Firewall** : Limitez l'accès aux ports MongoDB et Redis au localhost uniquement.
4.  **Sauvegardes** : Configurez des sauvegardes automatiques de la base de données.

---

## 📈 5. Surveillance (Monitoring)

- Les logs sont écrits dans `combined.log` et `error.log`.
- Utilisez `GET /admin/health` pour vérifier l'état du système.
