import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import logger from '../utils/logger';

import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: 'kauri-api',
  }),
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(0.1), // Sample 10% of requests locally
  }),
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

export const initTracing = async () => {
  if (process.env.ENABLE_TRACING === 'false') {
    logger.info('OpenTelemetry Tracing is disabled via environment variable');
    return;
  }
  try {
    sdk.start();
    logger.info('OpenTelemetry Tracing initialized');
    // Shutdown is intentionally NOT wired to its own SIGTERM listener here — see
    // shutdownTracing() below. server.ts owns the single graceful-shutdown
    // sequence (close HTTP server, drain connections, then close Mongo/Redis/
    // tracing, with a 20s force-exit fallback); a second, independent SIGTERM
    // handler calling process.exit() on its own would race that sequence and
    // could terminate the process mid-drain, since OTEL shutdown is typically
    // much faster than draining in-flight requests.
  } catch (error) {
    logger.error('Error initializing tracing', error);
  }
};

/**
 * Called from server.ts's own shutdown sequence — never registers its own
 * SIGTERM listener or calls process.exit() (see the note in initTracing above).
 */
export const shutdownTracing = async (): Promise<void> => {
  if (process.env.ENABLE_TRACING === 'false') return;
  try {
    await sdk.shutdown();
    logger.info('Tracing terminated');
  } catch (error) {
    logger.error('Error terminating tracing', error);
  }
};
