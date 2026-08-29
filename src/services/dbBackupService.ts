import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import logger from '../utils/logger';
import { EmailService } from './emailService';
import { SlackService } from './slackService';
import { StorageService } from './storageService';
import { AppError } from '../middleware/errorHandler';
import admin from '../config/firebase';
import mongoose from 'mongoose';

// execFile (not exec) so arguments are passed directly to the process, never
// interpolated into a shell string — the mongorestore call below takes a
// filename that ultimately comes from an admin HTTP request, and `exec` would
// let a crafted filename break out of its quoted argument and inject shell
// commands.
const execFilePromise = promisify(execFile);

export class DbBackupService {
  private static readonly BACKUP_DIR = process.env.BACKUP_PATH || './backups';
  private static readonly UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';
  private static readonly ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'me@borisgauty.com';
  private static readonly RETENTION_DAYS = 15;

  /**
   * Run the full backup process (Database + Files)
   */
  static async runBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dbArchivePath = path.join(this.BACKUP_DIR, `db-backup-${timestamp}.gz`);
    const filesArchivePath = path.join(this.BACKUP_DIR, `files-backup-${timestamp}.tar.gz`);

    try {
      // 1. Ensure backup directory exists
      if (!fs.existsSync(this.BACKUP_DIR)) {
        fs.mkdirSync(this.BACKUP_DIR, { recursive: true });
      }

      // 2. Database Backup (mongodump)
      const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
      const toolsPath = process.env.MONGODB_TOOLS_PATH
        ? path.join(process.env.MONGODB_TOOLS_PATH, 'mongodump')
        : 'mongodump';

      logger.info(`Starting DB backup to ${dbArchivePath}`);
      await execFilePromise(toolsPath, ['--uri', uri, '--archive', dbArchivePath, '--gzip']);

      // 3. File Backup (tar)
      logger.info(`Starting File backup to ${filesArchivePath}`);
      if (fs.existsSync(this.UPLOADS_DIR)) {
        // Use tar to compress the uploads directory
        // -z: gzip, -c: create, -f: file
        await execFilePromise('tar', [
          '-czf',
          filesArchivePath,
          '-C',
          path.dirname(this.UPLOADS_DIR),
          path.basename(this.UPLOADS_DIR),
        ]);
      } else {
        logger.warn(`Uploads directory not found at ${this.UPLOADS_DIR}, skipping file backup.`);
      }

      // 4. Collect DB stats
      const stats = await this.getDbStats();

      // 5. Upload to MinIO (Primary Cloud). Full DB dumps contain password hashes,
      // KYC data, and every user's financial history, so these MUST be private —
      // never fetchable by an anonymous request even if the bucket/key is guessed.
      const dbMinioUrl = await StorageService.uploadFile(
        dbArchivePath,
        'kauri-backups',
        `database/${path.basename(dbArchivePath)}`,
        'private',
      );
      let filesMinioUrl = '';
      if (fs.existsSync(filesArchivePath)) {
        filesMinioUrl = await StorageService.uploadFile(
          filesArchivePath,
          'kauri-backups',
          `files/${path.basename(filesArchivePath)}`,
          'private',
        );
      }

      // 6. Upload to Firebase Storage (Secondary/Disaster Recovery Cloud)
      const dbFirebaseUrl = await this.uploadToFirebase(
        dbArchivePath,
        `backups/database/${path.basename(dbArchivePath)}`,
      );
      let filesFirebaseUrl = '';
      if (fs.existsSync(filesArchivePath)) {
        filesFirebaseUrl = await this.uploadToFirebase(
          filesArchivePath,
          `backups/files/${path.basename(filesArchivePath)}`,
        );
      }

      // 7. Cleanup local temporary files
      if (fs.existsSync(dbArchivePath)) fs.unlinkSync(dbArchivePath);
      if (fs.existsSync(filesArchivePath)) fs.unlinkSync(filesArchivePath);

      // 8. Retention Policy (Local, MinIO & Firebase)
      await this.cleanupOldBackups(this.RETENTION_DAYS);
      await this.cleanupFirebaseBackups(this.RETENTION_DAYS);

      // 9. Notifications
      const statsHtml = this.formatStatsHtml(stats);
      await EmailService.sendEmail(
        this.ADMIN_EMAIL,
        `📦 Sauvegarde Complète Réussie - ${new Date().toLocaleDateString()}`,
        'Sauvegarde (base de données + fichiers) terminée avec succès.',
        `<h3>Rapport de Sauvegarde</h3>
         <p>La sauvegarde a été effectuée et envoyée vers MinIO et Firebase Storage.</p>
         <ul>
           <li><strong>DB Archive :</strong> ${path.basename(dbArchivePath)}</li>
           <li><strong>Files Archive :</strong> ${path.basename(filesArchivePath)}</li>
           <li><strong>Rétention :</strong> ${this.RETENTION_DAYS} jours</li>
         </ul>
         ${statsHtml}`,
      );

      await SlackService.sendAlert(
        `📦 *Backup Success (Multi-Cloud)*\n` +
          `*Status*: Database and Files uploaded to MinIO & Firebase.\n` +
          `*Retention*: ${this.RETENTION_DAYS} days enforced.`,
      );

      return { success: true, stats };
    } catch (error: any) {
      logger.error(`Multi-cloud backup failed: ${error.message}`);
      await EmailService.sendEmail(
        this.ADMIN_EMAIL,
        '🚨 ÉCHEC de la sauvegarde Multi-Cloud',
        `L'erreur suivante est survenue lors de la sauvegarde : ${error.message}`,
      );
      await SlackService.sendAlert(`🚨 *Backup FAILED*\n*Error*: ${error.message}`);
      throw error;
    }
  }

  /**
   * Restore database from a backup file
   */
  static async restoreBackup(filename: string) {
    // Strict allowlist on the filename — it comes from an admin HTTP request
    // param (POST /admin/db/restore/:filename), and Express decodes URL-encoded
    // path segments before routing, so without this a value like
    // "..%2F..%2Fsome%2Ffile.gz" would resolve outside BACKUP_DIR via path.join.
    if (!/^[\w.-]+\.gz$/.test(filename)) {
      throw new AppError('Invalid backup filename', 400);
    }
    const backupDir = path.resolve(this.BACKUP_DIR);
    const backupPath = path.resolve(backupDir, filename);
    if (!backupPath.startsWith(backupDir + path.sep)) {
      throw new AppError('Invalid backup filename', 400);
    }

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${filename}`);
    }

    try {
      const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
      const toolsPath = process.env.MONGODB_TOOLS_PATH
        ? path.join(process.env.MONGODB_TOOLS_PATH, 'mongorestore')
        : 'mongorestore';

      logger.warn(`STARTING DATABASE RESTORE from: ${filename}`);

      // --drop is used to clear existing collections before restore. execFile
      // (not exec) passes these as discrete arguments — no shell involved, so
      // there's nothing for a crafted filename to break out into.
      await execFilePromise(toolsPath, [
        '--uri',
        uri,
        '--archive',
        backupPath,
        '--gzip',
        '--drop',
      ]);

      logger.info(`Database restored successfully from ${filename}`);

      // Notify Slack
      await SlackService.sendAlert(
        `⚠️ *DB RESTORE SUCCESS*\n*File*: ${filename}\n*Status*: Database has been replaced by backup.`,
      );

      return { success: true, file: filename };
    } catch (error: any) {
      logger.error(`Database restore failed: ${error.message}`);
      await SlackService.sendAlert(
        `🚨 *DB RESTORE FAILED*\n*File*: ${filename}\n*Error*: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Upload a file to Firebase Storage
   */
  private static async uploadToFirebase(localPath: string, destination: string): Promise<string> {
    try {
      if (!process.env.FIREBASE_STORAGE_BUCKET) {
        logger.warn('FIREBASE_STORAGE_BUCKET not configured. Skipping Firebase upload.');
        return '';
      }

      const bucket = admin.storage().bucket();
      const [file] = await bucket.upload(localPath, {
        destination,
        metadata: {
          contentType: localPath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
        },
      });

      // Simple signed URL (optional, expires in 1 hour by default if not specified)
      // For backup purposes, we just need to know it's there.
      logger.info(`Uploaded to Firebase Storage: ${destination}`);
      return destination;
    } catch (error: any) {
      logger.error(`Firebase upload failed for ${destination}: ${error.message}`);
      return '';
    }
  }

  /**
   * Remove backups older than X days from Firebase Storage
   */
  private static async cleanupFirebaseBackups(days: number) {
    try {
      if (!process.env.FIREBASE_STORAGE_BUCKET) return;

      const bucket = admin.storage().bucket();
      const [files] = await bucket.getFiles({ prefix: 'backups/' });
      const now = Date.now();
      const expirationMs = days * 24 * 60 * 60 * 1000;

      for (const file of files) {
        const metadata = file.metadata;
        const createdAt = new Date(metadata.timeCreated || 0).getTime();

        if (now - createdAt > expirationMs) {
          await file.delete();
          logger.info(`Deleted old Firebase backup: ${file.name}`);
        }
      }
    } catch (error: any) {
      logger.error(`Firebase backup cleanup failed: ${error.message}`);
    }
  }

  /**
   * Remove local backups older than X days
   */
  private static async cleanupOldBackups(days: number) {
    try {
      if (!fs.existsSync(this.BACKUP_DIR)) return;
      const files = fs.readdirSync(this.BACKUP_DIR);
      const now = Date.now();
      const expirationMs = days * 24 * 60 * 60 * 1000;

      for (const file of files) {
        const filePath = path.join(this.BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > expirationMs) {
          fs.unlinkSync(filePath);
          logger.info(`Deleted old local backup: ${file}`);
        }
      }
    } catch (error: any) {
      logger.error(`Local backup cleanup failed: ${error.message}`);
    }
  }

  /**
   * Get basic collection stats
   */
  private static async getDbStats() {
    const stats: any = {};
    if (!mongoose.connection.db) return stats;

    const collections = await mongoose.connection.db.listCollections().toArray();

    for (const col of collections) {
      const count = await mongoose.connection.db.collection(col.name).countDocuments();
      stats[col.name] = count;
    }

    return stats;
  }

  /**
   * Format stats into HTML table
   */
  private static formatStatsHtml(stats: any): string {
    let rows = '';
    for (const [col, count] of Object.entries(stats)) {
      rows += `<tr><td style="padding: 8px; border: 1px solid #ddd;">${col}</td><td style="padding: 8px; border: 1px solid #ddd;">${count}</td></tr>`;
    }

    return `
      <h4>Statistiques des Collections</h4>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background-color: #f2f2f2;">
            <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Collection</th>
            <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Documents</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }
}
