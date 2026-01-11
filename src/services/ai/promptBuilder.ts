import { IUser } from '../../types/models';

export class PromptBuilder {
  static buildCategorizationPrompt(description: string, amount: number, merchant?: string): string {
    return `
      Catégorise cette transaction financière pour un coach d'épargne.
      Description: "${description}"
      Montant: ${amount}
      Marchand: "${merchant || 'Inconnu'}"
      
      Réponds UNIQUEMENT en format JSON valide avec la structure suivante:
      {
        "category": "Nom de la catégorie (ex: Alimentation, Transport, Logement, Loisirs, Santé, Salaire, etc.)",
        "subcategory": "Nom de la sous-catégorie",
        "confidence": 0.95,
        "reasoning": "Brève explication"
      }
    `;
  }

  static buildCoachSystemPrompt(user: IUser, context: any): string {
    const { firstName, monthlyIncome, currency, language, preferences, country } = user;
    const { transactions, budget, goals, challenges } = context;

    return `
      Tu es Kauri, un coach financier expert, bienveillant et proactif. Ton objectif est d'aider ${firstName} à atteindre la liberté financière.
      
      INFOS UTILISATEUR:
      - Prénom: ${firstName}
      - Revenu mensuel: ${monthlyIncome} ${currency}
      - Pays: ${country || 'Non spécifié'}
      - Devise: ${currency}
      - Langue: ${language === 'fr' ? 'Français' : 'Anglais'}
      - Ton souhaité: ${preferences.coachTone}
      
      CONTEXTE FINANCIER:
      ${JSON.stringify({
      budget,
      activeGoals: goals?.map((g: any) => ({
        name: g.name,
        progress: `${g.progress}%`,
        remaining: g.targetAmount - g.currentAmount,
      })),
      activeChallenges: challenges?.map((c: any) => ({
        title: c.challengeId?.title,
        progress: `${c.progress}%`,
      })),
      recentTransactions: transactions?.map((t: any) => ({
        amount: t.amount,
        type: t.type,
        category: t.category,
        description: t.description,
        date: t.date,
      })),
    })}
      
      TES MISSIONS:
      1. ANALYSE : Analyse les transactions et le budget. Si le budget est dépassé ou serré, alerte l'utilisateur.
      2. OBJECTIFS : Encourage ${firstName} à progresser sur ses objectifs d'épargne (Active Goals). Cite-les par leur nom.
      3. DÉFIS : Félicite-le pour sa progression dans les défis (Active Challenges).
      4. CONSEILS : Donne des conseils concrets et localisés (prends en compte le pays: ${country} si pertinent).
      5. STYLE : Sois ${preferences.coachTone}. Ne sois jamais robotique. Utilise le "tu".
      
      Règle d'or: Toujours prioriser la bienveillance tout en restant précis sur les chiffres.
    `;
  }

  static buildInsightPrompt(user: IUser, transactions: any[]): string {
    return `
      Analyse ces transactions récentes pour ${user.firstName} et identifie des habitudes de dépenses ou des anomalies.
      Transactions: ${JSON.stringify(transactions)}
      
      Réponds en format JSON:
      {
        "patterns": ["habitudes détectées"],
        "anomalies": ["dépenses inhabituelles"],
        "healthScore": 85,
        "advice": "Conseil global"
      }
    `;
  }
  static buildNarrativeReportPrompt(user: IUser, reportData: any): string {
    return `
      En tant que coach financier Kauri, rédige un rapport mensuel narratif et motivant pour ${user.firstName}.
      Données du mois: ${JSON.stringify(reportData)}
      
      Le rapport doit être une synthèse holistique incluant:
      1. Un bilan amical : revenus, dépenses totales et taux d'épargne.
      2. Analyse Budgétaire : mentionne les catégories qui ont bien tenu et celles qui ont débordé.
      3. Progrès des Objectifs : fait un point sur les objectifs d'épargne en cours (mentionne les pourcentages de progrès).
      4. Vie de la Communauté & Challenges : félicite pour les challenges réussis ou encourage sur ceux en cours.
      5. Investissements : un mot sur la performance du portefeuille.
      6. Trois conseils stratégiques et personnalisés pour le mois prochain.
      
      Réponds en format JSON:
      {
        "title": "Titre du rapport",
        "summary": "Texte narratif du résumé",
        "topInsights": ["insight 1", "insight 2"],
        "recommendations": ["conseil 1", "conseil 2", "conseil 3"],
        "tone": "Le ton utilisé"
      }
    `;
  }

  static buildForecastPrompt(user: IUser, context: any): string {
    return `
      Tu es un expert en analyse prédictive financière pour Kauri.
      Analyse l'historique de ${user.firstName} et projette son solde bancaire sur les 30 prochains jours.
      
      DONNÉES ACTUELLES:
      - Solde actuel: ${user.walletBalance} ${user.currency}
      - Revenu mensuel: ${user.monthlyIncome} ${user.currency}
      - Historique récent et budgets: ${JSON.stringify(context)}
      
      INSTRUCTIONS:
      1. Identifie les cycles (loyer, salaires, abonnements).
      2. Projette le solde jour après jour pour les 30 prochains jours (Série temporelle).
      3. Si le solde risque de devenir négatif, ajoute une alerte.
      
      RÉPONDS UNIQUEMENT EN JSON:
      {
        "forecast": [
          {"date": "YYYY-MM-DD", "balance": 125000},
          ... (30 points)
        ],
        "insights": ["tendance détectée"],
        "criticalAlert": "Message si solde < 0 ou seuil critique" | null
      }
    `;
  }

  static buildSimulatorPrompt(user: IUser, scenario: string, context: any): string {
    return `
      Tu es le laboratoire financier "What If?" de Kauri.
      ${user.firstName} veut simuler le scénario suivant : "${scenario}"
      
      CONTEXTE FINANCIER ACTUEL:
      - Solde: ${user.walletBalance} ${user.currency}
      - Revenu: ${user.monthlyIncome} ${user.currency}
      - Épargne/Budgets: ${JSON.stringify(context)}
      
      TA MISSION:
      1. Calcule l'impact financier immédiat et à long terme (6-12 mois).
      2. Compare l'état "Aujourd'hui" vs "Si projet réalisé".
      3. Donne un avis stratégique (Faisable, Risqué, À planifier).
      
      RÉPONDS UNIQUEMENT EN JSON:
      {
        "scenarioName": "Nom court du projet",
        "immediateImpact": -150000,
        "monthlyImpact": -5000,
        "comparison": {
          "savingsRate": {"before": 20, "after": 15},
          "debtRatio": {"before": 0, "after": 10},
          "timeToRecover": "3 mois"
        },
        "analysis": "Analyse narrative détaillée",
        "recommendation": "Conseil spécifique pour réussir ce projet"
      }
    `;
  }
}
