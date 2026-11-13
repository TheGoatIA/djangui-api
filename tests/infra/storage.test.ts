/**
 * Contrat du stockage objet (StorageService ↔ S3 réel de test) : upload buffer,
 * relecture, URL signée. Garantit que factures / KYC / backups sont réellement
 * persistés et relisibles, pas seulement "appelés".
 */
import { StorageService } from '../../src/services/storageService';

jest.setTimeout(30000);

describe('StorageService (S3 de test)', () => {
  const bucket = 'kauri-test-bucket';

  it('upload puis relecture d’un buffer à l’identique', async () => {
    const key = `it/${Date.now()}.txt`;
    const body = Buffer.from('facture kauri é€');
    const url = await StorageService.uploadBuffer(body, bucket, key, 'private');
    expect(url).toContain(`${bucket}/${key}`);
    const back = await StorageService.downloadBuffer(bucket, key);
    expect(back.equals(body)).toBe(true);
  });

  it('génère une URL signée pour un objet privé', async () => {
    const key = `it/signed-${Date.now()}.txt`;
    await StorageService.uploadBuffer(Buffer.from('kyc'), bucket, key, 'private');
    const signed = await StorageService.getSignedUrl(bucket, key);
    expect(signed).toMatch(/X-Amz-Signature=/);
    const res = await fetch(signed);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('kyc');
  });

  it('relire un objet inexistant échoue proprement', async () => {
    await expect(StorageService.downloadBuffer(bucket, 'absent/nope.txt')).rejects.toThrow();
  });
});
