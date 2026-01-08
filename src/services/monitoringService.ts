import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export class MonitoringService {
    private static registry = new client.Registry();

    // Metrics definitions
    private static httpRequestDuration = new client.Histogram({
        name: 'http_request_duration_seconds',
        help: 'Duration of HTTP requests in seconds',
        labelNames: ['method', 'route', 'status_code'],
        buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 10],
    });

    private static dbQueryDuration = new client.Histogram({
        name: 'db_query_duration_seconds',
        help: 'Duration of database queries in seconds',
        labelNames: ['collection', 'operation'],
        buckets: [0.01, 0.05, 0.1, 0.5, 1],
    });

    private static activeUsers = new client.Gauge({
        name: 'active_users_total',
        help: 'Total number of active users',
    });

    private static errorsCount = new client.Counter({
        name: 'application_errors_total',
        help: 'Total number of application errors',
        labelNames: ['type'],
    });

    /**
     * Initialize custom metrics
     */
    static init() {
        client.collectDefaultMetrics({ register: this.registry });
        this.registry.registerMetric(this.httpRequestDuration);
        this.registry.registerMetric(this.dbQueryDuration);
        this.registry.registerMetric(this.activeUsers);
        this.registry.registerMetric(this.errorsCount);

        logger.info('Monitoring service initialized (Prometheus)');
    }

    /**
     * Middleware to track HTTP requests
     */
    static metricsMiddleware(req: Request, res: Response, next: NextFunction) {
        const start = Date.now();

        res.on('finish', () => {
            const duration = (Date.now() - start) / 1000;
            const route = req.route ? req.route.path : req.path;

            this.httpRequestDuration.labels(req.method, route, res.statusCode.toString()).observe(duration);

            if (res.statusCode >= 400) {
                this.errorsCount.labels('http_error').inc();
            }
        });

        next();
    }

    /**
     * Expose metrics for Prometheus scraping
     */
    static async getMetrics(req: Request, res: Response) {
        res.set('Content-Type', this.registry.contentType);
        res.end(await this.registry.metrics());
    }

    /**
     * Track DB query duration
     */
    static recordDbQuery(collection: string, operation: string, durationSeconds: number) {
        this.dbQueryDuration.labels(collection, operation).observe(durationSeconds);
    }

    /**
     * Update active users gauge
     */
    static updateActiveUsers(count: number) {
        this.activeUsers.set(count);
    }

    /**
     * Increment generic error counter
     */
    static recordError(type: string) {
        this.errorsCount.labels(type).inc();
    }
}
