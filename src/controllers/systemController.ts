import { Request, Response, NextFunction } from 'express';
import SystemSetting from '../models/SystemSetting';
import { AppError } from '../middleware/errorHandler';

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
}
