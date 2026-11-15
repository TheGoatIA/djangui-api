import AuditLog, { IAuditLog } from '../models/AuditLog';
import logger from '../utils/logger';
import { Request } from 'express';
import { MonitoringService } from './monitoringService';
import { SlackService } from './slackService';

type ActorType = 'user' | 'admin' | 'system';

export class AuditService {
  /**
   * Record an audit log entry (async non-blocking with error logging)
   */
  static async record(data: Partial<IAuditLog>, req?: Request, actorType: ActorType = 'user') {
    try {
      const logEntry = {
        ...data,
        ip: data.ip || (req ? req.ip : undefined),
        userAgent: data.userAgent || (req ? req.get('user-agent') : undefined),
      };

      if (data.action) MonitoringService.recordAuditLogEvent(data.action, actorType);

      AuditLog.create(logEntry).catch((err) => {
        logger.error(`Failed to create audit log: ${err.message}`, { logEntry });
      });
    } catch (error: any) {
      logger.error(`Error in AuditService.record: ${error.message}`);
    }
  }

  /**
   * Record an audit log entry synchronously (awaited for critical financial/KYC/security events)
   */
  static async recordSync(
    data: Partial<IAuditLog>,
    req?: Request,
    actorType: ActorType = 'user',
  ): Promise<IAuditLog | null> {
    try {
      const logEntry = {
        ...data,
        ip: data.ip || (req ? req.ip : undefined),
        userAgent: data.userAgent || (req ? req.get('user-agent') : undefined),
      };

      if (data.action) MonitoringService.recordAuditLogEvent(data.action, actorType);

      const created = await AuditLog.create(logEntry);

      // recordSync is reserved for high-impact events (money movement,
      // privilege changes, admin actions) — that's exactly what belongs in
      // a dedicated #kauri-audit channel, unlike the far higher-volume
      // fire-and-forget record() (report exports, settings tweaks).
      if (actorType === 'admin') {
        SlackService.sendAudit(
          `📋 *Action admin* — \`${data.action}\` sur \`${data.resource}${data.resourceId ? `:${data.resourceId}` : ''}\`${data.userId ? ` par \`${data.userId}\`` : ''}`,
        ).catch((e: any) => logger.error(`Slack audit alert error: ${e.message}`));
      }

      return created;
    } catch (error: any) {
      logger.error(`Error in AuditService.recordSync: ${error.message}`, { data });
      return null;
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
