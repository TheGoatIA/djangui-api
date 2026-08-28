import Joi from 'joi';

// Rejette une échéance antérieure à aujourd'hui (comparaison au début de la
// journée serveur, pas à l'horodatage exact) : le sélecteur de date de l'app
// autorise "aujourd'hui" comme date la plus proche, un `Joi.date().greater('now')`
// strict rejetterait donc "aujourd'hui" dès que l'heure serveur dépasse minuit.
const notInThePast = Joi.date().custom((value: Date, helpers) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (value < startOfToday) {
    return helpers.error('date.pastDeadline');
  }
  return value;
}, 'reject past dates').messages({
  'date.pastDeadline': "L'échéance ne peut pas être dans le passé",
});

export const createGoalSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().optional().allow('', null),
  emoji: Joi.string().optional().allow('', null),
  type: Joi.string().valid('emergency', 'project', 'regular', 'challenge', 'debt').optional(),
  // > 0 : un objectif à 0 F affiche une progression de 100% dès sa création
  // (division par zéro) sans qu'aucune épargne n'ait eu lieu.
  targetAmount: Joi.number().greater(0).max(1_000_000_000_000).required(),
  // Requis : le modèle Flutter (GoalModel.deadline) est non-nullable — un
  // objectif créé sans échéance planterait au décodage JSON côté app.
  deadline: notInThePast.required(),
  priority: Joi.string().valid('high', 'medium', 'low').optional(),
  strategy: Joi.object({
    type: Joi.string()
      .valid(
        '50-30-20',
        'progressive',
        'roundup',
        'pay-yourself-first',
        'envelope',
        'custom',
        'snowball',
        'avalanche',
      )
      .optional(),
    details: Joi.any().optional(),
  }).optional(),
  autoSaveRules: Joi.object({
    enableSurplus: Joi.boolean().optional(),
    enableRoundup: Joi.boolean().optional(),
    // Borné à 0-100% : au-delà, la valeur ne représente plus un pourcentage
    // valide (le débit réel reste de toute façon plafonné par le solde du
    // wallet, mais autant rejeter une saisie qui n'a pas de sens).
    percentageIncome: Joi.number().min(0).max(100).optional(),
    // 1-28 pour garantir un déclenchement identique tous les mois (certains
    // mois n'ont pas de 29/30/31) — même borne que le sélecteur côté app.
    dayOfMonth: Joi.number().integer().min(1).max(28).optional(),
  }).optional(),
  // Allow fields sent by frontend but not used in model logic to avoid validation errors
  currency: Joi.string().optional(),
  category: Joi.any().optional().allow(null),
  image: Joi.any().optional().allow(null),
  // currentAmount/progress/status/contributions/createdAt/updatedAt/isShared are deliberately
  // NOT accepted here: a goal's real-money balance must only ever move through
  // GoalService.addContribution (which actually debits the wallet), never be set directly
  // by the client at creation — accepting currentAmount let a user fabricate a balance and
  // redeem/delete it for real wallet credit with nothing ever deposited. `isShared` is only
  // ever turned on server-side by GoalService.shareGoal, once an inviteCode exists.
});

export const updateGoalSchema = Joi.object({
  name: Joi.string().optional(),
  description: Joi.string().optional().allow('', null),
  emoji: Joi.string().optional().allow('', null),
  type: Joi.string().valid('emergency', 'project', 'regular', 'challenge', 'debt').optional(),
  targetAmount: Joi.number().greater(0).max(1_000_000_000_000).optional(),
  deadline: notInThePast.optional(),
  priority: Joi.string().valid('high', 'medium', 'low').optional(),
  status: Joi.string().valid('active', 'completed', 'cancelled', 'paused').optional(),
});

export const joinGoalSchema = Joi.object({
  inviteCode: Joi.string().trim().min(6).max(32).required(),
});
