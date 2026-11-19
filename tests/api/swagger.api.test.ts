/**
 * Swagger en page blanche (prod, nov. 2026) : setup() n'était appelé qu'à la
 * requête, dans la copie PM2 qui servait la page ; swagger-ui-init.js servi par
 * une autre copie arrivait vide. Tout est désormais préparé au démarrage.
 */
import request from 'supertest';
import { useTestDB } from '../helpers/db';
import app from '../../src/app';

const USER = 'docs-test';
const PASSWORD = 'docs-test-password-123';

describe('documentation Swagger', () => {
  useTestDB();
  const env = { ...process.env };
  beforeAll(() => {
    process.env.SWAGGER_USER = USER;
    process.env.SWAGGER_PASSWORD = PASSWORD;
  });
  afterAll(() => {
    process.env = env;
  });

  it('swagger-ui-init.js n’est jamais vide et pointe vers /api-docs/json', async () => {
    // Aucune visite préalable de /api-docs/ : c'est le cas d'une autre copie PM2.
    const r = await request(app).get('/api-docs/swagger-ui-init.js').auth(USER, PASSWORD);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(100);
    expect(r.text).toContain('/api-docs/json');
  });

  it('la page charge l’interface', async () => {
    const r = await request(app).get('/api-docs/').auth(USER, PASSWORD);
    expect(r.status).toBe(200);
    expect(r.text).toContain('swagger-ui-init.js');
  });

  it('sans identifiants : 401', async () => {
    expect((await request(app).get('/api-docs/swagger-ui-init.js')).status).toBe(401);
  });
});
