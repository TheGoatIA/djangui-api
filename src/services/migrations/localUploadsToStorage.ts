import fs from 'node:fs';
import path from 'node:path';
import User from '../../models/User';
import UserChallenge from '../../models/UserChallenge';
import { StorageService } from '../storageService';
import logger from '../../utils/logger';

/**
 * The API versions before 2026-11 stored avatars and receipt images on the
 * container's disk (/app/uploads, bind-mounted from the host) and served them
 * through `express.static('/uploads')` — publicly, receipts included. The
 * current API no longer serves that folder, so every document still pointing
 * at `/uploads/...` must be moved to object storage, or its image breaks:
 *
 *  - avatars  → public bucket `kauri-avatars` (displayable as is)
 *  - receipts → PRIVATE bucket `kauri-uploads` (served through signed URLs)
 *
 * Nothing is ever deleted: local files stay on disk (cleanup is a separate,
 * manual decision once the migration is verified). A referenced file missing
 * on disk is reported and its reference left untouched. Idempotent: migrated
 * documents no longer contain `/uploads/`.
 */
const LOCAL_RE = /^\/?uploads\/(avatars|receipts|voice)\/([^/?#]+)$/;

export interface UploadMigrationReport {
  avatars: { migrated: number; missing: string[] };
  challengeProofs: { migrated: number; missing: string[] };
}

export async function migrateLocalUploads(opts: {
  apply: boolean;
  uploadsDir?: string;
}): Promise<UploadMigrationReport> {
  const dir = opts.uploadsDir ?? path.join(process.cwd(), 'uploads');
  const report: UploadMigrationReport = {
    avatars: { migrated: 0, missing: [] },
    challengeProofs: { migrated: 0, missing: [] },
  };

  /** Uploads one local file; returns the new stored URL, or null if missing. */
  const move = async (ref: string, ownerId: string): Promise<string | null> => {
    const m = LOCAL_RE.exec(ref.trim());
    if (!m) return null;
    const [, kind, name] = m;
    const local = path.join(dir, kind, name);
    if (!fs.existsSync(local)) return null;
    if (!opts.apply) return 'dry-run';
    return kind === 'avatars'
      ? StorageService.uploadFile(local, 'kauri-avatars', `avatars/legacy-${name}`)
      : StorageService.uploadFile(
          local,
          'kauri-uploads',
          `${kind}/${ownerId}/legacy-${name}`,
          'private',
        );
  };

  for (const u of await User.find({ avatar: /^\/?uploads\// }).select('avatar')) {
    const url = await move(u.avatar as string, String(u._id));
    if (!url) {
      report.avatars.missing.push(String(u._id));
      continue;
    }
    report.avatars.migrated++;
    if (opts.apply)
      await User.updateOne({ _id: u._id, avatar: u.avatar }, { $set: { avatar: url } });
  }

  for (const uc of await UserChallenge.find({ 'weeks.proofImageUrl': /^\/?uploads\// })) {
    let changed = false;
    for (const w of uc.weeks as any[]) {
      if (!w.proofImageUrl || !/^\/?uploads\//.test(w.proofImageUrl)) continue;
      const url = await move(w.proofImageUrl, String(uc.userId));
      if (!url) {
        report.challengeProofs.missing.push(`${uc._id}#${w.weekNumber}`);
        continue;
      }
      report.challengeProofs.migrated++;
      if (opts.apply) {
        w.proofImageUrl = url;
        changed = true;
      }
    }
    if (changed) await uc.save();
  }

  logger.info(`[Migration] local uploads → storage: ${JSON.stringify(report)}`);
  return report;
}
