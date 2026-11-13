/**
 * Localisation des messages d'erreur renvoyés aux clients (app mobile, admin).
 *
 * Constat des tests E2E mobiles : l'app (en français) affichait tels quels des
 * messages d'API en anglais (« Incorrect email or password », « Email already
 * in use », messages Joi `"type" must be one of [...]`…) — environ la moitié des
 * erreurs du code étaient en anglais, l'autre en français.
 *
 * Plutôt que de réécrire 200 `throw`, la traduction est faite UNE fois, à la
 * sortie (middleware `localizeErrors`), dans la langue de l'utilisateur :
 *   req.user.language → en-tête Accept-Language → français (langue par défaut).
 * Un message inconnu est renvoyé inchangé.
 */
type Lang = 'fr' | 'en';
type Pair = { fr: string; en: string };

// Messages exacts (la clé est le message tel qu'écrit dans le code, sans tenir
// compte de la casse ni de la ponctuation finale).
const EXACT: Pair[] = [
  { en: 'Incorrect email or password', fr: 'E-mail ou mot de passe incorrect.' },
  {
    en: 'Please provide email and password',
    fr: 'Veuillez saisir votre e-mail et votre mot de passe.',
  },
  { en: 'Email already in use', fr: 'Cette adresse e-mail est déjà utilisée.' },
  { en: 'Email is required', fr: "L'adresse e-mail est requise." },
  { en: 'Current password is incorrect', fr: 'Le mot de passe actuel est incorrect.' },
  { en: 'User not found', fr: 'Utilisateur introuvable.' },
  { en: 'No user found with that ID', fr: 'Utilisateur introuvable.' },
  { en: 'User no longer exists', fr: "Ce compte n'existe plus." },
  { en: 'The user belonging to this token no longer exists', fr: "Ce compte n'existe plus." },
  { en: 'This user account is deactivated', fr: 'Ce compte est désactivé.' },
  {
    en: 'You are not logged in! Please log in to get access',
    fr: 'Vous devez être connecté pour continuer.',
  },
  { en: 'Authentication required', fr: 'Authentification requise.' },
  {
    en: 'Token is invalid or has expired',
    fr: 'Votre session a expiré. Veuillez vous reconnecter.',
  },
  {
    en: 'Invalid token or expired. Please log in again',
    fr: 'Votre session a expiré. Veuillez vous reconnecter.',
  },
  {
    en: 'Token has been revoked. Please log in again',
    fr: 'Votre session a été fermée. Veuillez vous reconnecter.',
  },
  {
    en: 'Session expired. Please log in again',
    fr: 'Votre session a expiré. Veuillez vous reconnecter.',
  },
  {
    en: 'Invalid or expired refresh token',
    fr: 'Votre session a expiré. Veuillez vous reconnecter.',
  },
  { en: 'Refresh token is required', fr: 'Votre session a expiré. Veuillez vous reconnecter.' },
  { en: 'Session not found', fr: 'Session introuvable.' },
  { en: 'Session ID is required', fr: 'Session introuvable.' },
  {
    en: 'You do not have permission to perform this action',
    fr: "Vous n'avez pas l'autorisation d'effectuer cette action.",
  },
  { en: 'Access denied', fr: 'Accès refusé.' },
  { en: 'Forbidden', fr: 'Accès refusé.' },
  {
    en: 'This is a premium feature. Please upgrade your plan to access it',
    fr: 'Fonctionnalité Premium : passez à une offre supérieure pour y accéder.',
  },
  {
    en: 'This is a premium feature',
    fr: 'Fonctionnalité Premium : passez à une offre supérieure pour y accéder.',
  },
  {
    en: 'No active premium subscription to cancel',
    fr: "Vous n'avez pas d'abonnement Premium actif à annuler.",
  },
  { en: 'Goal not found', fr: 'Objectif introuvable.' },
  { en: 'Budget not found', fr: 'Budget introuvable.' },
  { en: 'No budget found with that ID', fr: 'Budget introuvable.' },
  { en: 'Budget for this period already exists', fr: 'Un budget existe déjà pour cette période.' },
  { en: 'Transaction not found', fr: 'Transaction introuvable.' },
  { en: 'Investment not found', fr: 'Investissement introuvable.' },
  { en: 'Investment is already closed', fr: 'Cet investissement est déjà clôturé.' },
  { en: 'Payment not found', fr: 'Paiement introuvable.' },
  { en: 'Ticket not found', fr: 'Ticket introuvable.' },
  { en: 'Request not found', fr: 'Demande introuvable.' },
  { en: 'Request already processed', fr: 'Cette demande a déjà été traitée.' },
  { en: 'You already have a pending request', fr: 'Vous avez déjà une demande en attente.' },
  { en: 'No tontine found with that ID', fr: 'Tontine introuvable.' },
  { en: 'No subscription found with that ID', fr: 'Abonnement introuvable.' },
  { en: 'No notification found with that ID', fr: 'Notification introuvable.' },
  { en: 'No challenge found with that ID', fr: 'Défi introuvable.' },
  { en: 'Feature flag not found', fr: 'Fonctionnalité introuvable.' },
  { en: 'Country not found', fr: 'Pays introuvable.' },
  { en: 'Country code is required', fr: 'Le pays est requis.' },
  { en: 'Selected country is not supported', fr: "Ce pays n'est pas encore pris en charge." },
  { en: 'Target country not found or inactive', fr: "Ce pays n'est pas disponible." },
  {
    en: 'This phone number is already associated with another account',
    fr: 'Ce numéro de téléphone est déjà associé à un autre compte.',
  },
  {
    en: 'NotchPay is only available for users in Cameroon',
    fr: 'Le paiement Mobile Money est réservé aux utilisateurs au Cameroun.',
  },
  {
    en: 'Failed to verify payment with provider',
    fr: 'Impossible de vérifier le paiement auprès du prestataire. Réessayez dans un instant.',
  },
  {
    en: 'Duplicate request: this operation was already submitted',
    fr: 'Cette opération a déjà été envoyée.',
  },
  {
    en: 'AI Chat Service currently unavailable',
    fr: "L'assistant est momentanément indisponible. Réessayez plus tard.",
  },
  {
    en: 'AI Service currently unavailable',
    fr: "Le service d'IA est momentanément indisponible. Réessayez plus tard.",
  },
  { en: 'AI Analysis failed', fr: "L'analyse a échoué. Réessayez plus tard." },
  { en: 'Voice analysis failed', fr: "L'analyse vocale a échoué. Réessayez." },
  { en: 'Failed to analyze voice transaction', fr: "L'analyse vocale a échoué. Réessayez." },
  { en: 'Only audio files are accepted', fr: 'Seuls les fichiers audio sont acceptés.' },
  { en: 'No audio file uploaded', fr: 'Aucun fichier audio reçu.' },
  { en: 'No file uploaded', fr: 'Aucun fichier reçu.' },
  { en: 'Unsupported file format', fr: 'Format de fichier non pris en charge.' },
  { en: 'Invalid filename', fr: 'Nom de fichier invalide.' },
  { en: 'Message is required', fr: 'Le message est requis.' },
  { en: 'Invalid status', fr: 'Statut invalide.' },
  { en: 'Invalid language. Supported: fr, en', fr: 'Langue invalide (fr ou en).' },
  {
    en: 'There was an error sending the email. Try again later!',
    fr: "L'e-mail n'a pas pu être envoyé. Réessayez plus tard.",
  },
  {
    en: 'Something went very wrong!',
    fr: 'Une erreur inattendue est survenue. Réessayez plus tard.',
  },
  { en: 'Too many requests', fr: 'Trop de tentatives. Patientez quelques instants.' },
  { en: 'Invalid or expired Firebase token', fr: 'Connexion refusée : jeton invalide ou expiré.' },
  { en: 'Firebase ID token is required', fr: 'Connexion refusée : jeton manquant.' },
  {
    en: 'Token does not contain a phone number',
    fr: 'Ce jeton ne contient pas de numéro de téléphone.',
  },
  // Messages déjà en français dans le code : version anglaise pour les utilisateurs anglophones.
  { fr: 'Mot de passe incorrect', en: 'Incorrect password.' },
  { fr: 'Solde insuffisant dans le portefeuille', en: 'Insufficient wallet balance.' },
  { fr: 'Déjà voté', en: 'You have already voted.' },
  { fr: 'Un vote de clôture est déjà en cours', en: 'A closure vote is already in progress.' },
  { fr: 'Ce vote est clos', en: 'This vote is closed.' },
  { fr: 'Authentification requise', en: 'Authentication required.' },
  { fr: 'Compte introuvable', en: 'Account not found.' },
  { fr: 'Transaction introuvable', en: 'Transaction not found.' },
  { fr: 'Type de transaction invalide', en: 'Invalid transaction type.' },
  { fr: 'Montant invalide', en: 'Invalid amount.' },
  {
    fr: "Les transactions financières réelles ne peuvent pas être supprimées pour des raisons d'audit et d'intégrité",
    en: 'Real financial transactions cannot be deleted (audit and integrity).',
  },
  {
    fr: "Les transactions financières réelles ne peuvent pas être modifiées pour des raisons d'audit et d'intégrité",
    en: 'Real financial transactions cannot be edited (audit and integrity).',
  },
  {
    fr: 'Les retraits en argent réel sont actuellement désactivés (Mode Portefeuille Virtuel / Simulation)',
    en: 'Real-money withdrawals are currently disabled (virtual wallet / simulation mode).',
  },
  {
    fr: 'Une tontine en cours ne peut pas être clôturée par le seul créateur : lancez un vote de clôture auprès des membres, ou contactez le support',
    en: 'A running tontine cannot be closed by its creator alone: start a closure vote with the members, or contact support.',
  },
  {
    fr: "Seule une tontine active peut faire l'objet d'un vote de clôture",
    en: 'Only an active tontine can be put to a closure vote.',
  },
  { fr: 'Impossible de parser ce SMS', en: 'This SMS could not be read.' },
  { fr: 'Contenu SMS requis', en: 'SMS content is required.' },
];

// Familles de messages (validation Joi, « X not found »…).
const PATTERNS: Array<{
  re: RegExp;
  fr: (m: RegExpMatchArray) => string;
  en: (m: RegExpMatchArray) => string;
}> = [
  {
    re: /^"([^"]+)" is required$/,
    fr: (m) => `Le champ « ${m[1]} » est requis.`,
    en: (m) => `"${m[1]}" is required.`,
  },
  {
    re: /^"([^"]+)" is not allowed to be empty$/,
    fr: (m) => `Le champ « ${m[1]} » ne peut pas être vide.`,
    en: (m) => `"${m[1]}" cannot be empty.`,
  },
  {
    re: /^"([^"]+)" must be one of \[.*\]$/,
    fr: (m) => `Valeur invalide pour « ${m[1]} ».`,
    en: (m) => `Invalid value for "${m[1]}".`,
  },
  {
    re: /^"([^"]+)" must be a valid email$/,
    fr: () => 'Adresse e-mail invalide.',
    en: () => 'Invalid email address.',
  },
  {
    re: /^"([^"]+)" must be (?:a number|a valid number)$/,
    fr: (m) => `« ${m[1]} » doit être un nombre.`,
    en: (m) => `"${m[1]}" must be a number.`,
  },
  {
    re: /^"([^"]+)" must be (?:greater than|larger than or equal to) (\S+)$/,
    fr: (m) => `« ${m[1]} » doit être au moins ${m[2]}.`,
    en: (m) => `"${m[1]}" must be at least ${m[2]}.`,
  },
  {
    re: /^"([^"]+)" must be less than or equal to (\S+)$/,
    fr: (m) => `« ${m[1]} » ne doit pas dépasser ${m[2]}.`,
    en: (m) => `"${m[1]}" must not exceed ${m[2]}.`,
  },
  {
    re: /^"([^"]+)" length must be at least (\d+) characters long$/,
    fr: (m) => `« ${m[1]} » doit contenir au moins ${m[2]} caractères.`,
    en: (m) => `"${m[1]}" must be at least ${m[2]} characters long.`,
  },
  {
    re: /^"([^"]+)" (?:must be|with value) .*$/,
    fr: (m) => `Valeur invalide pour « ${m[1]} ».`,
    en: (m) => `Invalid value for "${m[1]}".`,
  },
  {
    re: /^"([^"]+)" is not allowed$/,
    fr: (m) => `Le champ « ${m[1]} » n'est pas autorisé.`,
    en: (m) => `"${m[1]}" is not allowed.`,
  },
  {
    re: /^([A-Z][a-zA-Z ]+) not found$/,
    fr: () => 'Élément introuvable.',
    en: (m) => `${m[1]} not found.`,
  },
];

const norm = (s: string) =>
  s
    .trim()
    .replace(/[.!\s]+$/, '')
    .toLowerCase();
const BY_EN = new Map(EXACT.map((p) => [norm(p.en), p]));
const BY_FR = new Map(EXACT.map((p) => [norm(p.fr), p]));

/**
 * Langue d'une RÉPONSE affichée par un client : celle que le client demande
 * (Accept-Language = langue de l'interface de l'app), sinon celle du profil,
 * sinon le français. La langue du profil reste celle des e-mails / notifications
 * push (envoyés hors requête). Avant, le profil primait : une app passée en
 * anglais recevait encore des contenus en français tant que le profil n'était
 * pas synchronisé (constaté en E2E).
 */
export function pickLanguage(userLanguage?: string, acceptLanguage?: string): Lang {
  const header = (acceptLanguage || '').trim().toLowerCase();
  const cand = (header || userLanguage || 'fr').toLowerCase();
  return cand.startsWith('en') ? 'en' : 'fr';
}

/** Traduit UN message (ou une liste « a, b » issue de Joi/Mongoose). */
export function localizeMessage(message: string, lang: Lang): string {
  if (!message || typeof message !== 'string') return message;
  const one = (m: string): string => {
    const key = norm(m);
    const pair = BY_EN.get(key) || BY_FR.get(key);
    if (pair) return pair[lang];
    for (const p of PATTERNS) {
      const match = m.trim().match(p.re);
      if (match) return p[lang](match);
    }
    return m;
  };
  // Joi (abortEarly:false) concatène : '"a" is required, "b" must be ...'
  if (/^"[^"]+" .+, "[^"]+" /.test(message)) {
    return message
      .split(/,\s(?=")/)
      .map(one)
      .join(' ');
  }
  return one(message);
}
