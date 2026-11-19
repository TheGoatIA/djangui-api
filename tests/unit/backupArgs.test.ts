/**
 * Sauvegardes en échec depuis le 15/11/2026 : `--archive <fichier>` (valeur
 * séparée) faisait lire le fichier comme une 2e chaîne de connexion, et l'erreur
 * — qui cite la commande — publiait le mot de passe MongoDB (journaux, Slack, e-mail).
 */
import { maskMongoCredentials, mongoToolArgs } from '../../src/services/dbBackupService';

describe('arguments mongodump / mongorestore', () => {
  const uri = 'mongodb://admin:secret@mongodb:27017/kauri?authSource=admin&replicaSet=rs0';

  it('valeurs collées à leur option (aucun argument positionnel)', () => {
    const args = mongoToolArgs(uri, 'backups/db.gz');
    expect(args).toEqual([`--uri=${uri}`, '--archive=backups/db.gz', '--gzip']);
    expect(args.every((a) => a.startsWith('--'))).toBe(true);
  });

  it('options supplémentaires conservées (restauration)', () => {
    expect(mongoToolArgs(uri, 'x.gz', '--drop')).toContain('--drop');
  });
});

describe('masquage des identifiants', () => {
  it('URI mongodb et mongodb+srv', () => {
    const msg =
      'Command failed: mongodump --uri=mongodb://admin:secret@mongodb:27017/kauri ' +
      'puis mongodb+srv://u:p@cluster.example.net/db';
    const masked = maskMongoCredentials(msg);
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('u:p@');
    expect(masked).toContain('mongodb://***@mongodb:27017/kauri');
  });

  it('texte sans identifiants inchangé', () => {
    expect(maskMongoCredentials('mongodb://mongodb:27017/kauri')).toBe(
      'mongodb://mongodb:27017/kauri',
    );
  });
});
