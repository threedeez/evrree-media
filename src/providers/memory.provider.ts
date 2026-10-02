import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { MediaError } from '../errors';
import { encodeKeyForUrl } from '../keys';
import type { MediaBody, Visibility } from '../types';
import { md5Etag, readAll, throwIfAborted } from '../util';
import { signGetQuery, signUploadPolicy, verifyGetQuery, verifyUploadPolicy } from './signing';
import type {
  CopyOptions,
  ListOptions,
  PresignedPostOptions,
  ProviderObject,
  PutOptions,
  SignedGetOptions,
  StorageProvider,
} from './storage-provider';

interface StoredObject {
  data: Buffer;
  object: ProviderObject;
}

const MEMORY_ORIGIN = 'memory://media';

/**
 * Keeps everything in a Map. For tests: fast, isolated per instance, and implements the
 * whole StorageProvider contract, including signed URLs and presigned posts (which tests can
 * complete with `acceptPresignedPost` / `resolveSignedUrl`).
 */
export class MemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, StoredObject>();
  private readonly secret = randomBytes(32).toString('hex');

  async put(key: string, body: MediaBody, opts: PutOptions): Promise<ProviderObject> {
    throwIfAborted(opts.signal);
    const data = await readAll(body, { signal: opts.signal, onProgress: opts.onProgress, totalBytes: opts.contentLength });
    throwIfAborted(opts.signal);
    return this.store(key, data, {
      contentType: opts.contentType,
      visibility: opts.visibility,
      metadata: opts.metadata,
      cacheControl: opts.cacheControl,
      contentDisposition: opts.contentDisposition,
    });
  }

  async get(key: string): Promise<{ body: NodeJS.ReadableStream; object: ProviderObject }> {
    const stored = this.objects.get(key);
    if (!stored) throw notFound(key);
    return { body: Readable.from([Buffer.from(stored.data)]), object: clone(stored.object) };
  }

  async head(key: string): Promise<ProviderObject | null> {
    const stored = this.objects.get(key);
    return stored ? clone(stored.object) : null;
  }

  async delete(keys: string[]): Promise<{ deleted: string[]; failed: { key: string; error: unknown }[] }> {
    for (const key of keys) this.objects.delete(key);
    return { deleted: [...keys], failed: [] };
  }

  async copy(src: string, dest: string, opts: CopyOptions): Promise<ProviderObject> {
    const stored = this.objects.get(src);
    if (!stored) throw notFound(src);
    const replace = opts.metadata !== undefined || opts.visibility !== undefined;
    return this.store(dest, Buffer.from(stored.data), {
      ...stored.object,
      metadata: replace && opts.metadata !== undefined ? opts.metadata : stored.object.metadata,
      visibility: opts.visibility ?? stored.object.visibility ?? 'private',
    });
  }

  async list(opts: ListOptions): Promise<{ items: ProviderObject[]; nextCursor?: string }> {
    const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(opts.prefix) && (after === undefined || key > after))
      .sort();
    const page = keys.slice(0, opts.limit);
    const items = page.map((key) => clone(this.objects.get(key)!.object));
    return keys.length > opts.limit ? { items, nextCursor: encodeCursor(page[page.length - 1]!) } : { items };
  }

  async signedGetUrl(key: string, opts: SignedGetOptions): Promise<string> {
    const expiresAt = Date.now() + opts.expiresInSeconds * 1000;
    return `${MEMORY_ORIGIN}/${encodeKeyForUrl(key)}?${signGetQuery(key, expiresAt, opts.contentDisposition, this.secret)}`;
  }

  async presignedPost(key: string, opts: PresignedPostOptions): Promise<{ url: string; fields: Record<string, string> }> {
    const fields = signUploadPolicy(
      {
        key,
        contentType: opts.contentType,
        maxSizeBytes: opts.maxSizeBytes,
        expiresAt: Date.now() + opts.expiresInSeconds * 1000,
        visibility: opts.visibility,
        metadata: opts.metadata,
        contentDisposition: opts.contentDisposition,
      },
      this.secret,
    );
    return { url: `${MEMORY_ORIGIN}/`, fields };
  }

  /**
   * Test helper: performs the upload a browser would make with a presigned post, enforcing the
   * same rules the storage server would (signature, expiry, key, content type, max size).
   */
  async acceptPresignedPost(fields: Record<string, string>, body: MediaBody): Promise<ProviderObject> {
    const policy = verifyUploadPolicy(fields, this.secret);
    let data: Buffer;
    try {
      data = await readAll(body, { maxSizeBytes: policy.maxSizeBytes });
    } catch (error) {
      if (error instanceof MediaError && error.code === 'FILE_TOO_LARGE') {
        throw new MediaError('UPLOAD_FAILED', error.message, { statusCode: 400, cause: error });
      }
      throw error;
    }
    return this.store(policy.key, data, {
      contentType: policy.contentType,
      visibility: policy.visibility,
      metadata: policy.metadata,
      contentDisposition: policy.contentDisposition,
    });
  }

  /** Test helper: returns the object a signed URL points at, enforcing expiry and signature. */
  async resolveSignedUrl(url: string): Promise<{ body: Buffer; object: ProviderObject; contentDisposition?: string }> {
    const parsed = new URL(url);
    const key = parsed.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    const disposition = verifyGetQuery(key, parsed.searchParams, this.secret);
    const stored = this.objects.get(key);
    if (!stored) throw notFound(key);
    return {
      body: Buffer.from(stored.data),
      object: clone(stored.object),
      ...(disposition ? { contentDisposition: disposition } : {}),
    };
  }

  /** Removes every object. */
  clear(): void {
    this.objects.clear();
  }

  get size(): number {
    return this.objects.size;
  }

  private store(
    key: string,
    data: Buffer,
    attrs: {
      contentType: string;
      visibility?: Visibility;
      metadata: Record<string, string>;
      cacheControl?: string;
      contentDisposition?: string;
    },
  ): ProviderObject {
    const object: ProviderObject = {
      key,
      size: data.length,
      contentType: attrs.contentType,
      etag: md5Etag(data),
      lastModified: new Date(),
      metadata: { ...attrs.metadata },
      visibility: attrs.visibility ?? 'private',
      ...(attrs.cacheControl ? { cacheControl: attrs.cacheControl } : {}),
      ...(attrs.contentDisposition ? { contentDisposition: attrs.contentDisposition } : {}),
    };
    this.objects.set(key, { data, object });
    return clone(object);
  }
}

function clone(object: ProviderObject): ProviderObject {
  return { ...object, metadata: { ...object.metadata }, lastModified: new Date(object.lastModified) };
}

function notFound(key: string): MediaError {
  return new MediaError('NOT_FOUND', `Object not found: ${key}`, { statusCode: 404 });
}

export function encodeCursor(lastKey: string): string {
  return Buffer.from(lastKey, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}
