import client from 'prom-client';
import logger from '../utils/logger';

/**
 * Métriques Prometheus agrégées sur TOUTES les copies PM2 (mode cluster).
 *
 * Chaque copie a son propre registre : Prometheus, qui garde sa connexion ouverte,
 * ne voyait qu'une copie sur 12 (volumes ~12x trop bas, métriques des tâches
 * planifiées — copie 0 seulement — quasi invisibles). La copie qui reçoit
 * /metrics demande leurs métriques à toutes les copies via PM2, puis les agrège.
 * Hors PM2 (dev, tests) ou en cas d'échec : métriques locales, comme avant.
 */

const REQUEST_TOPIC = 'kauri:metrics:get';
const REPLY_TOPIC = 'kauri:metrics:reply';
const TIMEOUT_MS = 2000;

/** Jauges propres à chaque copie, dont la somme a un sens (connexions, pool Mongo…). */
const SUMMED_GAUGES = new Set([
  'active_connections',
  'sessions_active_gauge',
  'db_connection_pool_size',
  'db_connection_pool_active',
  'db_connection_pool_idle',
  'db_connection_pool_waiting',
]);

type MetricJSON = Awaited<ReturnType<client.Registry['getMetricsAsJSON']>>[number] & {
  aggregator?: string;
};

/**
 * Règle d'agrégation : compteurs et histogrammes additionnés ; jauges métier
 * (soldes, taux, disponibilité d'un prestataire…) identiques d'une copie à l'autre
 * ou posées par la seule copie 0 → maximum, jamais la somme (« Stripe = 12 ») ;
 * métriques par défaut de prom-client : leur propre règle.
 */
export const withClusterAggregator = (metrics: MetricJSON[]): MetricJSON[] =>
  metrics.map((m) => {
    const isDefault = m.name.startsWith('process_') || m.name.startsWith('nodejs_');
    if (String(m.type) === 'gauge' && !isDefault && !SUMMED_GAUGES.has(m.name)) {
      return { ...m, aggregator: 'max' };
    }
    return m;
  });

type Pending = { results: MetricJSON[][]; expected: number; resolve: () => void };
const pending = new Map<string, Pending>();
let pm2: any;
let ready: Promise<void> | undefined;

const loadPm2 = () => {
  for (const id of ['pm2', '/opt/pm2/node_modules/pm2']) {
    try {
      return require(id);
    } catch {
      /* chemin suivant */
    }
  }
  return undefined;
};

const call = <T>(fn: (cb: (err: any, res?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res as T))));

const connect = () => {
  ready ??= (async () => {
    pm2 = loadPm2();
    if (!pm2) throw new Error('module pm2 introuvable');
    await call((cb) => pm2.connect(cb));
    const bus: any = await call((cb) => pm2.launchBus(cb));
    bus.on('process:msg', (packet: any) => {
      const data = packet?.data;
      if (data?.topic !== REPLY_TOPIC) return;
      const p = pending.get(data.reqId);
      if (!p) return;
      p.results.push(data.metrics);
      if (p.results.length >= p.expected) p.resolve();
    });
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
};

const underPm2Cluster = () => process.env.pm_id !== undefined && !!process.send;

/** À appeler dans chaque copie : répond aux demandes de métriques des autres copies. */
export const listenForMetricRequests = (registry: client.Registry) => {
  if (!underPm2Cluster()) return;
  process.on('message', async (packet: any) => {
    if (packet?.topic !== REQUEST_TOPIC) return;
    try {
      const metrics = await registry.getMetricsAsJSON();
      process.send?.({
        type: 'process:msg',
        data: { topic: REPLY_TOPIC, reqId: packet.data?.reqId, metrics },
      });
    } catch (err: any) {
      logger.warn(`[metrics] réponse au regroupement impossible : ${err.message}`);
    }
  });
};

/** Métriques de toutes les copies, ou null pour se rabattre sur les métriques locales. */
export const collectClusterMetrics = async (): Promise<string | null> => {
  if (!underPm2Cluster()) return null;
  try {
    await connect();
    const list: any[] = await call((cb) => pm2.list(cb));
    const ids = list
      .filter((p) => p.name === process.env.name && p.pm2_env?.status === 'online')
      .map((p) => p.pm_id);
    if (ids.length <= 1) return null;

    const reqId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    pending.set(reqId, { results: [], expected: ids.length, resolve });
    try {
      await Promise.all(
        ids.map((id) =>
          call((cb) =>
            pm2.sendDataToProcessId(
              id,
              { type: 'process:msg', topic: REQUEST_TOPIC, data: { reqId } },
              cb,
            ),
          ).catch(() => undefined),
        ),
      );
      await Promise.race([done, new Promise((r) => setTimeout(r, TIMEOUT_MS))]);
      const { results } = pending.get(reqId)!;
      if (results.length === 0) return null;
      const aggregated = client.AggregatorRegistry.aggregate(
        results.map((r) => withClusterAggregator(r)) as any,
      );
      const body = await aggregated.metrics();
      return (
        body +
        '# HELP kauri_metrics_workers Copies PM2 prises en compte dans ces métriques.\n' +
        '# TYPE kauri_metrics_workers gauge\n' +
        `kauri_metrics_workers{state="reporting"} ${results.length}\n` +
        `kauri_metrics_workers{state="online"} ${ids.length}\n`
      );
    } finally {
      pending.delete(reqId);
    }
  } catch (err: any) {
    logger.warn(`[metrics] regroupement PM2 indisponible, métriques locales : ${err.message}`);
    return null;
  }
};
