/**
 * Prod et staging partagent des canaux Slack et tournent tous deux en
 * NODE_ENV=production : chaque message doit dire de quel environnement il vient.
 */
import axios from 'axios';
import { deploymentEnv, envLabel } from '../../src/utils/deploymentEnv';
import { SlackService } from '../../src/services/slackService';

jest.mock('axios');

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  jest.clearAllMocks();
});

describe('deploymentEnv', () => {
  it('APP_ENV explicite prime sur tout le reste', () => {
    process.env.APP_ENV = 'Staging';
    process.env.SERVER_URL = 'https://api.kauri-app.com';
    expect(deploymentEnv()).toBe('staging');
  });

  it('staging reconnu par SERVER_URL malgré NODE_ENV=production', () => {
    delete process.env.APP_ENV;
    process.env.NODE_ENV = 'production';
    process.env.SERVER_URL = 'https://staging.kauri-app.com';
    expect(deploymentEnv()).toBe('staging');
    expect(envLabel()).toBe('🟡 STAGING');
  });

  it('prod : NODE_ENV=production et URL de prod', () => {
    delete process.env.APP_ENV;
    process.env.NODE_ENV = 'production';
    process.env.SERVER_URL = 'https://api.kauri-app.com';
    expect(deploymentEnv()).toBe('production');
    expect(envLabel()).toBe('🟢 PROD');
  });
});

describe('SlackService : étiquette d’environnement', () => {
  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    (axios.post as jest.Mock).mockResolvedValue({});
  });

  it('message texte préfixé par l’environnement', async () => {
    process.env.APP_ENV = 'staging';
    await SlackService.sendFinance('Écart de réconciliation');
    expect(axios.post).toHaveBeenCalledWith('https://hooks.slack.com/services/T/B/x', {
      text: '*[🟡 STAGING]* Écart de réconciliation',
    });
  });

  it('message riche : bloc de contexte en tête', async () => {
    process.env.APP_ENV = 'production';
    await SlackService.sendRichNotification(
      [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }],
      false,
      'default',
    );
    const body = (axios.post as jest.Mock).mock.calls[0][1];
    expect(body.blocks[0].elements[0].text).toContain('🟢 PROD');
    expect(body.blocks).toHaveLength(2);
  });
});
