import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import logger from '../utils/logger';
import { EmailService } from './emailService';
import { SlackService } from './slackService';
import mongoose from 'mongoose';

const execPromise = promisify(exec);

export class DbBackupService {
  private static readonly BACKUP_DIR = process.env.BACKUP_PATH || './backups';
  private static readonly ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'me@borisgauty.com';

  /**
   * Run the full backup process
   */
  static async runBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}`;
    const backupFolder = path.join(this.BACKUP_DIR, backupName);
    const archivePath = `${backupFolder}.gz`;

    try {
      // 1. Ensure backup directory exists
      if (!fs.existsSync(this.BACKUP_DIR)) {
        fs.mkdirSync(this.BACKUP_DIR, { recursive: true });
      }

      // 2. Run mongodump
      const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
      logger.info(`Starting DB backup: ${backupName}`);

      // Command: mongodump --uri="<uri>" --archive="<path>" --gzip
      const toolsPath = process.env.MONGODB_TOOLS_PATH
        ? path.join(process.env.MONGODB_TOOLS_PATH, 'mongodump')
        : 'mongodump';
      await execPromise(`"${toolsPath}" --uri="${uri}" --archive="${archivePath}" --gzip`);

      logger.info(`Backup created successfully at ${archivePath}`);

      // 3. Collect DB stats
      const stats = await this.getDbStats();

      // 4. Send email with stats and attachment
      // Note: We need to modify EmailService to support attachments if we want to send the file itself.
      // For now, let's send the stats and a notification that backup is saved.
      // IF EmailService doesn't support attachments, we'll need to update it.

      const statsHtml = this.formatStatsHtml(stats);
      await EmailService.sendEmail(
        this.ADMIN_EMAIL,
        `📦 Sauvegarde Automatique BD - ${new Date().toLocaleDateString()}`,
        'Sauvegarde terminée avec succès.',
        `<h3>Rapport de Sauvegarde</h3>
         <p>La sauvegarde de la base de données a été effectuée et stockée sur le serveur.</p>
         <p><strong>Fichier :</strong> ${path.basename(archivePath)}</p>
         ${statsHtml}`,
      );

      // Notify Slack
      await SlackService.sendNotification(
        `📦 *DB Backup Success*\n*File*: ${path.basename(archivePath)}\n*Status*: Completed and saved.`,
      );

      // 5. Cleanup old backups (15 days)
      await this.cleanupOldBackups(15);

      return { success: true, path: archivePath, stats };
    } catch (error: any) {
      logger.error(`Database backup failed: ${error.message}`);
      await EmailService.sendEmail(
        this.ADMIN_EMAIL,
        '🚨 ÉCHEC de la sauvegarde BD',
        `L'erreur suivante est survenue lors de la sauvegarde : ${error.message}`,
      );

      // Notify Slack
      await SlackService.sendNotification(`🚨 *DB Backup FAILED*\n*Error*: ${error.message}`);

      throw error;
    }
  }

  /**
   * Restore database from a backup file
   */
  static async restoreBackup(filename: string) {
    const backupPath = path.join(this.BACKUP_DIR, filename);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${filename}`);
    }

    try {
      const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
      const toolsPath = process.env.MONGODB_TOOLS_PATH
        ? path.join(process.env.MONGODB_TOOLS_PATH, 'mongorestore')
        : 'mongorestore';

      logger.warn(`STARTING DATABASE RESTORE from: ${filename}`);

      // Command: mongorestore --uri="<uri>" --archive="<path>" --gzip --drop
      // --drop is used to clear existing collections before restore
      await execPromise(`"${toolsPath}" --uri="${uri}" --archive="${backupPath}" --gzip --drop`);

      logger.info(`Database restored successfully from ${filename}`);

      // Notify Slack
      await SlackService.sendNotification(
        `⚠️ *DB RESTORE SUCCESS*\n*File*: ${filename}\n*Status*: Database has been replaced by backup.`,
      );

      return { success: true, file: filename };
    } catch (error: any) {
      logger.error(`Database restore failed: ${error.message}`);
      await SlackService.sendNotification(
        `🚨 *DB RESTORE FAILED*\n*File*: ${filename}\n*Error*: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Remove backups older than X days
   */
  private static async cleanupOldBackups(days: number) {
    try {
      const files = fs.readdirSync(this.BACKUP_DIR);
      const now = Date.now();
      const expirationMs = days * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.gz')) continue;

        const filePath = path.join(this.BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMs = now - stats.mtimeMs;

        if (ageMs > expirationMs) {
          fs.unlinkSync(filePath);
          logger.info(
            `Deleted old backup: ${file} (Age: ${Math.round(ageMs / (24 * 3600000))} days)`,
          );
        }
      }
    } catch (error: any) {
      logger.error(`Backup cleanup failed: ${error.message}`);
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
