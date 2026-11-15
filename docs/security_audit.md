> **⚠️ Document obsolète (2026-08-10).** Ce rapport initial est conservé à titre historique mais ne reflète plus l'état réel du système. Pour la politique de sécurité actuelle, l'audit applicatif complet du 29 août 2026 et son suivi de correction, voir **[../SECURITY.md](../SECURITY.md)**. Pour le détail des correctifs côté application mobile (Flutter), voir `SECURITY_CHECKLIST.md` dans le dépôt `djangui-mobile` (dépôt séparé).

# Security Audit Report - Kauri API (historique)

## 1. Authentication & Authorization
- **JWT Protection**: Implemented robust token verification with `jsonwebtoken`.
- **Token Freshness**: Access and Refresh tokens used to mitigate session hijacking.
- **State Check**: Every protected request verifies if the user still exists and is `isActive`.
- **Secure Hashing**: User passwords are saved using `bcrypt` with a salt factor of 12.

## 2. Infrastructure Security
- **Security Headers**: `helmet` is configured to set secure HTTP headers (XSS protection, sniffing prevention, etc.).
- **Rate Limiting**: `express-rate-limit` prevents brute-force attacks on auth endpoints and DoS attacks by limiting requests to 100 per 15-minute window per IP.
- **CORS**: Enabled to control cross-origin requests. (Should be restricted to specific domains in production).
- **Data Compression**: `compression` implemented to optimize performance and reduce bandwidth exposure.

## 3. Data Integrity
- **Request Validation**: `Joi` is used for strict schema validation on all incoming data.
- **Input Sanitization**: Mongoose's built-in protection and Joi validation prevent NoSQL injection.
- **File Upload Security**: `multer` configuration includes strict file type filtering (Images/PDF only) and size limits (5MB) to prevent remote code execution or storage exhaustion.

## 4. Operational Security
- **Error Handling**: Differentiated error responses. In production, stack traces are hidden, and only safe, operational messages are returned.
- **Logging**: `winston` used for structured logging. Sensitive data (passwords, private keys) are excluded from logs.

## 5. Third-Party Integrations
- **Stripe/NotchPay**: Webhook signatures are strictly verified using raw request bodies to prevent spoofing.
- **AI Integration**: API keys for Gemini are handled via environment variables and never exposed to the frontend.

## 6. Recommendations
- Implement a Content Security Policy (CSP) if serving frontend from the same server.
- Ensure SSL/TLS is used in production (HTTPS).
- Rotate JWT secrets periodically.
