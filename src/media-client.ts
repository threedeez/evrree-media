import { MediaError, toMediaError } from './errors';
import { applyKeyPrefix, assertValidKey, encodeKeyForUrl, generateKey, joinKey, normalizePrefix } from './keys';
import { LocalStorageProvider } from './providers/local.provider';
import { MemoryStorageProvider } from './providers/memory.provider';
import { S3StorageProvider } from './providers/s3.provider';
import type { ProviderObject, StorageProvider } from './providers/storage-provider';
import type {
  DeleteManyResult,
  GetSignedUrlOptions,
  ListResult,
  MediaClientConfig,
  MediaCopyOptions,
  MediaListOptions,
  MediaLogger,
  MediaObject,
  PresignedUpload,
  PresignedUploadOptions,
  ProviderConfig,
  UpdateMetadataOptions,
  UploadInput,
  Visibility,
} from './types';
import { contentDisposition, normalizeMetadata, prepareBody, readAll, throwIfAborted } from './util';
import {
  assertContentSignature,
  assertContentType,
  DEFAULT_MAX_SIZE_BYTES,
  normalizeContentType,
  SIGNATURE_PEEK_BYTES,
} from './validation';

export const MAX_SIGNED_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 15 * 60;
export const DEFAULT_PRESIGNED_UPLOAD_EXPIRY_SECONDS = 5 * 60;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;
export const DELETE_MANY_BATCH_SIZE = 1000;

interface ResolvedConfig {
  publicBaseUrl?: string;
  defaultVisibility: Visibility;
  keyPrefix: string;
  maxSizeBytes: number;
  allowedMimeTypes?: string[];
  verifyContentSignature: boolean;
  signedUrlExpiresInSeconds: number;
  logger?: MediaLogger;
}

type LogLevel = keyof MediaLogger;

/**
 * The one object apps use for storage. Create it with createMediaClient(); every method
 * validates its input, and every failure is a MediaError.
 */
export class MediaClient {
  readonly provider: StorageProvider;
  private readonly config: ResolvedConfig;

  constructor(config: MediaClientConfig) {
    this.config = resolveConfig(config);
    this.provider = createProvider(config.provider, this.config.logger);
  }

  /** The configured key prefix ('' when none). */
  get keyPrefix(): string {
    return this.config.keyPrefix;
  }

  /** Validates, then uploads. Bodies over 8 MB use multipart upload on S3. */
  async upload(input: UploadInput): Promise<MediaObject> {
    return this.run('upload', async () => {
      if (!input || typeof input !== 'object') throw new MediaError('UPLOAD_FAILED', 'upload() needs an input object');
      throwIfAborted(input.signal);
      if (typeof input.fileName !== 'string' || input.fileName.trim() === '') {
        throw new MediaError('UPLOAD_FAILED', 'fileName is required');
      }
      assertContentType(input.contentType, this.config.allowedMimeTypes);
      const visibility = this.resolveVisibility(input.visibility);
      const metadata = normalizeMetadata(input.metadata);
      const key = input.key
        ? this.newKey(input.key)
        : generateKey({ fileName: input.fileName, folder: input.folder, prefix: this.config.keyPrefix });

      const prepared = await prepareBody(input.body, {
        maxSizeBytes: this.config.maxSizeBytes,
        peekBytes: SIGNATURE_PEEK_BYTES,
        signal: input.signal,
      });
      if (this.config.verifyContentSignature) assertContentSignature(input.contentType, prepared.head);
      throwIfAborted(input.signal);

      this.log('debug', 'media.upload.start', { key, size: prepared.size, contentType: input.contentType });
      const stored = await this.provider.put(key, prepared.body, {
        contentType: input.contentType,
        ...(prepared.size !== undefined ? { contentLength: prepared.size } : {}),
        visibility,
        metadata,
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
        contentDisposition: contentDisposition('inline', input.fileName),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const object = this.toMediaObject(stored, visibility);
      this.log('info', 'media.upload.done', { key: object.key, size: object.size, contentType: object.contentType });
      return object;
    });
  }

  /** Creates a presigned POST so a browser can upload straight to storage. */
  async createPresignedUpload(opts: PresignedUploadOptions): Promise<PresignedUpload> {
    return this.run('createPresignedUpload', async () => {
      if (!opts || typeof opts.fileName !== 'string' || opts.fileName.trim() === '') {
        throw new MediaError('UPLOAD_FAILED', 'fileName is required');
      }
      assertContentType(opts.contentType, this.config.allowedMimeTypes);
      const maxSizeBytes = opts.maxSizeBytes ?? this.config.maxSizeBytes;
      if (!isPositiveInteger(maxSizeBytes)) {
        throw new MediaError('CONFIG_ERROR', 'maxSizeBytes must be a positive integer');
      }
      if (maxSizeBytes > this.config.maxSizeBytes) {
        throw new MediaError(
          'FILE_TOO_LARGE',
          `maxSizeBytes (${maxSizeBytes}) exceeds the configured limit of ${this.config.maxSizeBytes} bytes`,
        );
      }
      const expiresInSeconds = this.expiry(opts.expiresInSeconds, DEFAULT_PRESIGNED_UPLOAD_EXPIRY_SECONDS);
      const visibility = this.resolveVisibility(opts.visibility);
      const key = opts.key
        ? this.newKey(opts.key)
        : generateKey({ fileName: opts.fileName, folder: opts.folder, prefix: this.config.keyPrefix });

      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
      const { url, fields } = await this.provider.presignedPost(key, {
        contentType: opts.contentType,
        maxSizeBytes,
        expiresInSeconds,
        visibility,
        metadata: normalizeMetadata(opts.metadata),
        contentDisposition: contentDisposition('inline', opts.fileName),
      });
      this.log('info', 'media.presignedUpload.created', { key, contentType: opts.contentType, maxSizeBytes });
      return { key, url, method: 'POST', fields, expiresAt, maxSizeBytes };
    });
  }

  /** Temporary read URL, for private files. */
  async getSignedUrl(key: string, opts: GetSignedUrlOptions = {}): Promise<string> {
    return this.run('getSignedUrl', async () => {
      assertValidKey(key);
      const expiresInSeconds = this.expiry(opts.expiresInSeconds, this.config.signedUrlExpiresInSeconds);
      const disposition =
        opts.downloadFileName !== undefined || opts.inline !== undefined
          ? contentDisposition(opts.inline ? 'inline' : 'attachment', opts.downloadFileName)
          : undefined;
      const url = await this.provider.signedGetUrl(key, {
        expiresInSeconds,
        ...(disposition ? { contentDisposition: disposition } : {}),
      });
      this.log('debug', 'media.signedUrl.created', { key, expiresInSeconds });
      return url;
    }, key);
  }

  /** `${publicBaseUrl}/${key}`. Throws CONFIG_ERROR when publicBaseUrl is not configured. */
  getPublicUrl(key: string): string {
    assertValidKey(key);
    if (!this.config.publicBaseUrl) {
      throw new MediaError('CONFIG_ERROR', 'publicBaseUrl is not configured, so public URLs cannot be built');
    }
    return `${this.config.publicBaseUrl}/${encodeKeyForUrl(key)}`;
  }

  /** Download as a stream, e.g. to proxy through an API. */
  async getStream(key: string): Promise<{ body: NodeJS.ReadableStream; object: MediaObject }> {
    return this.run('getStream', async () => {
      assertValidKey(key);
      const { body, object } = await this.provider.get(key);
      return { body, object: this.toMediaObject(object) };
    }, key);
  }

  /** Download fully into memory. Refuses files over maxSizeBytes with FILE_TOO_LARGE. */
  async getBuffer(key: string): Promise<{ body: Buffer; object: MediaObject }> {
    return this.run('getBuffer', async () => {
      assertValidKey(key);
      const { body, object } = await this.provider.get(key);
      if (object.size > this.config.maxSizeBytes) {
        destroyStream(body);
        throw new MediaError(
          'FILE_TOO_LARGE',
          `Object is ${object.size} bytes; getBuffer is limited to ${this.config.maxSizeBytes} bytes. Use getStream instead.`,
        );
      }
      try {
        const buffer = await readAll(body, { maxSizeBytes: this.config.maxSizeBytes });
        return { body: buffer, object: this.toMediaObject(object) };
      } catch (error) {
        destroyStream(body);
        throw error;
      }
    }, key);
  }

  /** Metadata only. Resolves null when the key does not exist. */
  async head(key: string): Promise<MediaObject | null> {
    return this.run('head', async () => {
      assertValidKey(key);
      const object = await this.provider.head(key);
      return object ? this.toMediaObject(object) : null;
    }, key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /** Deletes a file. Deleting a missing key succeeds. */
  async delete(key: string): Promise<void> {
    return this.run('delete', async () => {
      assertValidKey(key);
      const result = await this.provider.delete([key]);
      const failure = result.failed[0];
      if (failure) throw toMediaError(failure.error);
      this.log('info', 'media.delete.done', { key });
    }, key);
  }

  /** Batch delete in groups of 1000. Never throws for individual failures. */
  async deleteMany(keys: string[]): Promise<DeleteManyResult> {
    const deleted: string[] = [];
    const failed: DeleteManyResult['failed'] = [];
    const valid: string[] = [];
    for (const key of Array.isArray(keys) ? keys : []) {
      try {
        assertValidKey(key);
        valid.push(key);
      } catch (error) {
        failed.push({ key, error: toMediaError(error) });
      }
    }
    for (let i = 0; i < valid.length; i += DELETE_MANY_BATCH_SIZE) {
      const batch = valid.slice(i, i + DELETE_MANY_BATCH_SIZE);
      try {
        const result = await this.provider.delete(batch);
        deleted.push(...result.deleted);
        for (const failure of result.failed) failed.push({ key: failure.key, error: toMediaError(failure.error) });
      } catch (error) {
        const mapped = toMediaError(error);
        for (const key of batch) failed.push({ key, error: mapped });
      }
    }
    this.log(failed.length ? 'warn' : 'info', 'media.deleteMany.done', {
      deleted: deleted.length,
      failed: failed.length,
    });
    return { deleted, failed };
  }

  /** Server-side copy. `opts` may replace the destination's visibility and metadata. */
  async copy(sourceKey: string, destKey: string, opts: MediaCopyOptions = {}): Promise<MediaObject> {
    return this.run('copy', async () => {
      assertValidKey(sourceKey);
      const dest = this.newKey(destKey);
      const copied = await this.provider.copy(sourceKey, dest, {
        ...(opts.visibility !== undefined ? { visibility: this.resolveVisibility(opts.visibility) } : {}),
        ...(opts.metadata !== undefined ? { metadata: normalizeMetadata(opts.metadata) } : {}),
      });
      this.log('info', 'media.copy.done', { sourceKey, destKey: dest });
      return this.toMediaObject(copied);
    }, sourceKey);
  }

  /** Copy, then delete the source. If the delete fails the error is thrown but the copy is kept. */
  async move(sourceKey: string, destKey: string): Promise<MediaObject> {
    const copied = await this.copy(sourceKey, destKey);
    if (copied.key === sourceKey) return copied;
    try {
      await this.delete(sourceKey);
    } catch (error) {
      const mapped = toMediaError(error);
      throw new MediaError(
        mapped.code,
        `Copied ${sourceKey} to ${copied.key} but could not delete the source: ${mapped.message}`,
        { cause: mapped, ...(mapped.statusCode !== undefined ? { statusCode: mapped.statusCode } : {}) },
      );
    }
    return copied;
  }

  /** Lists files under keyPrefix (and `prefix`, relative to it), a page at a time. */
  async list(opts: MediaListOptions = {}): Promise<ListResult> {
    return this.run('list', async () => {
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
      if (!Number.isFinite(limit)) throw new MediaError('CONFIG_ERROR', 'limit must be a number');
      const prefix = this.listPrefix(opts.prefix);
      const result = await this.provider.list({
        prefix,
        limit,
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        ...(opts.includeMetadata ? { includeMetadata: true } : {}),
      });
      return {
        items: result.items.map((item) => this.toMediaObject(item)),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    });
  }

  /** Replaces a file's metadata (and optionally its visibility) in place. */
  async updateMetadata(
    key: string,
    metadata: Record<string, string>,
    opts: UpdateMetadataOptions = {},
  ): Promise<MediaObject> {
    return this.run('updateMetadata', async () => {
      assertValidKey(key);
      const updated = await this.provider.copy(key, key, {
        metadata: normalizeMetadata(metadata),
        ...(opts.visibility !== undefined ? { visibility: this.resolveVisibility(opts.visibility) } : {}),
      });
      this.log('info', 'media.updateMetadata.done', { key });
      return this.toMediaObject(updated);
    }, key);
  }

  /** A key for a new object: validated, with keyPrefix applied exactly once. */
  private newKey(key: string): string {
    assertValidKey(key);
    const full = applyKeyPrefix(joinKey(key), this.config.keyPrefix);
    assertValidKey(full);
    return full;
  }

  private listPrefix(prefix: string | undefined): string {
    const keyPrefix = this.config.keyPrefix;
    if (prefix === undefined || prefix === '') return keyPrefix ? `${keyPrefix}/` : '';
    if (prefix.startsWith('/') || prefix.includes('..') || prefix.includes('\\')) {
      throw new MediaError('INVALID_KEY', 'prefix must not start with "/" or contain ".." or "\\"');
    }
    if (!keyPrefix) return prefix;
    if (prefix === keyPrefix) return `${keyPrefix}/`;
    return prefix.startsWith(`${keyPrefix}/`) ? prefix : `${keyPrefix}/${prefix}`;
  }

  private resolveVisibility(visibility: Visibility | undefined): Visibility {
    const resolved = visibility ?? this.config.defaultVisibility;
    if (resolved !== 'public' && resolved !== 'private') {
      throw new MediaError('CONFIG_ERROR', `visibility must be "public" or "private", got "${String(resolved)}"`);
    }
    return resolved;
  }

  private expiry(value: number | undefined, fallback: number): number {
    const seconds = value ?? fallback;
    if (!isPositiveInteger(seconds) || seconds > MAX_SIGNED_URL_EXPIRY_SECONDS) {
      throw new MediaError(
        'CONFIG_ERROR',
        `expiresInSeconds must be a whole number between 1 and ${MAX_SIGNED_URL_EXPIRY_SECONDS} (7 days)`,
      );
    }
    return seconds;
  }

  private toMediaObject(object: ProviderObject, knownVisibility?: Visibility): MediaObject {
    const visibility = object.visibility ?? knownVisibility ?? this.config.defaultVisibility;
    const result: MediaObject = {
      key: object.key,
      size: object.size,
      contentType: object.contentType,
      visibility,
      metadata: { ...object.metadata },
      lastModified: object.lastModified,
    };
    if (object.etag) result.etag = object.etag;
    if (visibility === 'public' && this.config.publicBaseUrl) result.url = this.getPublicUrl(object.key);
    return result;
  }

  private async run<T>(operation: string, fn: () => Promise<T>, key?: string): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const mapped = toMediaError(error);
      const quiet = mapped.code === 'NOT_FOUND' || mapped.code === 'ABORTED';
      // Only the operation, key and error code: never bodies, URLs, fields or credentials.
      this.log(quiet ? 'debug' : 'warn', `media.${operation}.failed`, {
        ...(key !== undefined ? { key } : {}),
        code: mapped.code,
        ...(mapped.statusCode !== undefined ? { statusCode: mapped.statusCode } : {}),
      });
      throw mapped;
    }
  }

  private log(level: LogLevel, message: string, context: Record<string, unknown>): void {
    const logger = this.config.logger;
    const fn = logger?.[level];
    if (typeof fn !== 'function') return;
    try {
      fn.call(logger, message, context);
    } catch {
      // A broken logger must never break storage operations.
    }
  }
}

/** Validates the config (throwing CONFIG_ERROR naming the bad field) and creates a client. */
export function createMediaClient(config: MediaClientConfig): MediaClient {
  return new MediaClient(config);
}

function configError(field: string, problem: string): MediaError {
  return new MediaError('CONFIG_ERROR', `Invalid media config: ${field} ${problem}`);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertHttpUrl(field: string, value: unknown): string {
  if (!isNonEmptyString(value)) throw configError(field, 'must be a non-empty URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(field, `must be a valid URL, got "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw configError(field, 'must be an http(s) URL');
  return value.replace(/\/+$/, '');
}

function resolveConfig(config: MediaClientConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') throw configError('config', 'must be an object');
  validateProvider(config.provider);

  const defaultVisibility = config.defaultVisibility ?? 'private';
  if (defaultVisibility !== 'private' && defaultVisibility !== 'public') {
    throw configError('defaultVisibility', 'must be "private" or "public"');
  }

  let publicBaseUrl =
    config.publicBaseUrl !== undefined ? assertHttpUrl('publicBaseUrl', config.publicBaseUrl) : undefined;
  // Files the local handler serves are reachable at its baseUrl, so that is the natural default.
  if (publicBaseUrl === undefined && config.provider.type === 'local') {
    publicBaseUrl = config.provider.baseUrl.replace(/\/+$/, '');
  }
  if (defaultVisibility === 'public' && !publicBaseUrl) {
    throw configError('publicBaseUrl', 'is required when defaultVisibility is "public"');
  }

  let keyPrefix = '';
  if (config.keyPrefix !== undefined) {
    if (typeof config.keyPrefix !== 'string') throw configError('keyPrefix', 'must be a string');
    keyPrefix = normalizePrefix(config.keyPrefix);
    if (keyPrefix) {
      try {
        assertValidKey(keyPrefix);
      } catch (error) {
        throw configError('keyPrefix', `is not a valid key prefix (${(error as Error).message})`);
      }
    }
  }

  const validation = config.validation ?? {};
  if (typeof validation !== 'object') throw configError('validation', 'must be an object');
  const maxSizeBytes = validation.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  if (!isPositiveInteger(maxSizeBytes)) throw configError('validation.maxSizeBytes', 'must be a positive integer');

  let allowedMimeTypes: string[] | undefined;
  if (validation.allowedMimeTypes !== undefined) {
    if (!Array.isArray(validation.allowedMimeTypes) || !validation.allowedMimeTypes.every(isNonEmptyString)) {
      throw configError('validation.allowedMimeTypes', 'must be an array of media type strings');
    }
    allowedMimeTypes = validation.allowedMimeTypes.map(normalizeContentType);
  }

  const verifyContentSignature = validation.verifyContentSignature ?? true;
  if (typeof verifyContentSignature !== 'boolean') {
    throw configError('validation.verifyContentSignature', 'must be a boolean');
  }

  const signedUrlExpiresInSeconds = config.signedUrlExpiresInSeconds ?? DEFAULT_SIGNED_URL_EXPIRY_SECONDS;
  if (!isPositiveInteger(signedUrlExpiresInSeconds) || signedUrlExpiresInSeconds > MAX_SIGNED_URL_EXPIRY_SECONDS) {
    throw configError(
      'signedUrlExpiresInSeconds',
      `must be a whole number between 1 and ${MAX_SIGNED_URL_EXPIRY_SECONDS} (7 days)`,
    );
  }

  if (config.logger !== undefined && (config.logger === null || typeof config.logger !== 'object')) {
    throw configError('logger', 'must be an object with debug/info/warn/error methods');
  }

  return {
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    defaultVisibility,
    keyPrefix,
    maxSizeBytes,
    ...(allowedMimeTypes ? { allowedMimeTypes } : {}),
    verifyContentSignature,
    signedUrlExpiresInSeconds,
    ...(config.logger ? { logger: config.logger } : {}),
  };
}

const PROVIDER_METHODS = ['put', 'get', 'head', 'delete', 'copy', 'list', 'signedGetUrl', 'presignedPost'] as const;

function validateProvider(provider: ProviderConfig): void {
  if (!provider || typeof provider !== 'object') throw configError('provider', 'is required');
  switch (provider.type) {
    case 's3': {
      if (!isNonEmptyString(provider.bucket)) throw configError('provider.bucket', 'is required');
      if (!isNonEmptyString(provider.region)) {
        throw configError('provider.region', 'is required (use "auto" for Cloudflare R2)');
      }
      if (provider.endpoint !== undefined) assertHttpUrl('provider.endpoint', provider.endpoint);
      if (provider.forcePathStyle !== undefined && typeof provider.forcePathStyle !== 'boolean') {
        throw configError('provider.forcePathStyle', 'must be a boolean');
      }
      if (provider.useAcl !== undefined && typeof provider.useAcl !== 'boolean') {
        throw configError('provider.useAcl', 'must be a boolean');
      }
      if (provider.credentials !== undefined) {
        const { credentials } = provider;
        if (!credentials || typeof credentials !== 'object') {
          throw configError('provider.credentials', 'must be an object');
        }
        if (!isNonEmptyString(credentials.accessKeyId)) {
          throw configError('provider.credentials.accessKeyId', 'is required when credentials are given');
        }
        if (!isNonEmptyString(credentials.secretAccessKey)) {
          throw configError('provider.credentials.secretAccessKey', 'is required when credentials are given');
        }
      }
      return;
    }
    case 'local':
      if (!isNonEmptyString(provider.rootDir)) throw configError('provider.rootDir', 'is required');
      assertHttpUrl('provider.baseUrl', provider.baseUrl);
      if (provider.signingSecret !== undefined && !isNonEmptyString(provider.signingSecret)) {
        throw configError('provider.signingSecret', 'must be a non-empty string');
      }
      return;
    case 'memory':
      return;
    case 'custom': {
      const instance = provider.instance as unknown as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object') throw configError('provider.instance', 'is required');
      const missing = PROVIDER_METHODS.filter((method) => typeof instance[method] !== 'function');
      if (missing.length) throw configError('provider.instance', `is missing methods: ${missing.join(', ')}`);
      return;
    }
    default:
      throw configError('provider.type', `must be "s3", "local", "memory" or "custom"`);
  }
}

function createProvider(provider: ProviderConfig, logger: MediaLogger | undefined): StorageProvider {
  switch (provider.type) {
    case 's3':
      return new S3StorageProvider(provider);
    case 'local':
      return new LocalStorageProvider(provider, logger);
    case 'memory':
      return new MemoryStorageProvider();
    case 'custom':
      return provider.instance;
  }
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  const destroy = (stream as { destroy?: () => void }).destroy;
  if (typeof destroy === 'function') destroy.call(stream);
}
