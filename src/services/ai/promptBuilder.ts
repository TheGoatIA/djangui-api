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
      Tu es un coach d'épargne expert et bienveillant nommé Djangui.
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
}
