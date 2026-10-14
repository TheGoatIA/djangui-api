# Contribution à Kauri (API)

Merci de votre intérêt pour Kauri ! Ce guide décrit comment proposer un changement sur l'API.

## 🚀 Démarrer

```bash
git clone https://github.com/TheGoatIA/djangui-api.git
cd djangui-api
npm ci
cp .env.example .env     # renseigner les secrets (voir DEPLOYMENT.md)
docker compose -f docker-compose.dev.yml up -d mongo redis
npm run dev
```

Prérequis : Node.js 22 LTS, Docker 24+.

## 🌿 Branches et flux

| Branche | Rôle | Déploiement |
| :-- | :-- | :-- |
| `dev` | Intégration | Staging automatique (si la CI est verte) |
| `main` | Production | Production automatique (si la CI est verte) |
| `feature/*`, `fix/*` | Travail | Aucun — PR vers `dev` |

Les PR visent **`dev`**. `main` ne reçoit que des merges de `dev` après validation sur staging.

## 🛠️ Standards de code

- **TypeScript strict**, pas de `any` gratuit.
- **Prettier** : `npm run format` ; **ESLint** : `npm run lint` (doit passer sans erreur).
- **Commits** : Conventional Commits (`feat:`, `fix:`, `chore(deps):`, `docs:`, `test:`).
- **Règle de dépendance** : controllers → services → models ; toute mutation d'argent passe par `WalletService`/`TransactionService` dans une transaction Mongo.
- **Jamais** de secret dans le dépôt (gitleaks bloque la CI).

## 🧪 Tests et qualité

```bash
npm test          # Jest (MongoDB replica set + Redis requis)
npm run test:ci   # avec couverture et seuils (jest.config.js)
npm run lint
npx tsc --noEmit
```

- Tout correctif de bug ou de sécurité s'accompagne d'un test de non-régression (`tests/unit`, `tests/integration`).
- Les seuils de couverture ne doivent pas baisser.
- La CI exécute en plus : Semgrep, gitleaks, OSV-Scanner, Trivy (image) et SonarQube (quality gate).

## 📬 Pull Request

1. Branche depuis `dev`, changements ciblés.
2. `npm run lint && npm run test:ci` en local.
3. PR vers `dev` avec description : *quoi*, *pourquoi*, *comment tester*, impact sécurité éventuel.
4. Mettre à jour la doc concernée (README, SECURITY, DEPLOYMENT, `docs/swagger.json`, CHANGELOG).
5. Tous les contrôles CI doivent être verts avant merge.

## 🔒 Sécurité

Ne publiez pas de vulnérabilité en issue publique : voir [SECURITY.md](SECURITY.md).

## ⚖️ Licence

En contribuant, vous acceptez que vos contributions soient sous licence [MIT](LICENSE).
