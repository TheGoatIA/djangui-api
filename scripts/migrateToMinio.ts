import fs from 'fs';
import path from 'path';
import { StorageService } from '../src/services/storageService';
import logger from '../src/utils/logger';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Migration Utility: Local Uploads -> MinIO
 */
async function migrate() {
    const uploadBaseDir = path.join(process.cwd(), 'uploads');

    if (!fs.existsSync(uploadBaseDir)) {
        console.log('No uploads directory found. Nothing to migrate.');
        return;
    }

    console.log('🚀 Starting Migration: Local -> MinIO...');

    const categories = [
        { dir: 'avatars', bucket: 'kauri-uploads', prefix: 'avatars/' },
        { dir: 'receipts', bucket: 'kauri-uploads', prefix: 'receipts/' },
        { dir: 'invoices', bucket: 'kauri-invoices', prefix: 'invoices/' },
    ];

    for (const cat of categories) {
        const fullPath = path.join(uploadBaseDir, cat.dir);
        if (!fs.existsSync(fullPath)) continue;

        const files = fs.readdirSync(fullPath);
        console.log(`\n📁 Category: ${cat.dir} (${files.length} files)`);

        for (const file of files) {
            const filePath = path.join(fullPath, file);
            if (fs.lstatSync(filePath).isDirectory()) continue;

            try {
                const destinationKey = `${cat.prefix}${file}`;
                await StorageService.uploadFile(filePath, cat.bucket, destinationKey);
                console.log(`✅ Migrated: ${file}`);
            } catch (err: any) {
                console.error(`❌ Failed: ${file} - ${err.message}`);
            }
        }
    }

    console.log('\n✨ Migration Complete!');
    console.log('Note: Local files have been copied to MinIO. You can safely delete the ./uploads folder once you have verified the migration.');
}

migrate().catch(err => {
    console.error('Fatal Migration Error:', err);
    process.exit(1);
});
