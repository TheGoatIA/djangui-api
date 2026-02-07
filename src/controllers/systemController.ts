import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import SystemSetting from '../models/SystemSetting';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export class SystemController {
  // Check App Version
  static async checkVersion(req: Request, res: Response, next: NextFunction) {
    try {
      const { platform, version } = req.query;

      if (!platform || !version) {
        return next(new AppError('Platform and version are required', 400));
      }

      // Fetch version settings for the specific platform
      // We expect settings like: 'android_min_version', 'android_latest_version', etc.
      // Fetch version settings for the specific platform
      // We expect settings like: 'android_min_version', 'android_latest_version', etc.
      const settings = await SystemSetting.find({
        group: { $in: ['app_version', 'maintenance'] },
        isPublic: true,
      });

      const maintenanceSetting = settings.find((s) => s.key === 'maintenance_mode');
      const isMaintenance = maintenanceSetting?.value === true;

      const minVersionKey = `${platform}_min_version`;
      const latestVersionKey = `${platform}_latest_version`;
      const updateUrlKey = `${platform}_update_url`;

      const minVersionSetting = settings.find((s) => s.key === minVersionKey);
      const latestVersionSetting = settings.find((s) => s.key === latestVersionKey);
      const updateUrlSetting = settings.find((s) => s.key === updateUrlKey);

      const minVersion = minVersionSetting ? (minVersionSetting.value as string) : '1.0.0';
      const latestVersion = latestVersionSetting ? (latestVersionSetting.value as string) : '1.0.0';
      const updateUrl = updateUrlSetting ? (updateUrlSetting.value as string) : '';

      const currentVer = version as string;

      // Simple semantic version comparison (assumes x.y.z)
      const isForceUpdateLength = SystemController.compareVersions(currentVer, minVersion) < 0;
      const isUpdateAvailable = SystemController.compareVersions(currentVer, latestVersion) < 0;

      res.status(200).json({
        status: 'success',
        data: {
          forceUpdate: isForceUpdateLength,
          updateAvailable: isUpdateAvailable,
          latestVersion,
          minVersion,
          updateUrl,
          maintenanceMode: isMaintenance,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Utility to compare versions: returns -1 if v1 < v2, 1 if v1 > v2, 0 if equal
  private static compareVersions(v1: string, v2: string): number {
    const v1Parts = v1.split('.').map(Number);
    const v2Parts = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
      const val1 = v1Parts[i] || 0;
      const val2 = v2Parts[i] || 0;

      if (val1 < val2) return -1;
      if (val1 > val2) return 1;
    }
    return 0;
  }

  // Get Public Settings (e.g. Legal URLs, App Info)
  static async getPublicSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const settings = await SystemSetting.find({
        isPublic: true,
      }).select('key value group -_id');

      const formattedSettings = settings.reduce((acc: any, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {});

      res.status(200).json({
        status: 'success',
        data: formattedSettings,
      });
    } catch (error) {
      next(error);
    }
  }

  // Telemetry Proxy for Mobile Logs & Traces (Metrics deprecated)
  static async proxyTelemetry(req: Request, res: Response, next: NextFunction) {
    try {
      const { type } = req.params; // 'traces' or 'logs'

      if (type === 'metrics') {
        return res
          .status(404)
          .json({ success: false, message: 'Metrics endpoint is deprecated. Use traces.' });
      }

      // Handle Logs separately: Direct bridge to Graylog via Winston
      if (type === 'logs') {
        const body = req.body;
        // Expected format: { level: 'info'|'error', message: string, metadata: {} }
        // If it's a list (batch), process each
        const logs = Array.isArray(body) ? body : [body];

        for (const logItem of logs) {
          const level = (logItem.level || 'info').toLowerCase();
          const message = logItem.message || 'Mobile log';
          const meta = {
            ...logItem.metadata,
            platform: logItem.platform || req.headers['x-platform'],
            device: logItem.device || req.headers['x-device-model'],
            appVersion: logItem.appVersion || req.headers['x-app-version'],
            context: 'MobileApp',
          };

          // Use winston to send to Graylog
          // @ts-ignore
          if (logger[level]) {
            // @ts-ignore
            logger[level](`[Mobile] ${message}`, meta);
          } else {
            logger.info(`[Mobile] ${message}`, meta);
          }
        }

        return res.status(200).json({ success: true });
      }

      // Handle OTEL (traces/metrics): Forward to Collector
      const baseUrl = process.env.OTEL_COLLECTOR_BASE_URL || 'http://localhost:4318';
      const collectorUrl = `${baseUrl}/v1/${type}`;

      const headers: any = {
        'Content-Type': req.headers['content-type'] || 'application/x-protobuf',
        'x-forwarded-for': req.ip,
      };

      if (req.headers['content-encoding']) {
        headers['Content-Encoding'] = req.headers['content-encoding'];
      }

      // Fire-and-forget: Return 202 Accepted immediately so mobile app doesn't wait
      res.status(202).json({ success: true, message: 'ACCEPTED' });

      // Process forwarding in background
      axios
        .post(collectorUrl, req.body, {
          headers,
          maxBodyLength: Infinity,
          maxContentLength: Infinity, // 50MB
          responseType: 'arraybuffer',
          timeout: 30000,
        })
        .catch((error) => {
          const errorMessage = error.response
            ? `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`
            : error.message;
          logger.error(`Telemetry Background Error [${type}]: ${errorMessage}`);
        });
    } catch (error: any) {
      // Fallback for immediate synchronous errors (setup phase)
      logger.error(`Telemetry Setup Error [${req.params.type}]: ${error.message}`);
      // Usually we already sent a response, so check headersSent
      if (!res.headersSent) {
        res.status(202).end();
      }
    }
  }
}
