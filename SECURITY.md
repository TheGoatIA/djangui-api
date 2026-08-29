# Kauri Security Policy & Architectural Controls

Ce document décrit l'architecture de sécurité, les politiques de protection des données, la gestion des identités et les contrôles financiers appliqués dans l'écosystème Kauri. Dernière revue de fond : **29 août 2026** (audit applicatif complet — méthode et résultats en § 8).

---

## 1. Principes Directeurs

- **Zero-Trust Client** : Aucun calcul financier, validation de solde ou prix d'abonnement n'est confié au client mobile ou web. Le serveur fait foi.
- **Transactions ACID Strictes** : Tout mouvement de fonds (dépôt, retrait, cotisation tontine, dépôt de défi) est exécuté dans une session MongoDB avec transaction atomique (`WalletService.runInTransaction`). Voir [ARCHITECTURE.md](ARCHITECTURE.md) § 4.
- **Idempotence des paiements** : Les routes financières acceptent un header `Idempotency-Key`, réclamé atomiquement via Redis `SET NX` — élimine la fenêtre de course d'un lecture-puis-écriture classique.
- **Protection des Secrets** : Aucun secret ou clé privée ne doit résider dans les bundles d'application mobile ou web, ni dans l'historique Git (vérifié : `.env` n'a jamais été commité, seuls des `.env.example` le sont).

---

## 2. Authentification & Gestion des Tokens

### 2.1 Modèle JWT & Refresh Tokens
- **Algorithme épinglé explicitement** (`algorithms: ['HS256']`) à la vérification — empêche une attaque par confusion d'algorithme si une clé asymétrique était un jour introduite ailleurs dans le code avec le même secret.
- **Access Token** : durée de vie courte (15 minutes par défaut, `JWT_ACCESS_EXPIRATION`).
- **Refresh Token** : durée de vie configurable (7 jours par défaut, `JWT_REFRESH_EXPIRATION`), stocké sous forme hashée en base, rotation automatique à chaque rafraîchissement.
- **Secret validé au démarrage** : `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` doivent faire ≥32 caractères et ne pas correspondre à une liste de valeurs par défaut faibles connues — le serveur refuse de démarrer sinon.
- **Cookie httpOnly** : sur le dashboard React Admin, les tokens transitent exclusivement via des cookies `httpOnly`, `Secure`, `SameSite=Strict`, inaccessibles au code JavaScript (mitigation XSS).

### 2.2 Révocation de Sessions
- Liste noire Redis au logout : le token d'accès est blacklisté avec un TTL égal à sa durée de vie résiduelle — impossible à réutiliser même s'il n'a pas encore expiré.
- L'administrateur peut révoquer toutes les sessions d'un utilisateur suspect via `DELETE /api/v1/admin/users/:id/sessions` (action journalée de façon synchrone, § 5).

### 2.3 Authentification à deux facteurs (MFA / TOTP)
- Obligatoire de facto pour les rôles `admin` et `support` dès qu'activé sur le compte : un challenge TOTP à deux étapes précède l'émission de la session complète (jeton de challenge à portée strictement limitée — `purpose: '2fa_challenge'`, durée de vie 2 minutes, secret HMAC dérivé du secret JWT).
- Codes de secours hashés en base (bcrypt), jamais stockés en clair.

### 2.4 Brute force
- Rate limiter dédié sur `/auth/login` (10 tentatives / 15 min par IP).
- Verrouillage de compte progressif après échecs répétés, indépendant du rate limiting par IP (protège contre le password spraying distribué).

---

## 3. Sécurité API (OWASP API Top 10)

| Risque | Contrôle en place |
| :-- | :-- |
| **BOLA / IDOR** | Vérification d'appartenance systématique avant tout accès à une ressource (ex. `assertIsMember` avant lecture d'une tontine) — pas de `findById` non gardé sur un endpoint utilisateur. |
| **Mass Assignment** | Aucun pattern `...req.body` dans le code ; chaque contrôleur whiteliste explicitement les champs mutables. |
| **Excessive Data Exposure** | Mot de passe, secret TOTP et codes de secours en `select: false` par défaut au niveau schéma Mongoose. |
| **Rate Limiting** | Limiteur global (Redis) + limiteurs dédiés par route sensible (login, refresh token, TOTP, OCR, auto-budget IA, upload, jointure tontine), avec métrique Prometheus sur chaque blocage. |
| **Broken Function Level Authorization** | `restrictTo(...roles)` sur toutes les routes admin ; filtres de requête admin passés par une whitelist d'opérateurs Mongo (`$gte,$gt,$lte,$lt,$ne,$in`) pour empêcher l'injection de `$where`/`$expr` via une clé de query-string. |
| **Injection (NoSQL/commande)** | Aucune concaténation de string dans une requête Mongo ; toute opération shell (sauvegarde/restauration DB) utilise `execFile` (arguments jamais interpolés dans un shell), jamais `exec`. |
| **SSRF** | Aucun appel sortant construit à partir d'une URL fournie par l'utilisateur. |

---

## 4. Contrôles Financiers & AML (Anti-Money Laundering)

### 4.1 Limites par Plan & Multi-Devises
| Type de Compte | Limite Transaction Unique | Limite Journalière Cumulée |
| :--- | :--- | :--- |
| **Compte Gratuit** | 50 000 FCFA (ou équivalent EUR/USD/CAD) | 100 000 FCFA / jour |
| **Compte Premium** | 50 000 FCFA (ou équivalent EUR/USD/CAD) | 300 000 FCFA / jour |

- Les conversions s'effectuent dynamiquement via `CurrencyService` selon la devise de l'utilisateur.
- Le cumul journalier comptabilise l'ensemble des débits (`withdrawal`, `expense`, `tontine_contribution`, `saving_transfer`).

### 4.2 Détection de Fraude (`FraudService`)
Score heuristique évalué à chaque dépôt/retrait :
- Vélocité (>5 transactions dans les 10 dernières minutes) — +35 points.
- Retraits consécutifs rapprochés (>3 en 1h) — +25 points.
- Montant atypique (>5x la moyenne historique de retrait de l'utilisateur, >100 000 FCFA) — +30 points.
- Dépôts consécutifs rapprochés (>5 tentatives en 1h — signal classique de card-testing) — +25 points.
- **Score ≥70** : blocage automatique de l'opération + alerte Slack immédiate (bloquante). **Score 50-69** : signalé (non bloqué) + alerte Slack non-critique.
- Chaque règle déclenchée est exposée en métrique Prometheus (`fraud_alerts_total`, `suspicious_activity_total`) — visible dans le dashboard Grafana.

### 4.3 Webhooks de paiement (Stripe & NotchPay)
- Signature vérifiée sur les **octets bruts exacts** capturés avant le parsing JSON (une re-sérialisation de `req.body` ne matcherait pas forcément bit à bit et rejetterait de vrais webhooks légitimes).
- Transition d'état atomique sur échec de transfert (`findOneAndUpdate` avec garde `status: { $ne: 'failed' }`) — une livraison dupliquée du même webhook ne peut pas déclencher un double remboursement.

---

## 5. Journalisation & Audit Trail

- **`AuditService.recordSync()`** (attendu avant réponse au client) pour toute action à fort impact financier ou de sécurité : crédit manuel de wallet par un admin, changement de rôle utilisateur, approbation/rejet de relance de paiement, révocation de sessions, export de base de données.
- **`AuditService.record()`** (fire-and-forget) pour les événements à faible enjeu (export de rapport, mise à jour de paramètres non-critiques).
- Rétention : 5 ans par défaut (`AUDIT_LOG_RETENTION_DAYS`), alignée sur les obligations AML/KYC typiques.
- Logs applicatifs : PII et champs sensibles assainis avant écriture (`requestLogger.ts`), corps de requête loggé uniquement en développement. Erreurs critiques routées vers Slack avec repli email si Slack échoue, et masquage automatique des secrets dans le message d'alerte.

---

## 6. Chiffrement & Stockage

- **Au repos** : AES-256-GCM authentifié (`VaultCrypto`), IV aléatoire par valeur chiffrée, clé dérivée par scrypt depuis `VAULT_ENCRYPTION_KEY` (≥32 caractères, requis au démarrage).
- **Documents KYC** (pièce d'identité, selfie) : stockage MinIO privé, jamais accessible par une URL anonyme — uniquement via URL signée à courte durée de vie (300s) pour l'examen admin, ou téléchargement authentifié côté serveur pour l'analyse IA.
- **Sauvegardes base de données** : chiffrées, uploadées en `private` sur deux destinations indépendantes (MinIO primaire + Firebase Storage secondaire).
- **Mots de passe** : bcrypt, coût 12. Codes de secours TOTP : bcrypt, coût 10.

---

## 7. Sécurité HTTP & Infrastructure applicative

- **Helmet** avec CSP stricte, nonce par requête (pas de `unsafe-inline` sur `script-src`), `frame-ancestors: none`.
- **CORS** restreint à une liste blanche d'origines explicites en production (jamais de wildcard `*`).
- **Body size limit** explicite (`express.json({ limit: '100kb' })`).
- **`/metrics`** protégé par whitelist IP ou jeton bearer (`METRICS_TOKEN`) — bloqué par défaut en production si ni l'un ni l'autre n'est configuré.
- **Gestion d'erreurs** : stack traces jamais renvoyées en production ; erreurs Mongo (CastError, clé dupliquée) normalisées pour ne jamais fuiter le schéma interne.
- **Supply chain** : `npm audit --audit-level=high` gaté en CI (`ci.yml`) — un merge introduisant une dépendance vulnérable haute/critique échoue le build.

---

## 8. Sécurité Mobile (Flutter)

- **Suppression du `.env` des assets** : les variables de compilation sont injectées via `--dart-define-from-file`, jamais embarquées dans le bundle.
- **Mutex de rafraîchissement (401)** : `KauriAuthenticator` utilise un `Completer` statique pour éliminer les race conditions lors du rafraîchissement concurrent de tokens.
- **Stockage chiffré** : `flutter_secure_storage` (KeyStore sous Android, Keychain sous iOS) et base SQLite chiffrée via SQLite3MultipleCiphers (`sqlite3mc`).

---

## 9. Audit de sécurité — méthode et état actuel

Un audit applicatif complet (authentification, OWASP API Top 10, logique financière, base de données, secrets, HTTP/infra, dépendances, logging/monitoring, gestion d'erreurs, conformité) a été réalisé le 29 août 2026 par lecture directe du code source (pas d'extrait collé — accès complet au dépôt, exécution réelle de `npm audit` et de la suite de tests).

**Résultat** : 0 vulnérabilité critique ou élevée dans le code applicatif. Cinq constats de sévérité moyenne/faible identifiés, **tous corrigés depuis** :

| Constat | Correction appliquée |
| :-- | :-- |
| Pas de scan de dépendances en CI | Job `security-audit` ajouté à `ci.yml` (`npm audit --audit-level=high`) |
| Import `exec` mort et dangereux dans `adminController.ts` | Import supprimé |
| Redis exposé sur l'hôte Docker | Passé en `expose` (réseau interne uniquement), aligné sur MongoDB |
| Déploiement SSH par mot de passe | Migré vers authentification par clé (`PROD_SSH_KEY`) |
| Limite de payload JSON implicite | Déclarée explicitement (`limit: '100kb'`) |

**Non corrigé, hors périmètre du code** : absence d'endpoint self-service de suppression/anonymisation de compte (RGPD Art. 17) — nécessite une décision produit sur la politique de rétention avant implémentation. Terminaison TLS, gestionnaire de secrets externe, exercice de restauration de sauvegarde testé, et tests de charge sont également hors du périmètre de ce dépôt — voir [DEPLOYMENT.md](DEPLOYMENT.md) § 10.

---

## 10. Signalement de Vulnérabilités

Pour signaler une vulnérabilité de sécurité, veuillez contacter :
- **Email** : `security@kauri-app.com`
- **Chiffrement PGP** disponible sur demande.
- Délai de prise en charge : sous 24 heures ouvrées.
