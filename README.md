# 🏦 Kauri - Excellence en Ingénierie Financière (Fintech API)

Kauri est une API REST de pointe, conçue pour révolutionner la gestion des finances personnelles grâce à l'intelligence artificielle. Ce projet combine une architecture robuste, une observabilité totale et une intégration poussée de l'IA pour offrir une expérience financière fluide, sécurisée et intelligente.

---

## 🚀 Vision du Projet

Kauri n'est pas seulement une API de suivi de dépenses. C'est un moteur financier complet capable de :
- **Analyser** vos comportements via un Coach IA (Gemini 2.0).
- **Scanner** vos reçus physiques avec une précision chirurgicale (OCR).
- **Convertir** dynamiquement vos avoirs entre plusieurs devises.
- **Sécuriser** chaque centime via des protocoles d'idempotence et d'anti-fraude.

---

## 🏗️ Architecture & Stack Technique

Le projet repose sur une pile technologique moderne et éprouvée :

| Composant | Technologie | Rôle |
| :-- | :-- | :-- |
| **Backend** | Node.js (TypeScript) | Logique métier & API REST |
| **Base de données** | MongoDB (v7.0) | Stockage persistant & Réplication |
| **Cache & Pub/Sub** | Redis (v7.0) | Performance, Verrouillage & Rate Limiting |
| **Fichiers** | MinIO (S3 Compatible) | Stockage des reçus & Factures |
| **IA & Vision** | Google Gemini 2.0 | Coach financier & OCR |
| **Observabilité** | Prometheus / Grafana | Métriques en temps réel & Tableaux de bord |
| **Traces & Logs** | Jaeger / Graylog | Debugging distribué & Centralisation des logs |

---

## 🛠️ Installation & Guide Pratique

### 1. Prérequis
- **Docker & Docker Compose** (Recommandé)
- **Node.js v18+** (pour le développement local)
- **Clé API Gemini** (obligatoire pour les fonctions IA)
- **Firebase Admin SDK** (pour les notifications push)

### 2. Configuration (`.env`)
Copiez le fichier `.env.example` et renseignez les variables critiques :
```bash
# Sécurité
JWT_ACCESS_SECRET=votre_secret_tres_long
METRICS_TOKEN=votre_jeton_de_monitoring

# IA & Cloud
GEMINI_API_KEY=AIza...
FIREBASE_PRIVATE_KEY=votre_cle_privee

# Paiements
STRIPE_SECRET_KEY=sk_test_...
NOTCHPAY_PUBLIC_KEY=sb.pk_...
```

### 3. Lancement via Docker (Processus Standard)

Kauri propose trois modes d'exécution optimisés :

- **Mode Développement** (*Léger - 2GB RAM*) :
  ```bash
  docker-compose -f docker-compose.dev.yml up --build
  ```
  *Idéal pour coder. Inclut API, Mongo, Redis et MinIO.*

- **Mode Staging** (*Complet - Observabilité totale*) :
  ```bash
  docker-compose -f docker-compose.staging.yml up --build
  ```
  *Inclut toute la stack de monitoring pour tester en conditions réelles.*

- **Mode Production** (*Stable - Performance maximale*) :
  ```bash
  docker-compose up -d
  ```

---

## 📈 Guide de l'Observabilité (Fintech Monitoring)

Le projet intègre une plateforme de monitoring de niveau bancaire.

### Accès aux outils :
- **Prometheus** : `http://localhost:9090` (Scraping des métriques)
- **Grafana** : `http://localhost:3001` (Visualisation des Dashboards)
- **Jaeger** : `http://localhost:16686` (Traces des transactions)
- **Graylog** : `http://localhost:9000` (Analyse de logs)

### Dashboard Grafana Critique :
Le tableau de bord **"Kauri API — Production"** permet de surveiller :
- **Santé des Transactions** : Taux de succès, volumes par devise (XAF, EUR, USD).
- **Sécurité** : Alertes fraude, collisions d'idempotence, tentatives d'intrusion.
- **IA** : Latence du Coach Gemini et efficacité du scan de reçus.
- **Finance** : Réconciliation des wallets et échecs de paiements Stripe/NotchPay.

---

## 🔒 Sécurité & Maintenance

1. **Jeton de Métriques** : L'accès à `/metrics` est protégé. Générez un jeton avec `openssl rand -hex 32` et configurez-le dans `METRICS_TOKEN`.
2. **Backups** : Les données MongoDB sont persistées dans le volume `mongodb_data`. Utilisez le service de backup intégré pour des sauvegardes régulières.
3. **Idempotence** : Utilisez l'en-tête `X-Idempotency-Key` pour toutes les opérations financières critiques afin d'éviter les doubles paiements.

---

## 📖 Documentation API (Swagger)

Une fois l'application lancée, la documentation interactive est disponible sur :
👉 [http://localhost:5000/api-docs](http://localhost:5000/api-docs)

---

## 👨‍💻 Contribution
Les Pull Requests sont les bienvenues. Pour des changements majeurs, veuillez ouvrir une "Issue" pour discuter de ce que vous aimeriez changer.

---

**Auteur** : Boris Gauty  
**Licence** : [MIT](LICENSE)
