import { BucketAlreadyOwnedByYou, CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createMediaClient, type MediaClientConfig, type S3ProviderConfig } from '../../src';

// Test-only: the package itself never reads process.env, but the tests may.
export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_PORT ?? '9100'}`;
export const BUCKET = process.env.MINIO_BUCKET ?? 'evrree-media-it';

export const s3Config: S3ProviderConfig = {
  type: 's3',
  bucket: BUCKET,
  region: 'us-east-1',
  endpoint: MINIO_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: 'evrree', secretAccessKey: 'evrree-secret' },
};

let bucketReady: Promise<void> | undefined;

export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const s3 = new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint,
      forcePathStyle: true,
      credentials: s3Config.credentials,
    });
    const deadline = Date.now() + 30_000;
    try {
      for (;;) {
        try {
          await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
          return;
        } catch (error) {
          if (error instanceof BucketAlreadyOwnedByYou || (error as Error).name === 'BucketAlreadyExists') return;
          if (Date.now() > deadline) {
            throw new Error(
              `Could not reach MinIO at ${MINIO_ENDPOINT} (${(error as Error).message}). Start it with "pnpm minio:up".`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } finally {
      s3.destroy();
    }
  })();
  return bucketReady;
}

/** A client whose keyPrefix is unique to this run, so test files never see each other's data. */
export function minioClient(overrides: Partial<MediaClientConfig> = {}) {
  return createMediaClient({
    provider: s3Config,
    keyPrefix: `it-${randomUUID().slice(0, 8)}`,
    publicBaseUrl: `${MINIO_ENDPOINT}/${BUCKET}`,
    validation: { maxSizeBytes: 50 * 1024 * 1024 },
    ...overrides,
  });
}

export async function postForm(url: string, fields: Record<string, string>, file: Blob): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', file, 'upload.bin');
  return fetch(url, { method: 'POST', body: form });
}
