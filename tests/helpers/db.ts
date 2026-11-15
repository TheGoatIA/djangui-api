/**
 * Base MongoDB de test (replica set — transactions ACID réelles).
 *
 * Chaque worker Jest a SA base (`kauri_it_<worker>`) : les fichiers de test peuvent
 * tourner en parallèle sans se marcher dessus, et chaque fichier repart d'une base vide.
 */
import mongoose from 'mongoose';
import redis from '../../src/config/redis';

export const testDbName = () => `kauri_it_${process.env.JEST_WORKER_ID || '0'}`;

export async function connectTestDB(): Promise<void> {
  const uri = process.env.MONGO_RS_URI as string;
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(uri, { dbName: testDbName(), serverSelectionTimeoutMS: 5000 });
  }
  await mongoose.connection.db!.dropDatabase();
  await resetRedis();
  // Les index uniques (email, références de paiement…) font partie du contrat testé.
  await Promise.all(
    Object.values(mongoose.models).map((m) => m.syncIndexes().catch(() => undefined)),
  );
}

/** Vide toutes les collections (plus rapide qu'un drop entre deux tests). */
export async function clearTestDB(): Promise<void> {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  await resetRedis();
}

export async function closeTestDB(): Promise<void> {
  await mongoose.connection.close(true);
  await closeRedis();
}

/** Ferme proprement la connexion Redis (évite les handles ouverts en fin de suite). */
export async function closeRedis(): Promise<void> {
  if ((redis as any).status !== 'end') await (redis as any).quit().catch(() => undefined);
}

/** Vide la base Redis du worker (blacklist, verrous de login, rate-limit, idempotence…). */
export async function resetRedis(): Promise<void> {
  await redis.flushdb();
}

/** Raccourci : à appeler en tête d'un `describe` d'intégration. */
export function useTestDB(opts: { clearBetweenTests?: boolean } = {}) {
  beforeAll(connectTestDB);
  if (opts.clearBetweenTests !== false) beforeEach(clearTestDB);
  afterAll(closeTestDB);
}
