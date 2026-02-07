import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import logger from '../utils/logger';

const traceExporter = new OTLPTraceExporter({
  // Point to the OTEL Collector (or Jaeger directly)
  // In Docker: 'http://otel-collector:4317'
  // Local: 'http://localhost:4317'
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: 'kauri-api',
  }),
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

export const initTracing = async () => {
  try {
    sdk.start();
    logger.info('OpenTelemetry Tracing initialized');

    // Graceful shutdown
    process.on('SIGTERM', () => {
      sdk
        .shutdown()
        .then(() => logger.info('Tracing terminated'))
        .catch((error) => logger.error('Error terminating tracing', error))
        .finally(() => process.exit(0));
    });
  } catch (error) {
    logger.error('Error initializing tracing', error);
  }
};
