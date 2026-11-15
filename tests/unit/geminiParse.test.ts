import { GeminiService } from '../../src/services/ai/geminiService';

describe('GeminiService.parseJSON (réponses IA)', () => {
  it('extrait le JSON d’un bloc markdown ```json', () => {
    const out = GeminiService.parseJSON('Voici :\n```json\n{"a": 1, "b": [2,3]}\n```\nfin');
    expect(out).toEqual({ a: 1, b: [2, 3] });
  });

  it('extrait le JSON entouré de texte libre', () => {
    expect(GeminiService.parseJSON('Réponse: {"ok": true} merci')).toEqual({ ok: true });
  });

  it('tolère du texte parasite après un objet valide', () => {
    expect(GeminiService.parseJSON('{"x":1} puis {"y":2}')).toEqual({ x: 1 });
  });

  it('lève une erreur explicite sans JSON', () => {
    expect(() => GeminiService.parseJSON('aucune donnée structurée')).toThrow(
      /Invalid AI response format/,
    );
  });

  it('reste rapide sur une entrée pathologique (pas de backtracking quadratique)', () => {
    const evil = '```json' + ' '.repeat(200_000) + '{'.repeat(50_000);
    const t0 = Date.now();
    expect(() => GeminiService.parseJSON(evil)).toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
