/**
 * Prod, nov. 2026 : IA coupée depuis l'admin (plus de crédits Gemini), mais la
 * tâche quotidienne appelait encore Gemini pour chaque utilisateur actif (76 erreurs/jour).
 */
jest.mock('../../src/services/featureFlagService', () => ({
  FeatureFlagService: { isEnabled: jest.fn() },
}));
jest.mock('../../src/services/ai/coachService', () => ({
  CoachService: { generateDailyAdvice: jest.fn() },
}));
jest.mock('../../src/models/UserActivity', () => ({
  __esModule: true,
  default: { distinct: jest.fn() },
}));

import { CronService } from '../../src/services/cronService';
import { FeatureFlagService } from '../../src/services/featureFlagService';
import { CoachService } from '../../src/services/ai/coachService';
import UserActivity from '../../src/models/UserActivity';

describe('conseils IA quotidiens', () => {
  afterEach(() => jest.clearAllMocks());

  it('ai_insights désactivé : aucun appel à l’IA ni à la base', async () => {
    (FeatureFlagService.isEnabled as jest.Mock).mockResolvedValue(false);
    await (CronService as any).sendDailyAIAdvice();
    expect(FeatureFlagService.isEnabled).toHaveBeenCalledWith('ai_insights');
    expect(UserActivity.distinct).not.toHaveBeenCalled();
    expect(CoachService.generateDailyAdvice).not.toHaveBeenCalled();
  });

  it('ai_insights activé : la tâche recherche les utilisateurs actifs', async () => {
    (FeatureFlagService.isEnabled as jest.Mock).mockResolvedValue(true);
    (UserActivity.distinct as jest.Mock).mockRejectedValue(new Error('stop'));
    await (CronService as any).sendDailyAIAdvice();
    expect(UserActivity.distinct).toHaveBeenCalled();
  });
});
