import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

export class StorageService {
  private static s3Client: S3Client;
  private static readonly ENDPOINT = process.env.MINIO_ENDPOINT || 'http://minio:9000';
  private static readonly ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'kauriadmin';
  private static readonly SECRET_KEY = process.env.MINIO_SECRET_KEY || 'kaurisecret';
  private static readonly REGION = process.env.MINIO_REGION || 'us-east-1';
  private static readonly PUBLIC_URL = process.env.MINIO_PUBLIC_URL || StorageService.ENDPOINT;

  /**
   * Initialize S3 Client
   */
  private static getClient(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        endpoint: this.ENDPOINT,
        forcePathStyle: true, // Required for MinIO
        region: this.REGION,
        credentials: {
          accessKeyId: this.ACCESS_KEY,
          secretAccessKey: this.SECRET_KEY,
        },
      });
    }
    return this.s3Client;
  }

  /**
   * Upload a file from local path to MinIO
   */
  static async uploadFile(
    localPath: string,
    bucket: string,
    destinationKey: string,
  ): Promise<string> {
    try {
      const fileStream = fs.createReadStream(localPath);
      const parallelUploads3 = new Upload({
        client: this.getClient(),
        params: {
          Bucket: bucket,
          Key: destinationKey,
          Body: fileStream,
          ACL: 'public-read',
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5, // 5MB
        leavePartsOnError: false,
      });

      await parallelUploads3.done();

      const url = `${this.PUBLIC_URL}/${bucket}/${destinationKey}`;
      logger.info(`[STORAGE] File uploaded to MinIO: ${url}`);
      return url;
    } catch (err: any) {
      logger.error(`[STORAGE] MinIO Upload Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Upload a buffer to MinIO
   */
  static async uploadBuffer(
    buffer: Buffer,
    bucket: string,
    destinationKey: string,
    contentType: string,
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: destinationKey,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      });

      await this.getClient().send(command);

      const url = `${this.PUBLIC_URL}/${bucket}/${destinationKey}`;
      logger.info(`[STORAGE] Buffer uploaded to MinIO: ${url}`);
      return url;
    } catch (err: any) {
      logger.error(`[STORAGE] MinIO Buffer Upload Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate a signed URL for a file
   */
  static async getSignedUrl(
    bucket: string,
    key: string,
    expiresIn: number = 3600,
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      return await getSignedUrl(this.getClient(), command, { expiresIn });
    } catch (err: any) {
      logger.error(`[STORAGE] Signed URL Error: ${err.message}`);
      throw err;
    }
  }
}
