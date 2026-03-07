# 🏆 Documentation Complète API Tontine - Kauri v3.0

Cette documentation détaille chaque endpoint de l'API Tontine avec les schémas de requête et de réponse pour faciliter l'intégration mobile.

---

## 📌 Informations Générales
* **Base URL** : `/api/v1/tontines`
* **Authentification** : `Authorization: Bearer <token>`
* **Format** : JSON (sauf `/contribute` en multipart)

---

## 🛠️ Modèles de Données

### Tontine
```json
{
  "_id": "65d1a...",
  "name": "Club Epargne 2024",
  "creatorId": "65c1b...",
  "frequency": "weekly", // weekly | bi-weekly | monthly
  "startDate": "2024-03-01T00:00:00Z",
  "contributionAmount": 50000,
  "currency": "XAF",
  "totalParts": 10,
  "rotationMode": "fixed", // fixed | random | auction
  "validationMode": "ia_only", // ia_only | ia_plus_manual
  "status": "pending", // pending | active | completed | suspended
  "inviteCode": "KAURI-XYZ",
  "currentTurn": 1,
  "escrowDetails": [{
    "type": "mobile_money",
    "provider": "Orange Money",
    "accountNumber": "690000000",
    "accountName": "Treseau Kauri"
  }]
}
```

---

## 📡 Liste des Endpoints

### 1. Lister les tontines de l'utilisateur
* **URL** : `GET /`
* **Réponse (200)** :
```json
{
  "status": "success",
  "data": [
    {
      "_id": "65d1a...",
      "name": "Tontine Famille",
      "status": "active",
      "currentTurn": 2,
      "updatedAt": "2024-03-10T..."
    }
  ]
}
```

### 2. Créer une nouvelle tontine
* **URL** : `POST /`
* **Request** : (Voir modèle Tontine pour les champs requis)
* **Réponse (201)** : La tontine créée au format JSON.

### 3. Obtenir les détails d'une tontine (avec résumé du tour)
* **URL** : `GET /:id`
* **Réponse (200)** :
```json
{
  "status": "success",
  "data": {
    "_id": "...",
    "name": "...",
    "turnSummary": {
      "collectedAmount": 150000,
      "expectedAmount": 250000,
      "contributorsCount": 3,
      "totalMembers": 5
    }
  }
}
```

### 4. Rejoindre une tontine
* **URL** : `POST /join`
* **Request** :
```json
{
  "inviteCode": "KAURI-XYZ",
  "displayName": "Mon Pseudo",
  "parts": 1,
  "payoutDetails": {
    "type": "mobile_money",
    "provider": "MTN",
    "accountNumber": "670...",
    "accountName": "Nom Réel"
  }
}
```
* **Réponse (200)** : L'objet `TontineMember` créé.

### 5. Cotiser avec un reçu (IA OCR)
* **URL** : `POST /contribute`
* **Format** : `multipart/form-data`
* **Fields** : `tontineId` (string), `receipt` (file)
* **Réponse (201) - Succès** :
```json
{
  "status": "success",
  "message": "Cotisation validée avec succès !",
  "data": {
    "amountPaid": 50000,
    "turnIndex": 1,
    "validationStatus": "ai_validated"
  }
}
```
* **Réponse (400) - Erreur IA** :
```json
{
  "status": "fail",
  "message": "L'IA n'a pas pu lire ce reçu. Assure-toi que l'image est claire."
}
```

### 6. Messagerie du groupe
* **Lister les messages** : `GET /:id/messages`
* **Réponse** : `{"status": "success", "data": [{ "senderId": { "firstName": "...", "lastName": "..." }, "content": "Hello", "createdAt": "..." }]}`
* **Envoyer un message** : `POST /:id/messages`
* **Body** : `{"content": "Texte du message", "type": "text"}`

### 7. Gestion des membres (Créateur seulement)
* **Lister les membres** : `GET /:id/members`
* **Réponse (200)** :
```json
{
  "status": "success",
  "data": [
    {
      "userId": { "firstName": "...", "lastName": "..." },
      "displayName": "...",
      "parts": 1,
      "trustScore": 95,
      "invitationStatus": "accepted"
    }
  ]
}
```
* **Retirer un membre** : `DELETE /:id/members/:memberId`

### 8. Gouvernance (Votes)
* **Créer un vote** : `POST /:id/votes`
* **Request** : `{"question": "On accepte Paul ?", "options": ["Oui", "Non"], "durationHours": 24}`
* **Voter** : `POST /:id/votes/:voteId`
* **Request** : `{"optionIndex": 0}`

### 9. Statistiques & Rapports
* **Lister toutes les cotisations** : `GET /:id/contributions` (Historique complet des reçus)
* **Exporter en CSV** : `GET /:id/export?turn=1` (Renvoie un flux CSV téléchargeable)

### 10. Lifecycle
* **Démarrer la tontine** : `POST /:id/start` (Verrouille le groupe et lance le tour 1)
* **Status (200)** : `{"status": "success", "message": "Tontine démarrée avec succès", "data": {...}}`

---

## 🚨 Erreurs Communes
* `403` : "Les utilisateurs non-premium sont limités à une seule tontine active."
* `403` : "Les adhésions sont bloquées car le créateur doit renouveler son abonnement Premium."
* `400` : "Ce reçu a déjà été utilisé pour une autre cotisation." (Anti-fraude)
* `400` : "Montant insuffisant." (L'IA a détecté une somme inférieure à la part attendue)
