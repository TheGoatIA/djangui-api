/**
 * Environnement de DÉPLOIEMENT (prod, staging…), distinct de NODE_ENV.
 *
 * Le staging tourne volontairement avec NODE_ENV=production (cookies sécurisés,
 * contrôles de démarrage) : NODE_ENV ne permet donc pas de distinguer la prod du
 * staging dans les journaux, Slack ou les e-mails d'alerte. Ordre de résolution :
 * APP_ENV explicite, puis SERVER_URL contenant « staging », puis NODE_ENV.
 */
export const deploymentEnv = (): string => {
  const explicit = process.env.APP_ENV?.trim().toLowerCase();
  if (explicit) return explicit;
  if (/staging/i.test(process.env.SERVER_URL || '')) return 'staging';
  return process.env.NODE_ENV || 'development';
};

/** Étiquette lisible en tête des messages Slack / e-mails : « PROD », « STAGING »… */
export const envLabel = (): string => {
  const env = deploymentEnv();
  if (env === 'production' || env === 'prod') return '🟢 PROD';
  if (env === 'staging') return '🟡 STAGING';
  return `⚪ ${env.toUpperCase()}`;
};
