import AuditLog, { IAuditLog } from '../models/AuditLog';
import logger from '../utils/logger';
import { Request } from 'express';

export class AuditService {
    /**
     * Record an audit log entry
     */
    static async record(data: Partial<IAuditLog>, req?: Request) {
        try {
            const logEntry = {
                ...data,
                ip: data.ip || (req ? req.ip : undefined),
                userAgent: data.userAgent || (req ? req.get('user-agent') : undefined),
            };

            // We don't await this to avoid blocking the main thread
            AuditLog.create(logEntry).catch((err) => {
                logger.error(`Failed to create audit log: ${err.message}`);
            });
        } catch (error: any) {
            logger.error(`Error in AuditService.record: ${error.message}`);
        }
    }

    /**
     * List audit logs for a specific resource or user
     */
    static async getLogs(query: any, options: { page?: number; limit?: number } = {}) {
        const page = options.page || 1;
        const limit = options.limit || 50;
        const skip = (page - 1) * limit;

        const [logs, total] = await Promise.all([
            AuditLog.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('userId', 'email firstName lastName'),
            AuditLog.countDocuments(query),
        ]);

        return {
            logs,
            total,
            pages: Math.ceil(total / limit),
            currentPage: page,
        };
    }
}
