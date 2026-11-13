/**
 * MODULE KYC & UPLOADS — tests de bout en bout (HTTP → S3 réel de test → MongoDB).
 * Téléversement des pièces (privées, rangées par utilisateur), soumission KYC, analyse IA
 * (simulée : Gemini payant), revue admin (signée, auditée), effet sur les retraits,
 * avatars (publics), tickets scannés (privés), validation des fichiers.
 */
import crypto from 'node:crypto';
import { useTestDB } from '../helpers/db';
import { as } from '../helpers/http';
import { createUser, createAdmin, createSupport, createPremium } from '../helpers/factories';
import User from '../../src/models/User';
import AuditLog from '../../src/models/AuditLog';
import { GeminiService } from '../../src/services/ai/geminiService';
import { OCRService } from '../../src/services/ai/ocrService';

jest.setTimeout(60000);

const png = () =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), crypto.randomBytes(32)]);
const S3 = process.env.MINIO_PUBLIC_URL as string;

async function uploadDoc(user: { _id: unknown }) {
  const res = await as(user)
    .post('/upload/document')
    .attach('document', png(), { filename: 'cni.png', contentType: 'image/png' });
  expect(res.status).toBe(200);
  return res.body.data.documentUrl as string;
}

async function submit(user: { _id: unknown }, o: Record<string, unknown> = {}) {
  const documentImageUrl = o.documentImageUrl ?? (await uploadDoc(user));
  const selfieImageUrl = o.selfieImageUrl ?? (await uploadDoc(user));
  return as(user)
    .post('/fintech/kyc/submit')
    .send({
      documentType: 'cni',
      documentNumber: 'CM123456',
      fullName: 'Awa Ngono',
      documentExpiryDate: new Date(Date.now() + 365 * 86400000).toISOString(),
      ...o,
      documentImageUrl,
      selfieImageUrl,
    });
}

describe('KYC & uploads', () => {
  useTestDB();
  beforeEach(() => {
    jest.spyOn(GeminiService, 'generateJSON').mockResolvedValue({
      isMatch: true,
      confidenceScore: 92,
      analysisReport: 'Document authentique, visage concordant.',
    } as any);
  });

  describe('Téléversement des pièces', () => {
    it('stocké en privé dans le dossier de l’utilisateur', async () => {
      const user = await createUser();
      const url = await uploadDoc(user);
      expect(url).toContain(`/kauri-uploads/documents/${user._id}/`);
    });

    it.each([
      ['fichier non image déguisé', Buffer.from('MZ\x90\x00 exécutable'), 'image/png'],
      ['type MIME interdit', png(), 'text/html'],
    ])('SÉCURITÉ : %s → rejeté', async (_l, buf, type) => {
      const user = await createUser();
      const res = await as(user)
        .post('/upload/document')
        .attach('document', buf, { filename: 'x.png', contentType: type });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('sans fichier → 400 ; sans authentification → 401', async () => {
      expect((await as(await createUser()).post('/upload/document')).status).toBe(400);
      expect((await as(null).post('/upload/document')).status).toBe(401);
    });
  });

  describe('Soumission KYC', () => {
    it('soumission valide → "pending", analyse IA enregistrée sans valider automatiquement', async () => {
      const user = await createUser();
      const res = await submit(user);
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 500)); // analyse IA en arrière-plan
      const db = await User.findById(user._id);
      expect(db!.kycLevel).toBe('pending');
      expect(db!.kycData!.aiConfidence).toBe(92);
      expect(db!.kycData!.aiAnalysisStatus).toBe('completed');
    });

    it('SÉCURITÉ : impossible de soumettre le document d’identité d’un AUTRE utilisateur', async () => {
      const victim = await createUser();
      const victimDoc = await uploadDoc(victim);
      const attacker = await createUser();
      expect((await submit(attacker, { documentImageUrl: victimDoc })).status).toBe(400);
      expect((await User.findById(attacker._id))!.kycLevel).toBe('none');
    });

    it.each([
      ['un autre bucket (sauvegardes)', `${S3}/kauri-backups/db.tar.gz`],
      ['une URL externe', 'https://evil.example.com/cni.png'],
      ['un chemin interne', 'http://169.254.169.254/latest/meta-data'],
    ])('SÉCURITÉ : document pointant vers %s → 400', async (_l, url) => {
      const user = await createUser();
      expect((await submit(user, { documentImageUrl: url })).status).toBe(400);
    });

    it.each([
      ['type absent', { documentType: undefined }],
      ['numéro absent', { documentNumber: '' }],
      ['nom absent', { fullName: undefined }],
      ['document expiré', { documentExpiryDate: '2020-01-01' }],
      ['date invalide', { documentExpiryDate: 'demain' }],
    ])('champ invalide (%s) → 400, jamais 500', async (_l, o) => {
      const user = await createUser();
      expect((await submit(user, o)).status).toBe(400);
    });

    it('selfie manquant → 400', async () => {
      const user = await createUser();
      const doc = await uploadDoc(user);
      const res = await as(user).post('/fintech/kyc/submit').send({
        documentType: 'cni',
        documentNumber: 'CM1',
        fullName: 'Awa Ngono',
        documentImageUrl: doc,
      });
      expect(res.status).toBe(400);
    });

    it('déjà vérifié → nouvelle soumission refusée', async () => {
      const user = await createUser({ kycLevel: 'verified' });
      expect((await submit(user)).status).toBe(400);
    });

    it('panne de l’IA → analyse "failed", le dossier reste en revue manuelle', async () => {
      (GeminiService.generateJSON as jest.Mock).mockRejectedValueOnce(new Error('quota'));
      const user = await createUser();
      await submit(user);
      await new Promise((r) => setTimeout(r, 500));
      const db = await User.findById(user._id);
      expect(db!.kycLevel).toBe('pending');
      expect(db!.kycData!.aiAnalysisStatus).toBe('failed');
    });
  });

  describe('Revue admin', () => {
    it('liste des dossiers en attente avec URLs signées réellement consultables', async () => {
      const user = await createUser();
      await submit(user);
      const res = await as(await createAdmin()).get('/admin/kyc/pending');
      expect(res.status).toBe(200);
      const entry = JSON.stringify(res.body);
      const signed = entry.match(/https?:[^"]+X-Amz-Signature=[^"]+/);
      expect(signed).not.toBeNull();
      expect((await fetch(signed![0].replace(/\\u0026/g, '&'))).status).toBe(200);
    });

    it('validation → "verified", notifiée et auditée ; le retrait devient possible', async () => {
      const user = await createUser({ walletBalance: 10000 });
      await submit(user);
      const admin = await createAdmin();
      expect((await as(admin).patch(`/admin/kyc/${user._id}/validate`)).status).toBe(200);
      const db = await User.findById(user._id);
      expect(db!.kycLevel).toBe('verified');
      expect(db!.kycData!.verifiedAt).toBeInstanceOf(Date);
      expect(
        await AuditLog.countDocuments({ action: 'KYC_VERIFIED', resourceId: String(user._id) }),
      ).toBe(1);
    });

    it('rejet avec motif → l’utilisateur peut resoumettre', async () => {
      const user = await createUser();
      await submit(user);
      await as(await createAdmin())
        .patch(`/admin/kyc/${user._id}/reject`)
        .send({ reason: 'Photo floue' });
      const db = await User.findById(user._id);
      expect(db!.kycLevel).toBe('rejected');
      expect(db!.kycData!.rejectionReason).toBe('Photo floue');
      expect((await submit(user)).status).toBe(202);
    });

    it('le support peut consulter mais pas valider ; un utilisateur ne peut rien', async () => {
      const user = await createUser();
      await submit(user);
      const support = await createSupport();
      expect((await as(support).get('/admin/kyc/pending')).status).toBe(200);
      expect((await as(support).patch(`/admin/kyc/${user._id}/validate`)).status).toBe(403);
      expect((await as(user).patch(`/admin/kyc/${user._id}/validate`)).status).toBe(403);
      expect((await User.findById(user._id))!.kycLevel).toBe('pending');
    });

    it('CONFORMITÉ : l’édition manuelle d’un dossier (y compris son statut) est auditée', async () => {
      const user = await createUser();
      await submit(user);
      const admin = await createAdmin();
      await as(admin)
        .patch(`/admin/kyc/${user._id}/edit`)
        .send({ kycLevel: 'verified', fullName: 'Awa N.' });
      const log = await AuditLog.findOne({ action: 'KYC_EDIT', resourceId: String(user._id) });
      expect(log).not.toBeNull();
      expect(String(log!.userId)).toBe(String(admin._id));
    });
  });

  describe('Avatars et tickets scannés', () => {
    it('avatar : stocké dans le bucket public des avatars et appliqué au profil', async () => {
      const user = await createUser();
      const res = await as(user)
        .post('/upload/avatar')
        .attach('avatar', png(), { filename: 'me.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.data.avatarUrl).toContain('/kauri-avatars/avatars/');
      expect((await User.findById(user._id))!.avatar).toBe(res.body.data.avatarUrl);
    });

    it('SÉCURITÉ : appliquer un avatar IA qui n’est pas le sien → 400', async () => {
      const user = await createPremium();
      const other = await createPremium();
      for (const avatarUrl of [
        `${S3}/kauri-avatars/avatars/ai-${other._id}-1.png`,
        'https://evil.example.com/a.png',
      ]) {
        expect((await as(user).post('/upload/avatar/apply').send({ avatarUrl })).status).toBe(400);
      }
    });

    it('ticket scanné : premium uniquement, stocké en privé, aperçu signé', async () => {
      jest
        .spyOn(OCRService, 'scanReceipt')
        .mockResolvedValue({ amount: 2500, merchant: 'Boulangerie' } as any);
      const free = await createUser();
      expect(
        (
          await as(free)
            .post('/upload/receipt')
            .attach('receipt', png(), { filename: 't.png', contentType: 'image/png' })
        ).status,
      ).toBe(403);
      const user = await createPremium();
      const res = await as(user)
        .post('/upload/receipt')
        .attach('receipt', png(), { filename: 't.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.data.filePath).toContain(`/kauri-uploads/receipts/${user._id}/`);
      expect(res.body.data.previewUrl).toMatch(/X-Amz-Signature=/);
    });
  });
});
