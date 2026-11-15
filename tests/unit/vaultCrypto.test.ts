import { VaultCrypto } from '../../src/utils/vaultCrypto';

describe('VaultCrypto (AES-256-GCM)', () => {
  beforeAll(() => {
    process.env.VAULT_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  it('chiffre puis déchiffre (aller-retour)', () => {
    const enc = VaultCrypto.encrypt('secret-valeur', 'kyc_doc');
    expect(enc.ciphertext).not.toContain('secret-valeur');
    expect(VaultCrypto.decrypt(enc.ciphertext, enc.iv, enc.authTag, 'kyc_doc')).toBe(
      'secret-valeur',
    );
  });

  it('refuse un texte altéré (tag valide mais données modifiées)', () => {
    const enc = VaultCrypto.encrypt('montant=1000', 'kyc_doc');
    const tampered = (enc.ciphertext[0] === 'a' ? 'b' : 'a') + enc.ciphertext.slice(1);
    expect(VaultCrypto.decrypt(tampered, enc.iv, enc.authTag, 'kyc_doc')).toBe('');
  });

  it('refuse un tag d’authentification tronqué (forge GCM)', () => {
    const enc = VaultCrypto.encrypt('montant=1000', 'kyc_doc');
    const truncated = enc.authTag.slice(0, 8); // 4 octets au lieu de 16
    expect(VaultCrypto.decrypt(enc.ciphertext, enc.iv, truncated, 'kyc_doc')).toBe('');
  });

  it('refuse un mauvais sel (autre contexte de dérivation)', () => {
    const enc = VaultCrypto.encrypt('x', 'kyc_doc');
    expect(VaultCrypto.decrypt(enc.ciphertext, enc.iv, enc.authTag, 'other_ctx')).toBe('');
  });
});
