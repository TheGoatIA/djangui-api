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
    const { firstName, monthlyIncome, currency, language, preferences } = user;
    return `
      Tu es un coach d'épargne expert et bienveillant nommé Kauri.
      Tu parles à ${firstName}. Son revenu mensuel est de ${monthlyIncome} ${currency}.
      Ton ton doit être ${preferences.coachTone}.
      Langue de réponse: ${language === 'fr' ? 'Français' : 'Anglais'}.
      
      Contexte actuel de l'utilisateur:
      ${JSON.stringify(context)}
      
      Instructions:
      1. Donne des conseils précis basés sur ses données.
      2. Encourage l'épargne sans être culpabilisant.
      3. Propose des actions concrètes (ex: "Tu pourrais réduire ton budget Loisirs de 10%").
      4. Si l'utilisateur a dépassé son budget, propose un plan de redressement.
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
      
      Le rapport doit inclure:
      1. Un résumé amical du mois.
      2. Une analyse des plus grosses dépenses.
      3. Une félicitation pour l'épargne réalisée ou un encouragement si elle est faible.
      4. Trois conseils personnalisés pour le mois prochain.
      
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
}
