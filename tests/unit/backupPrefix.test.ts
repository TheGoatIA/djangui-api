import { firebaseBackupPrefix } from '../../src/services/dbBackupService';

describe('Préfixe des sauvegardes Firebase (staging et prod partagent le bucket)', () => {
  const old = process.env.BACKUP_FIREBASE_PREFIX;
  afterEach(() => {
    if (old === undefined) delete process.env.BACKUP_FIREBASE_PREFIX;
    else process.env.BACKUP_FIREBASE_PREFIX = old;
  });

  it('production : « backups » par défaut (chemins existants inchangés)', () => {
    delete process.env.BACKUP_FIREBASE_PREFIX;
    expect(firebaseBackupPrefix()).toBe('backups');
  });

  it('staging : dossier séparé, barres obliques nettoyées', () => {
    process.env.BACKUP_FIREBASE_PREFIX = '/backups-staging/';
    expect(firebaseBackupPrefix()).toBe('backups-staging');
    process.env.BACKUP_FIREBASE_PREFIX = '  ';
    expect(firebaseBackupPrefix()).toBe('backups');
  });
});
