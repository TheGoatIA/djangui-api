# Documentation API Djangui - Spécifications Exhaustives

Cette documentation est conçue pour les développeurs et intégrateurs du projet Djangui. Elle décrit chaque point d'entrée, les structures de données, les règles de gestion et offre des exemples de requêtes et réponses pour chaque cas d'usage.

---

## 🌍 Concepts Globaux

### 1. Environnement
*   **Base URL** : `http://localhost:3000/api/v1`
*   **Format d'échange** : JSON (toujours)

### 2. En-têtes (Headers) Standards

| Header | Obligatoire | Valeur / Description |
| :--- | :--- | :--- |
| `Content-Type` | Oui (POST/PATCH) | `application/json` |
| `Accept` | Optionnel | `application/json` |
| `Authorization` | Oui (Privé) | `Bearer <JWT_TOKEN>` |
| `Accept-Language` | Optionnel | `fr` (défaut), `en` |

### 3. Structure de Réponse Standard

L'API suit une structure cohérente :
*   **Succès** : `{ "success": true, "data": { ... } }`
*   **Erreur** : `{ "success": false, "message": "Description de l'erreur" }`

---

## 🔐 1. Authentification & Sécurité

L'authentification est gérée via JWT et supporte les sessions multi-appareils ainsi que l'authentification Firebase.

### 1.1 Inscription (Register)
**POST** `/auth/register`

Crée un compte utilisateur classique.

*   **Requête (Body JSON)** :
    ```json
    {
      "email": "user@test.com",
      "password": "Password123!",
      "firstName": "Jean",
      "lastName": "Dupont",
      "country": "Cameroun",
      "currency": "XAF"
    }
    ```
*   **Logic** : Hache le mot de passe, crée l'utilisateur et génère un jeton de vérification d'email envoyé par mail.
*   **Réponse (201 Created)** :
    ```json
    {
      "success": true,
      "data": {
        "user": { "_id": "...", "email": "...", "xp": 0, "level": 1 },
        "tokens": { "accessToken": "...", "refreshToken": "..." }
      }
    }
    ```

### 1.2 Connexion (Login)
**POST** `/auth/login`

Authentifie l'utilisateur et initialise une session de suivi d'appareil.

*   **Requête (Body JSON)** :
    ```json
    {
      "email": "user@test.com",
      "password": "Password123!",
      "deviceId": "ID_UNIQUE_DEVICE",
      "deviceInfo": {
        "model": "Samsung S23",
        "os": "Android 14",
        "platform": "android"
      },
      "appVersion": "1.0.2"
    }
    ```
*   **Réponse (200 OK)** : Similaire à Register. Ajoute une entrée dans le tableau `sessions` du modèle User.

### 1.3 Authentification Firebase
**POST** `/auth/firebase-auth`

Permet la connexion via Google/Facebook/Phone via le SDK Firebase.

*   **Requête** : `{ "idToken": "FIREBASE_JWT_TOKEN" }`
*   **Logic** : Vérifie le token auprès de Google. Si l'utilisateur n'existe pas, il est créé automatiquement.

### 1.4 Rafraîchir le Jeton (Refresh Token)
**POST** `/auth/refresh`

Obtient un nouvel `accessToken` sans demander de mot de passe.

*   **Requête** : `{ "refreshToken": "..." }`
*   **Réponse** : `{ "accessToken": "...", "refreshToken": "..." }`

### 1.5 Mot de Passe Oublié
*   **POST** `/auth/forgot-password` : `{ "email": "user@test.com" }`. Réponse: `{ "success": true, "message": "Code envoyé" }`.
*   **PATCH** `/auth/reset-password/:token` : `{ "password": "..." }`. Réponse: `{ "success": true, "tokens": { "accessToken": "...", "refreshToken": "..." } }`.

### 1.6 Vérification & Liens
*   **GET** `/auth/verify-email?token=...` : Valide l'email. Réponse: `{ "success": true, "message": "Vérifié" }`.
*   **POST** `/auth/link-phone` : `{ "idToken": "..." }`. Réponse: `{ "success": true }`.

### 1.7 Mobile & Appareils (🔒 Protégé)
*   **POST** `/auth/fcm-token` : `{ "fcmToken": "..." }`. Réponse: `{ "success": true }`.
*   **PATCH** `/auth/device` : `{ "deviceId": "...", "deviceInfo": { "os": "...", "model": "..." }, "appVersion": "1.0.0" }`. Réponse: `{ "success": true }`.

### 1.8 Sécurité du Compte (🔒 Protégé)

| Méthode | Endpoint | Body | Réponse (Succès) |
| :--- | :--- | :--- | :--- |
| **PATCH** | `/auth/change-password` | `{ "currentPassword": "...", "newPassword": "..." }` | `{ "success": true, "message": "OK" }` |
| **GET** | `/auth/sessions` | N/A | `{ "success": true, "data": { "sessions": [...] } }` |
| **DELETE** | `/auth/delete-me` | N/A | `{ "success": true, "message": "Supprimé" }` |
| **POST** | `/auth/logout` | N/A | `{ "success": true, "message": "Déconnecté" }` |

---

---

## 🤵 2. Profil Utilisateur (🔒 Protégé)

### 2.1 Obtenir les informations personnelles
**GET** `/auth/me`

*   **Réponse (200 OK)** :
    ```json
    {
      "success": true,
      "data": {
        "user": {
          "email": "user@test.com",
          "firstName": "Jean",
          "walletBalance": 150000,
          "xp": 450,
          "level": 3,
          "preferences": { "language": "fr", "currency": "XAF" }
        }
      }
    }
    ```

### 2.2 Mise à jour du profil
**PATCH** `/auth/me`

*   **Corps (JSON)** : `{ "firstName": "...", "monthlyIncome": 5000 }`
*   **Réponse (200 OK)** : `{ "success": true, "data": { "user": { ... } } }`

---

## 💸 3. Finances : Transactions (🔒 Protégé)

### 3.1 Lister les transactions
**GET** `/transactions`

Récupère l'historique financier avec filtres puissants.

*   **Filtres (Query Params)** :
    *   `type` : `income` ou `expense`
    *   `category` : ex: `Alimentation`
    *   `startDate` / `endDate` : Format `YYYY-MM-DD`
    *   `page` / `limit` : Pagination
*   **Réponse (200 OK)** :
    ```json
    {
      "success": true,
      "results": 10,
      "data": [
        {
          "amount": 2500,
          "type": "expense",
          "category": "Loisirs",
          "description": "Cinéma",
          "date": "2026-01-07T..."
        }
      ]
    }
    ```

### 3.2 Créer une transaction
**POST** `/transactions`

*   **Corps (JSON)** : `{ "amount": 5000, "type": "expense", "category": "Santé" }`
*   **Réponse (201 Created)** : `{ "success": true, "data": { "transaction": { ... } } }`

### 3.3 Opérations Spécifiques
*   **GET** `/transactions/:id` : Détails d'une seule transaction.
*   **PUT** `/transactions/:id` : Modifier une transaction existante.
*   **DELETE** `/transactions/:id` : Supprimer une transaction.

### 3.4 Import & Statistiques
*   **POST** `/transactions/bulk` : Importation massive via fichier CSV/Excel (🔒 Premium).
*   **GET** `/transactions/stats` : Résumé mensuel (Revenus vs Dépenses).

---

## 📊 3.5 Rapports & Analyses (🔒 Protégé)

### 3.5.1 Dashboard & Tendances
*   **GET** `/reports/dashboard` : Vue d'ensemble pour la page d'accueil de l'app.
*   **GET** `/reports/trends` : Analyse des tendances sur plusieurs mois.

### 3.5.2 Intelligence & Export
*   **GET** `/reports/analysis` : Rapport détaillé par catégories.
*   **GET** `/reports/narrative` : Résumé textuel généré par IA (🔒 Premium).
*   **GET** `/reports/export/csv` : Exportation de toutes les données financières en CSV.

---

---

---

## 📅 4. Budgets (🔒 Protégé)

### 4.1 Liste & Création
*   **GET** `/budgets` : Récupère l'historique. Réponse: `{ "success": true, "data": { "budgets": [...] } }`.
*   **POST** `/budgets` : `{ "period": { "month": 1, "year": 2026 }, "categories": [...] }`. Réponse: `{ "success": true }`.

### 4.2 Actuel & Maintenance
*   **GET** `/budgets/current` : Réponse: `{ "success": true, "data": { "totalAllocated": 50000, "totalSpent": 12000, "categories": [...] } }`.
*   **PUT** `/budgets/:id` : `{ "categories": [...] }`. Réponse: `{ "success": true }`.
*   **DELETE** `/budgets/:id` : Réponse: `{ "success": true }`.

---

## 🎯 5. Objectifs d'Épargne (Goals) (🔒 Protégé)

### 5.1 Gestion Globale
*   **GET** `/goals` : Réponse: `{ "success": true, "data": { "goals": [...] } }`.
*   **POST** `/goals` : `{ "name": "...", "targetAmount": 1000 }`. Réponse: `{ "success": true, "data": { "goal": { ... } } }`.

### 5.2 Actions Unitaires
*   **GET** `/goals/:id` : Réponse: `{ "success": true, "data": { "goal": { ... } } }`.
*   **PUT** `/goals/:id` : `{ "targetAmount": 1200 }`. Réponse: `{ "success": true }`.
*   **DELETE** `/goals/:id` : Réponse: `{ "success": true }`.
*   **POST** `/goals/:id/contribute` : `{ "amount": 100 }`. Réponse: `{ "success": true, "data": { "newBalance": 500 } }`.

---

## 📈 6. Investissements (🔒 Premium)

### 6.1 Opérations
*   **GET** `/investments` : Réponse: `{ "success": true, "data": { "investments": [...] } }`.
*   **POST** `/investments` : `{ "title": "...", "initialAmount": 500 }`. Réponse: `{ "success": true }`.
*   **PATCH** `/investments/:id/value` : `{ "currentValue": 600 }`. Réponse: `{ "success": true }`.
*   **POST** `/investments/:id/close` : Réponse: `{ "success": true, "message": "Fermé" }`.
*   **DELETE** `/investments/:id` : Réponse: `{ "success": true }`.

---

## 🤖 7. Coach IA & Insights (🔒 Protégé)

### 7.1 Interaction avec l'IA
*   **POST** `/coach/ask` : Envoie une question. `{ "message": "..." }`.
*   **GET** `/coach/history` : Récupère l'historique complet des discussions avec le coach.

### 7.2 Insights & Analyse
**GET** `/insights/spending` : Retourne une analyse intelligente des habitudes de consommation basée sur les données réelles du mois.

---

---

## 🏆 8. Défis (Challenges) (🔒 Protégé)

## 🤖 7. Coach IA & Insights (🔒 Protégé)

### 7.1 Interaction
*   **POST** `/coach/ask` : `{ "message": "..." }`. Réponse: `{ "success": true, "data": { "answer": "..." } }`.
*   **GET** `/coach/history` : Réponse: `{ "success": true, "data": { "history": [...] } }`.

### 7.2 Analyse
*   **GET** `/insights/spending` : Réponse: `{ "success": true, "data": { "analysis": "..." } }`.

---

## 🏆 8. Défis (Challenges) (🔒 Protégé)

### 8.1 Consultation
*   **GET** `/challenges` : Liste des défis système. Réponse: `{ "success": true, "data": [...] }`.
*   **GET** `/challenges/my-challenges` : Défis rejoints. Réponse: `{ "success": true, "data": [...] }`.

### 8.2 Participation
*   **POST** `/challenges/join` : `{ "challengeId": "..." }`. Réponse: `{ "success": true }`.
*   **POST** `/challenges/validate-week` : Réponse: `{ "success": true, "message": "Semaine validée" }`.
*   **DELETE** `/challenges/:id` : Réponse: `{ "success": true, "message": "Abandonné" }`.

---

## 🔔 9. Notifications (🔒 Protégé)

*   **GET** `/notifications` : Réponse: `{ "success": true, "data": { "notifications": [...] } }`.
*   **GET** `/notifications/unread-count` : Réponse: `{ "success": true, "data": { "count": 5 } }`.
*   **PATCH** `/notifications/mark-all-read` : Réponse: `{ "success": true }`.
*   **PATCH** `/notifications/:id/read` : Réponse: `{ "success": true }`.
*   **DELETE** `/notifications/:id` : Réponse: `{ "success": true }`.

---

## 📁 10. Uploads & Médias (🔒 Protégé)

*   **POST** `/upload/avatar` : (Multipart) `{ "avatar": File }`. Réponse: `{ "success": true, "data": { "avatarUrl": "..." } }`.
*   **POST** `/upload/receipt` : (Multipart) `{ "receipt": File }`. Réponse: `{ "success": true, "data": { "imageUrl": "...", ... } }`.

---

## 🔍 11. Services de Données (SMS, OCR, Email) (🔒 Protégé)

*   **POST** `/ocr/scan` : (Multipart) `{ "receipt": File }`. Réponse: `{ "success": true, "data": { "amount": 100, ... } }`.
*   **POST** `/sms/parse` : `{ "text": "..." }`. Réponse: `{ "success": true, "data": { ... } }`.
*   **POST** `/sms/bulk-parse` : `{ "messages": [...] }`. Réponse: `{ "success": true, "count": 10 }`.
*   **POST** `/emails/send` : `{ "to": "...", "subject": "...", "body": "..." }`. Réponse: `{ "success": true }`.

---

## 💳 12. Paiements & Webhooks

### 12.1 Paiements
*   **POST** `/payments/checkout/stripe` : Réponse: `{ "success": true, "url": "STRIPE_URL" }`.
*   **POST** `/payments/init/notchpay` : Réponse: `{ "success": true, "data": { "payment_url": "..." } }`.

### 12.2 Webhooks
*   **POST** `/webhooks/stripe` : (Stripe Event). Réponse: `200 OK`.
*   **POST** `/webhooks/notchpay` : (NotchPay Event). Réponse: `200 OK`.

---

## 🛠 13. Administration (🔒 Admin seulement)

### 13.1 Statistiques & Analytics
*   **GET** `/admin/stats` : Vue globale. Réponse: `{ "status": "success", "data": { "users": { "total": 100, "active": 80, "premium": 20 }, "financials": [...], "system": { "uptime": 3600, "memoryUsage": {...} } } }`.
*   **GET** `/admin/analytics/financials` : Analyse sur 30 jours. Réponse: `{ "status": "success", "data": { "dailyVolume": [...], "categoryBreakdown": [...] } }`.

### 13.2 Gestion des Utilisateurs
*   **GET** `/admin/users?page=1&limit=10&search=...` : Liste paginée. Réponse: `{ "status": "success", "total": 100, "totalPages": 10, "data": [...] }`.
*   **PATCH** `/admin/users/:id/status` : `{ "status": "active" }` (active, inactive, banned). Réponse: `{ "status": "success", "data": { ... } }`.

### 13.3 Notifications & Communication
*   **POST** `/admin/notifications/send` : 
    *   **Body** : `{ "userIds": ["ID1"], "title": "...", "body": "...", "data": {}, "topic": "all_users" }`
    *   **Logic** : Envoie soit à une liste d'IDs, soit à un topic Firebase.
    *   **Réponse** : `{ "status": "success", "message": "Notification sent successfully..." }`.

### 13.4 Système & Maintenance
*   **GET** `/admin/health` : État vital (DB, Redis, Uptime). Réponse: `{ "status": "success", "data": { ... } }`.
*   **GET** `/admin/db/backup` : Déclenche un export. Réponse: `{ "status": "success", "message": "Backup initiated...", "path": "..." }`.
*   **GET** `/admin/logs` : Liste des fichiers `.log`. Réponse: `{ "status": "success", "logs": [...] }`.
*   **GET** `/admin/logs/:filename` : Téléchargement du fichier de log brut.

### 13.5 Paramètres Système (SystemSettings)
*   **GET** `/admin/settings` : Liste toutes les configurations. Réponse: `{ "status": "success", "settings": [...] }`.
*   **PATCH** `/admin/settings` : 
    *   **Body** : `{ "key": "maintenance_mode", "value": "true", "description": "...", "group": "system", "isPublic": true }`
    *   **Réponse** : `{ "status": "success", "data": { ... } }`.

### 13.6 Gestion des Défis & Transactions
*   **POST** `/admin/challenges` : `{ "title": "Défi Épargne", "goal": 50000, "reward": 500, ... }`.
*   **PATCH** `/admin/challenges/:id` : Mise à jour des critères.
*   **DELETE** `/admin/challenges/:id` : Suppression définitive.
*   **GET** `/admin/transactions` : Liste exhaustive de toutes les transactions du système (audit).

---

## ⚙️ 14. Système (Public)

### 14.1 Version Check
**GET** `/system/version-check?platform=android&version=1.0.0`
Réponse: `{ "success": true, "data": { "forceUpdate": false, "updateAvailable": true, "latestVersion": "1.1.0", "updateUrl": "...", "maintenanceMode": false } }`.

---

### 📝 Notes de Fin
Cette documentation est l'unique source de vérité pour l'API Djangui. Elle contient l'intégralité des endpoints avec leurs schémas de requête et de réponse.

*Fiche technique de livraison - Version Finalisée - 07 Janvier 2026.*



