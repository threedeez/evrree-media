import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type HeadObjectCommandOutput,
  type PutObjectCommandInput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { pipeline, Readable, Transform } from 'node:stream';
import { abortedError, isAbortError, MediaError } from '../errors';
import { encodeKeyForUrl } from '../keys';
import type { MediaBody, S3ProviderConfig, Visibility } from '../types';
import { isBlob, throwIfAborted, toBuffer, toReadable } from '../util';
import type {
  CopyOptions,
  ListOptions,
  PresignedPostOptions,
  ProviderObject,
  PutOptions,
  SignedGetOptions,
  StorageProvider,
} from './storage-provider';

/** Files larger than this are uploaded with multipart, in parts of this size. */
export const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const DELETE_BATCH_SIZE = 1000;
/** Object metadata entry that records visibility, since ACLs are often disabled or unsupported. */
export const VISIBILITY_METADATA_KEY = 'evrree-visibility';
const HEAD_CONCURRENCY = 10;

/** AWS S3 and anything S3-compatible: Cloudflare R2, DigitalOcean Spaces, MinIO. */
export class S3StorageProvider implements StorageProvider {
  readonly client: S3Client;
  private readonly bucket: string;
  private readonly useAcl: boolean;

  constructor(config: S3ProviderConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.useAcl = config.useAcl ?? false;
    const clientConfig: S3ClientConfig = {
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
      ...(config.credentials ? { credentials: config.credentials } : {}),
      // Third-party S3 implementations (R2, older MinIO, Spaces) reject or ignore the newer
      // CRC checksums the SDK adds by default; only send checksums where S3 demands them.
      ...(config.endpoint
        ? { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }
        : {}),
    };
    this.client = client ?? new S3Client(clientConfig);
  }

  async put(key: string, body: MediaBody, opts: PutOptions): Promise<ProviderObject> {
    throwIfAborted(opts.signal);

    let size = opts.contentLength;
    let uploadBody: Buffer | Readable;
    if (typeof body === 'string' || body instanceof Uint8Array) {
      uploadBody = toBuffer(body);
      size = uploadBody.length;
    } else {
      if (isBlob(body)) size = body.size;
      const counted = countBytes(toReadable(body));
      uploadBody = counted.stream;
      counted.onEnd((total) => (size = total));
    }

    const params: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: key,
      Body: uploadBody,
      ContentType: opts.contentType,
      Metadata: this.toS3Metadata(opts.metadata, opts.visibility),
      ...(opts.cacheControl ? { CacheControl: opts.cacheControl } : {}),
      ...(opts.contentDisposition ? { ContentDisposition: opts.contentDisposition } : {}),
      ...(this.useAcl ? { ACL: aclFor(opts.visibility) } : {}),
    };

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const upload = new Upload({
      client: this.client,
      params,
      partSize: MULTIPART_PART_SIZE_BYTES,
      queueSize: 4,
      leavePartsOnError: false,
      abortController,
    });
    let progressReported = false;
    upload.on('httpUploadProgress', (progress) => {
      progressReported = true;
      opts.onProgress?.({ loadedBytes: progress.loaded ?? 0, totalBytes: progress.total ?? size });
    });

    try {
      const result = await upload.done();
      if (opts.signal?.aborted) throw abortedError();
      const finalSize = size ?? 0;
      if (!progressReported) opts.onProgress?.({ loadedBytes: finalSize, totalBytes: finalSize });
      return {
        key,
        size: finalSize,
        contentType: opts.contentType,
        ...(result.ETag ? { etag: result.ETag } : {}),
        lastModified: new Date(),
        metadata: { ...opts.metadata },
        visibility: opts.visibility,
        ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
        ...(opts.contentDisposition ? { contentDisposition: opts.contentDisposition } : {}),
      };
    } catch (error) {
      if (opts.signal?.aborted) throw abortedError(error);
      throw mapS3Error(error, key);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async get(key: string): Promise<{ body: NodeJS.ReadableStream; object: ProviderObject }> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new MediaError('PROVIDER_ERROR', `S3 returned no body for ${key}`);
      return { body: res.Body as Readable, object: this.fromHead(key, res) };
    } catch (error) {
      throw mapS3Error(error, key);
    }
  }

  async head(key: string): Promise<ProviderObject | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return this.fromHead(key, res);
    } catch (error) {
      const mapped = mapS3Error(error, key);
      if (mapped.code === 'NOT_FOUND') return null;
      throw mapped;
    }
  }

  async delete(keys: string[]): Promise<{ deleted: string[]; failed: { key: string; error: unknown }[] }> {
    const deleted: string[] = [];
    const failed: { key: string; error: unknown }[] = [];
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
      try {
        const res = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const errors = new Map((res.Errors ?? []).map((e) => [e.Key, e]));
        for (const key of batch) {
          const err = errors.get(key);
          if (!err) deleted.push(key);
          else failed.push({ key, error: mapS3Error({ name: err.Code, message: err.Message }, key) });
        }
      } catch (error) {
        const mapped = mapS3Error(error);
        for (const key of batch) failed.push({ key, error: mapped });
      }
    }
    return { deleted, failed };
  }

  async copy(src: string, dest: string, opts: CopyOptions): Promise<ProviderObject> {
    const replace = opts.metadata !== undefined || opts.visibility !== undefined;
    try {
      let source: ProviderObject | null = null;
      // A metadata replace (or an ACL, which CopyObject never carries over) needs the source's
      // current attributes, otherwise S3 resets content type and the like.
      if (replace || this.useAcl) {
        source = await this.head(src);
        if (!source) throw notFound(src);
      }
      const visibility = opts.visibility ?? source?.visibility ?? 'private';
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: dest,
          CopySource: `${this.bucket}/${encodeKeyForUrl(src)}`,
          ...(replace && source
            ? {
                MetadataDirective: 'REPLACE',
                ContentType: source.contentType,
                Metadata: this.toS3Metadata(opts.metadata ?? source.metadata, visibility),
                ...(source.cacheControl ? { CacheControl: source.cacheControl } : {}),
                ...(source.contentDisposition ? { ContentDisposition: source.contentDisposition } : {}),
              }
            : { MetadataDirective: 'COPY' }),
          ...(this.useAcl ? { ACL: aclFor(visibility) } : {}),
        }),
      );
      const copied = await this.head(dest);
      if (!copied) throw new MediaError('PROVIDER_ERROR', `Copied object ${dest} could not be read back`);
      return copied;
    } catch (error) {
      throw mapS3Error(error, src);
    }
  }

  async list(opts: ListOptions): Promise<{ items: ProviderObject[]; nextCursor?: string }> {
    try {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: opts.prefix || undefined,
          MaxKeys: opts.limit,
          ...(opts.cursor ? { ContinuationToken: opts.cursor } : {}),
        }),
      );
      let items: ProviderObject[] = (res.Contents ?? [])
        .filter((entry) => entry.Key)
        .map((entry) => ({
          key: entry.Key!,
          size: entry.Size ?? 0,
          contentType: '',
          ...(entry.ETag ? { etag: entry.ETag } : {}),
          lastModified: entry.LastModified ?? new Date(0),
          metadata: {},
        }));
      if (opts.includeMetadata) {
        const headed = await mapWithConcurrency(items, HEAD_CONCURRENCY, (item) => this.head(item.key));
        items = headed.filter((item): item is ProviderObject => item !== null);
      }
      return res.IsTruncated && res.NextContinuationToken ? { items, nextCursor: res.NextContinuationToken } : { items };
    } catch (error) {
      throw mapS3Error(error);
    }
  }

  async signedGetUrl(key: string, opts: SignedGetOptions): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(opts.contentDisposition ? { ResponseContentDisposition: opts.contentDisposition } : {}),
      });
      return await getSignedUrl(this.client, command, { expiresIn: opts.expiresInSeconds });
    } catch (error) {
      throw mapS3Error(error, key);
    }
  }

  async presignedPost(key: string, opts: PresignedPostOptions): Promise<{ url: string; fields: Record<string, string> }> {
    const fields: Record<string, string> = { 'Content-Type': opts.contentType };
    for (const [name, value] of Object.entries(this.toS3Metadata(opts.metadata, opts.visibility))) {
      fields[`x-amz-meta-${name}`] = value;
    }
    if (opts.contentDisposition) fields['Content-Disposition'] = opts.contentDisposition;
    if (this.useAcl) fields.acl = aclFor(opts.visibility);
    try {
      const { url, fields: signedFields } = await createPresignedPost(this.client, {
        Bucket: this.bucket,
        Key: key,
        Conditions: [
          ['content-length-range', 0, opts.maxSizeBytes],
          ['eq', '$Content-Type', opts.contentType],
        ],
        Fields: fields,
        Expires: opts.expiresInSeconds,
      });
      return { url, fields: signedFields };
    } catch (error) {
      throw mapS3Error(error, key);
    }
  }

  private toS3Metadata(metadata: Record<string, string>, visibility: Visibility): Record<string, string> {
    return { ...metadata, [VISIBILITY_METADATA_KEY]: visibility };
  }

  private fromHead(
    key: string,
    res: Pick<
      HeadObjectCommandOutput,
      'ContentLength' | 'ContentType' | 'ETag' | 'LastModified' | 'Metadata' | 'CacheControl' | 'ContentDisposition'
    >,
  ): ProviderObject {
    const metadata: Record<string, string> = {};
    let visibility: Visibility | undefined;
    for (const [name, value] of Object.entries(res.Metadata ?? {})) {
      const lower = name.toLowerCase();
      if (lower === VISIBILITY_METADATA_KEY) {
        if (value === 'public' || value === 'private') visibility = value;
      } else {
        metadata[lower] = value;
      }
    }
    return {
      key,
      size: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
      ...(res.ETag ? { etag: res.ETag } : {}),
      lastModified: res.LastModified ?? new Date(0),
      metadata,
      ...(visibility ? { visibility } : {}),
      ...(res.CacheControl ? { cacheControl: res.CacheControl } : {}),
      ...(res.ContentDisposition ? { contentDisposition: res.ContentDisposition } : {}),
    };
  }
}

function aclFor(visibility: Visibility): 'public-read' | 'private' {
  return visibility === 'public' ? 'public-read' : 'private';
}

function notFound(key: string): MediaError {
  return new MediaError('NOT_FOUND', `Object not found: ${key}`, { statusCode: 404 });
}

const NOT_FOUND_NAMES = new Set(['NoSuchKey', 'NotFound', 'NoSuchVersion']);
const ACCESS_DENIED_NAMES = new Set([
  'AccessDenied',
  'Forbidden',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AllAccessDisabled',
  'ExpiredToken',
]);

/** Maps any AWS SDK error to a MediaError, keeping the original as `cause`. */
export function mapS3Error(error: unknown, key?: string): MediaError {
  if (error instanceof MediaError) return error;
  if (isAbortError(error)) return abortedError(error);

  const e = (error ?? {}) as {
    name?: string;
    Code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
    $response?: { statusCode?: number };
  };
  const name = e.Code ?? e.name ?? 'UnknownError';
  const statusCode = e.$metadata?.httpStatusCode ?? e.$response?.statusCode;
  const detail = e.message && e.message !== name && e.message !== 'UnknownError' ? `: ${e.message}` : '';
  const options = { cause: error, ...(statusCode !== undefined ? { statusCode } : {}) };
  const subject = key ? ` (${key})` : '';

  if (name === 'NoSuchBucket') {
    return new MediaError('PROVIDER_ERROR', `S3 bucket does not exist${detail}`, options);
  }
  if (NOT_FOUND_NAMES.has(name) || statusCode === 404) {
    return new MediaError('NOT_FOUND', `Object not found${subject}`, options);
  }
  if (ACCESS_DENIED_NAMES.has(name) || statusCode === 403) {
    return new MediaError('ACCESS_DENIED', `Access denied${subject}: S3 ${name}${detail}`, options);
  }
  if (name === 'EntityTooLarge') {
    return new MediaError('FILE_TOO_LARGE', `S3 rejected the upload as too large${subject}`, options);
  }
  return new MediaError('PROVIDER_ERROR', `S3 ${name}${subject}${detail}`, options);
}

function countBytes(source: Readable): { stream: Readable; onEnd: (fn: (total: number) => void) => void } {
  let total = 0;
  let done: ((total: number) => void) | undefined;
  const counter = new Transform({
    writableObjectMode: true,
    transform(chunk: unknown, _encoding, callback) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array) && typeof chunk !== 'string') {
        callback(new MediaError('UPLOAD_FAILED', 'Stream produced a chunk that is not bytes'));
        return;
      }
      const buf = toBuffer(chunk);
      total += buf.length;
      callback(null, buf);
    },
    flush(callback) {
      done?.(total);
      callback();
    },
  });
  pipeline(source, counter, () => undefined);
  return { stream: counter, onEnd: (fn) => (done = fn) };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
