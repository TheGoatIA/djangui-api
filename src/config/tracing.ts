import logger from '../utils/logger';

let sdkInstance: any = null;

export const initTracing = async () => {
  if (process.env.ENABLE_TRACING === 'false') {
    logger.info('OpenTelemetry Tracing is disabled via environment variable');
    return;
  }
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ParentBasedSampler, TraceIdRatioBasedSampler } = await import('@opentelemetry/sdk-trace-base');

    const traceExporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
    });

    sdkInstance = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': 'kauri-api',
      }),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(0.1),
      }),
      traceExporter,
      instrumentations: [getNodeAutoInstrumentations()],
    });

    sdkInstance.start();
    logger.info('OpenTelemetry Tracing initialized');
  } catch (error: any) {
    logger.warn(`OpenTelemetry Tracing initialization skipped (non-blocking): ${error.message}`);
  }
};

export const shutdownTracing = async (): Promise<void> => {
  if (process.env.ENABLE_TRACING === 'false' || !sdkInstance) return;
  try {
    await sdkInstance.shutdown();
    logger.info('Tracing terminated');
  } catch (error: any) {
    logger.error('Error terminating tracing', error);
  }
};
