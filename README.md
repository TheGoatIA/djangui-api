# 🏦 Kauri - API de Gestion Financière Intelligente

Kauri est une API REST complète et prête pour la production destinée à la gestion des finances personnelles. Elle utilise l'IA pour fournir des analyses financières approfondies, automatiser la budgétisation et scanner les reçus physiques, créant ainsi un écosystème financier fluide.

---

## 🌟 Fonctionnalités Clés

### 1. 🛡️ Système d'Authentification Avancé
- **Accès Sécurisé** : Authentification basée sur JWT.
- **Gestion des Sessions** : Système à double jeton (Access & Refresh) pour des sessions sécurisées à long terme.
- **Protection** : Protection contre la force brute via la limitation du débit (rate limiting) et des en-têtes sécurisés (Helmet).
- **Synchronisation Appareil** : Intégration de Firebase Cloud Messaging (FCM) pour les notifications push.

### 2. 💰 Gestion Intelligente des Transactions
- **Suivi des Transactions** : CRUD complet pour les revenus et dépenses avec tags et catégories.
- **Automatisation** : Identification des transactions récurrentes (abonnements, factures).
- **Historique** : Accès paginé aux données historiques avec filtres puissants (dates, types, catégories).

### 3. 📊 Budgétisation Intelligente
- **Budgets Périodiques** : Planification budgétaire mensuelle et annuelle.
- **Allocation par Catégorie** : Contrôle granulaire des limites de dépenses par catégorie.
- **Mois Automatique** : Transition automatisée vers le mois suivant, conservant vos catégories financières.

### 4. 🎯 Objectifs d'Épargne
- **Définition d'Objectifs** : Suivi de l'épargne pour des projets spécifiques (Fonds d'urgence, Vacances, etc.).
- **Stratégies Intelligentes** : Support pour les stratégies "50-30-20", "Payez-vous d'abord", et personnalisées.
- **Suivi des Progrès** : Visualisation en temps réel de l'avancement et historique des contributions.

### 5. 🤖 Coach Financier IA (Gemini 2.0)
- **Conseils en Temps Réel** : Posez des questions spécifiques sur vos dépenses ou votre santé financière.
- **Conscient du Contexte** : Le coach analyse vos transactions récentes pour fournir des conseils personnalisés.
- **Choix du Ton** : Choisissez entre un style "encourageant", "ferme" ou "équilibré".

### 6. 📸 Scan de Reçus par IA (OCR)
- **Saisie Instantanée** : Téléchargez une photo d'un reçu et l'IA extrait automatiquement le commerçant, le montant, la catégorie et la date.
- **Précision** : Propulsé par Gemini 2.0 Flash pour une extraction de texte haute précision.

### 7. 🏆 Gamification & Défis
- **Défis Communautaires** : Rejoignez des défis prédéfinis (ex: "7 jours sans livraison").
- **Récompenses** : Gagnez des points et suivez votre progression sur un classement personnel.

### 8. 💳 Paiements Intégrés
- **Multi-Passerelles** : Support pour Stripe (International) et NotchPay (Local/Cameroun).
- **Abonnements Premium** : Gestion automatisée des statuts premium.

### 9. 🌍 Support Multi-Pays & Devises
- **Expansion Dynamique** : Kauri est conçu pour l'international, permettant la gestion des pays supportés.
- **Conversion Automatique** : Lors du changement de pays, vos soldes, transactions, budgets et objectifs sont automatiquement convertis dans la nouvelle devise.

---

## 🛣️ Guide des Endpoints API

Consultez la documentation Swagger complète à l'adresse `/api-docs` pour plus de détails.

### 🔐 Authentification (`/api/v1/auth`)
- `POST /register` : Créer un nouveau compte.
- `POST /login` : Générer les jetons JWT.
- `POST /firebase` : Authentification via Google/Firebase.
- `POST /request-country-change` : Demander un changement de pays de résidence.

### 🌍 Système (`/api/v1/system`)
- `GET /countries` : Liste des pays actifs et leurs devises.

---

## 🛠️ Installation & Configuration

### Quickstart Docker (Recommandé)
```bash
docker-compose up --build
```

### Installation Manuelle
1. Installer les dépendances : `npm install`
2. Configurer le `.env`
3. Build : `npm run build`
4. Lancer : `npm start`

---

## � Licence
Ce projet est sous licence **MIT**. Voir le fichier `LICENSE` pour plus de détails.
Développé par **Boris Gauty**.
