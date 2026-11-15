import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { encryptFile, decryptFile } from '../../src/utils/backupCrypto';

const KEY = 'k'.repeat(48);
const tmp = (n: string) => path.join(os.tmpdir(), `kbk-${process.pid}-${Date.now()}-${n}`);

describe('Chiffrement des sauvegardes (AES-256-GCM)', () => {
  const plain = crypto.randomBytes(5 * 1024 * 1024 + 123); // > plusieurs blocs de flux
  let src: string, enc: string, out: string;
  beforeEach(() => {
    src = tmp('src');
    enc = tmp('enc');
    out = tmp('out');
    fs.writeFileSync(src, plain);
  });
  afterEach(() => [src, enc, out].forEach((f) => fs.rmSync(f, { force: true })));

  it('aller-retour à l’identique ; le fichier chiffré ne contient pas le clair', async () => {
    await encryptFile(src, enc, KEY);
    const encrypted = fs.readFileSync(enc);
    expect(encrypted.subarray(0, 4).toString()).toBe('KBK1');
    expect(encrypted.includes(plain.subarray(1000, 1064))).toBe(false);
    await decryptFile(enc, out, KEY);
    expect(fs.readFileSync(out).equals(plain)).toBe(true);
  });

  it('fichier altéré → déchiffrement refusé (intégrité)', async () => {
    await encryptFile(src, enc, KEY);
    const b = fs.readFileSync(enc);
    b[5000] ^= 0xff;
    fs.writeFileSync(enc, b);
    await expect(decryptFile(enc, out, KEY)).rejects.toThrow();
  });

  it('mauvaise clé → refusé ; clé trop courte → refusée', async () => {
    await encryptFile(src, enc, KEY);
    await expect(decryptFile(enc, out, 'x'.repeat(48))).rejects.toThrow();
    await expect(encryptFile(src, enc, 'court')).rejects.toThrow(/32/);
  });
});
