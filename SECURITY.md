# Kauri Security Policy & Architectural Controls

Ce document décrit l'architecture de sécurité, les politiques de protection des données, la gestion des identités et les contrôles financiers appliqués dans l'écosystème Kauri.

---

## 1. Principes Directeurs

- **Zero-Trust Client** : Aucun calcul financier, validation de solde ou prix d'abonnement n'est confié au client mobile ou web. Le serveur fait foi.
- **Transactions ACID Strictes** : Tout mouvement de fonds (dépôt, retrait, cotisation tontine, investissement) est exécuté dans une session MongoDB avec transaction atomique (`withTransaction`).
- **Protection des Secrets** : Aucun secret ou clé privée ne doit résider dans les bundles d'application mobile ou web.

---

## 2. Authentification & Gestion des Tokens

### 2.1 Modèle JWT & Refresh Tokens
- **Access Token** : Durée de vie courte (15 minutes).
- **Refresh Token** : Durée de vie configurable (7 jours), stocké sous forme hashée en Redis avec rotation automatique à chaque rafraîchissement.
- **Cookie httpOnly** : Sur le dashboard React Admin, les tokens transitent exclusivement via des cookies `httpOnly`, `Secure`, `SameSite=Strict`, inaccessibles au code JavaScript (mitigation XSS).

### 2.2 Révocation de Sessions
- L'administrateur peut révoquer toutes les sessions d'un utilisateur suspect via `DELETE /api/v1/admin/users/:id/sessions`.
- Les refresh tokens associés sont immédiatement purgés de Redis.

---

## 3. Contrôles Financiers & AML (Anti-Money Laundering)

### 3.1 Limites par Plan & Multi-Devises
| Type de Compte | Limite Transaction Unique | Limite Journalière Cumulée |
| :--- | :--- | :--- |
| **Compte Gratuit** | 50 000 FCFA (ou équivalent EUR/USD/CAD) | 100 000 FCFA / jour |
| **Compte Premium** | 50 000 FCFA (ou équivalent EUR/USD/CAD) | 300 000 FCFA / jour |

- Les conversions s'effectuent dynamiquement via `CurrencyService` selon la devise de l'utilisateur.
- Le cumul journalier comptabilise l'ensemble des débits (`withdrawal`, `expense`, `tontine_contribution`, `saving_transfer`).

### 3.2 Détection de Fraude (`FraudService`)
- Heuristiques de vélocité (fréquence de transactions dans les 10 dernières minutes).
- Détection d'écarts statistiques sur les montants de retrait.
- Blocage automatique des opérations atteignant un score de risque >= 70 et notification immédiate via Slack.

---

## 4. Sécurité Mobile (Flutter)

- **Suppression du `.env` des assets** : Les variables de compilation sont injectées via `--dart-define-from-file`.
- **Mutex de rafraîchissement (401)** : `KauriAuthenticator` utilise un `Completer` statique pour éliminer les race conditions lors du rafraîchissement concurrent de tokens.
- **Stockage Chiffré** : Utilisation de `flutter_secure_storage` (KeyStore sous Android, Keychain sous iOS) et base SQLite chiffrée via SQLite3MultipleCiphers (`sqlite3mc`).

---

## 5. Signalement de Vulnérabilités

Pour signaler une vulnérabilité de sécurité, veuillez contacter :
- **Email** : `security@kauri-app.com`
- **Chiffrement PGP** disponible sur demande.
- Délai de prise en charge : sous 24 heures ouvrées.
