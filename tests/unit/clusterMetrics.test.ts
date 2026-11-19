/**
 * Mode cluster PM2 : Prometheus ne voyait qu'une copie sur 12. /metrics agrège
 * désormais toutes les copies (compteurs additionnés, jauges métier au maximum).
 */
import client from 'prom-client';

const busHandlers: Record<string, (p: any) => void> = {};
const workerRegistries: client.Registry[] = [];

jest.mock(
  'pm2',
  () => ({
    connect: (cb: any) => cb(null),
    launchBus: (cb: any) => cb(null, { on: (ev: string, h: any) => (busHandlers[ev] = h) }),
    list: (cb: any) =>
      cb(
        null,
        workerRegistries.map((_, i) => ({
          pm_id: i,
          name: 'kauri-api',
          pm2_env: { status: 'online' },
        })),
      ),
    sendDataToProcessId: (id: number, packet: any, cb: any) => {
      cb(null);
      workerRegistries[id].getMetricsAsJSON().then((metrics) =>
        busHandlers['process:msg']?.({
          data: { topic: 'kauri:metrics:reply', reqId: packet.data.reqId, metrics },
        }),
      );
    },
  }),
  { virtual: true },
);

import {
  collectClusterMetrics,
  listenForMetricRequests,
  withClusterAggregator,
} from '../../src/services/clusterMetrics';

const worker = (requests: number, stripeUp: number, connections: number) => {
  const r = new client.Registry();
  new client.Counter({ name: 'http_requests_total', help: 'h', registers: [r] }).inc(requests);
  new client.Gauge({
    name: 'payment_provider_availability',
    help: 'h',
    labelNames: ['provider'],
    registers: [r],
  }).set({ provider: 'stripe' }, stripeUp);
  new client.Gauge({ name: 'active_connections', help: 'h', registers: [r] }).set(connections);
  return r;
};

const value = (body: string, line: string) =>
  Number(
    body
      .split('\n')
      .find((l) => l.startsWith(line))
      ?.split(' ')
      .pop(),
  );

describe('métriques agrégées sur les copies PM2', () => {
  const env = { ...process.env };
  const send = process.send;

  beforeEach(() => {
    workerRegistries.length = 0;
    process.env.pm_id = '0';
    process.env.name = 'kauri-api';
    process.send = jest.fn() as any;
  });
  afterEach(() => {
    process.env = { ...env };
    process.send = send;
  });

  it('additionne les compteurs, garde le maximum des jauges métier', async () => {
    workerRegistries.push(worker(10, 1, 2), worker(5, 1, 3));
    const body = (await collectClusterMetrics())!;
    expect(value(body, 'http_requests_total')).toBe(15);
    expect(value(body, 'payment_provider_availability{provider="stripe"}')).toBe(1);
    expect(value(body, 'active_connections')).toBe(5);
    expect(value(body, 'kauri_metrics_workers{state="reporting"}')).toBe(2);
  });

  it('une seule copie : métriques locales (null)', async () => {
    workerRegistries.push(worker(1, 1, 1));
    expect(await collectClusterMetrics()).toBeNull();
  });

  it('hors PM2 : métriques locales (null)', async () => {
    delete process.env.pm_id;
    expect(await collectClusterMetrics()).toBeNull();
  });
});

describe('copie interrogée', () => {
  const send = process.send;
  afterEach(() => {
    process.send = send;
    delete process.env.pm_id;
  });

  it('répond à une demande avec ses métriques, ignore les autres messages', async () => {
    process.env.pm_id = '3';
    const reply = jest.fn();
    process.send = reply as any;
    listenForMetricRequests(worker(7, 1, 1));
    process.emit('message' as any, { topic: 'autre' } as any);
    process.emit('message' as any, { topic: 'kauri:metrics:get', data: { reqId: 'r1' } } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(reply).toHaveBeenCalledTimes(1);
    const msg = reply.mock.calls[0][0];
    expect(msg.data).toMatchObject({ topic: 'kauri:metrics:reply', reqId: 'r1' });
    expect(msg.data.metrics.find((m: any) => m.name === 'http_requests_total')).toBeTruthy();
    process.removeAllListeners('message');
  });

  it('hors PM2 : aucun écouteur installé', () => {
    const before = process.listenerCount('message');
    listenForMetricRequests(new client.Registry());
    expect(process.listenerCount('message')).toBe(before);
  });
});

describe('règle d’agrégation', () => {
  it('jauges métier au maximum, compteurs et métriques par défaut inchangés', () => {
    const out = withClusterAggregator([
      { name: 'economy_total_wallet_balance', type: 'gauge', aggregator: 'sum' },
      { name: 'db_connection_pool_active', type: 'gauge', aggregator: 'sum' },
      { name: 'http_requests_total', type: 'counter', aggregator: 'sum' },
      { name: 'nodejs_eventloop_lag_p99_seconds', type: 'gauge', aggregator: 'average' },
    ] as any);
    expect(out.map((m) => m.aggregator)).toEqual(['max', 'sum', 'sum', 'average']);
  });
});
