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

  // Telemetry Proxy for Mobile Traces & Metrics
  static async proxyTelemetry(req: Request, res: Response, next: NextFunction) {
    try {
      const { type } = req.params; // 'traces' or 'metrics'

      // Use OTEL_COLLECTOR_BASE_URL if available, otherwise fallback to service name
      // Expected base: http://localhost:4318 or http://otel-collector:4318
      const baseUrl = process.env.OTEL_COLLECTOR_BASE_URL || 'http://localhost:4318';
      const collectorUrl = `${baseUrl}/v1/${type}`;

      // Forward the body to the OTEL collector
      await axios.post(collectorUrl, req.body, {
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/json',
          'x-forwarded-for': req.ip,
        },
        timeout: 5000, // 5s timeout
      });

      res.status(200).end();
    } catch (error: any) {
      const errorMessage = error.response
        ? `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`
        : error.message;

      logger.error(`Telemetry Proxy Error [${req.params.type}]: ${errorMessage}`);

      // We don't want to crash the mobile app, so we return 202 (Accepted but not necessarily processed)
      res.status(202).end();
    }
  }
}
