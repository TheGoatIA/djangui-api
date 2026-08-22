import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

type Visibility = 'public' | 'private';

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
   * Ensure a bucket exists, create it if not
   */
  static async ensureBucketExists(bucket: string): Promise<void> {
    const { CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
    try {
      await this.getClient().send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        logger.info(`[STORAGE] Bucket ${bucket} not found, creating it...`);
        await this.getClient().send(new CreateBucketCommand({ Bucket: bucket }));
      } else {
        throw err;
      }
    }
  }

  /**
   * Upload a file from local path to MinIO.
   *
   * @param visibility 'public' (default, preserves existing behaviour for avatars,
   * receipts, invoices, ...) or 'private' — MUST be 'private' for anything containing
   * PII or secrets (KYC documents, database backups): those objects must never be
   * fetchable by an anonymous, unsigned request. The URL returned for a private object
   * is NOT publicly fetchable; use {@link getSignedUrl} or {@link downloadBuffer} to
   * read it back.
   */
  static async uploadFile(
    localPath: string,
    bucket: string,
    destinationKey: string,
    visibility: Visibility = 'public',
  ): Promise<string> {
    try {
      await this.ensureBucketExists(bucket);
      const fileStream = fs.createReadStream(localPath);
      const parallelUploads3 = new Upload({
        client: this.getClient(),
        params: {
          Bucket: bucket,
          Key: destinationKey,
          Body: fileStream,
          ACL: visibility === 'private' ? 'private' : 'public-read',
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5, // 5MB
        leavePartsOnError: false,
      });

      await parallelUploads3.done();

      const url = `${this.PUBLIC_URL}/${bucket}/${destinationKey}`;
      logger.info(`[STORAGE] File uploaded to MinIO (${visibility}): ${url}`);
      return url;
    } catch (err: any) {
      logger.error(`[STORAGE] MinIO Upload Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Upload a buffer to MinIO. See {@link uploadFile} for the `visibility` contract.
   */
  static async uploadBuffer(
    buffer: Buffer,
    bucket: string,
    destinationKey: string,
    contentType: string,
    visibility: Visibility = 'public',
  ): Promise<string> {
    try {
      await this.ensureBucketExists(bucket);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: destinationKey,
        Body: buffer,
        ContentType: contentType,
        ACL: visibility === 'private' ? 'private' : 'public-read',
      });

      await this.getClient().send(command);

      const url = `${this.PUBLIC_URL}/${bucket}/${destinationKey}`;
      logger.info(`[STORAGE] Buffer uploaded to MinIO (${visibility}): ${url}`);
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

  /**
   * Download an object's bytes directly via the S3 SDK (authenticated request), for
   * server-side processing of PRIVATE objects — a plain HTTP GET against the stored
   * URL (as used to work for public-read objects) would be rejected for these.
   */
  static async downloadBuffer(bucket: string, key: string): Promise<Buffer> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await this.getClient().send(command);
    const stream = response.Body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Extract the `{ bucket, key }` this service encoded into a URL previously
   * returned by {@link uploadFile}/{@link uploadBuffer} (`${PUBLIC_URL}/${bucket}/${key}`),
   * so a stored URL can be dereferenced again (e.g. to build a signed URL, or to
   * download a private object) without having to separately persist bucket/key.
   */
  static parseStoredUrl(url: string): { bucket: string; key: string } | null {
    if (!url.startsWith(`${this.PUBLIC_URL}/`)) return null;
    const rest = url.slice(this.PUBLIC_URL.length + 1);
    const firstSlash = rest.indexOf('/');
    if (firstSlash === -1) return null;
    return { bucket: rest.slice(0, firstSlash), key: rest.slice(firstSlash + 1) };
  }
}
