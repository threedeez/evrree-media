import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { abortedError, isAbortError, MediaError, toMediaError } from '../errors';
import { assertValidKey, encodeKeyForUrl } from '../keys';
import type { LocalProviderConfig, MediaBody, MediaLogger, Visibility } from '../types';
import { md5Etag, throwIfAborted, toReadable } from '../util';
import { decodeCursor, encodeCursor } from './memory.provider';
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

/** Sidecar metadata lives here, under rootDir. Keys may not start with it. */
export const LOCAL_META_DIR = '.evrree-meta';

interface StoredMeta {
  contentType: string;
  visibility: Visibility;
  metadata: Record<string, string>;
  etag?: string;
  cacheControl?: string;
  contentDisposition?: string;
}

/**
 * Stores files on the local disk under rootDir, for development. Every path is resolved and
 * checked against rootDir (including through symlinks), so no key can reach outside it.
 * Serve it with createLocalMediaHandler() to get working public URLs, signed URLs and
 * browser presigned uploads.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly rootDir: string;
  readonly baseUrl: string;
  private readonly secret: string;
  private realRoot?: Promise<string>;

  constructor(config: Omit<LocalProviderConfig, 'type'>, logger?: MediaLogger) {
    this.rootDir = path.resolve(config.rootDir);
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.secret =
      config.signingSecret ??
      createHash('sha256').update(`evrree-media-local-dev:${this.rootDir}`).digest('hex');

    // The only environment read in this package (documented exception to "never reads env"):
    // a guard rail against shipping the dev provider, not configuration.
    const env = typeof process !== 'undefined' ? process.env.NODE_ENV : undefined;
    if (env === 'production') {
      const warn = logger?.warn ?? ((message: string) => console.warn(message));
      warn.call(
        logger,
        '[@evrree/media] The local storage provider is for development only and is in use with NODE_ENV=production.',
      );
    }
  }

  async put(key: string, body: MediaBody, opts: PutOptions): Promise<ProviderObject> {
    throwIfAborted(opts.signal);
    const file = await this.dataPath(key);
    const tmpDir = path.join(this.rootDir, LOCAL_META_DIR, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${randomUUID()}.part`);

    let loaded = 0;
    const hash = createHash('md5');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        loaded += chunk.length;
        hash.update(chunk);
        opts.onProgress?.({ loadedBytes: loaded, totalBytes: opts.contentLength });
        callback(null, chunk);
      },
    });

    try {
      await pipeline(toReadable(body), meter, createWriteStream(tmp), ...(opts.signal ? [{ signal: opts.signal }] : []));
      throwIfAborted(opts.signal);
      await mkdir(path.dirname(file), { recursive: true });
      await this.assertInsideRoot(file);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      if (opts.signal?.aborted || isAbortError(error)) throw abortedError(error);
      throw toLocalError(error, key);
    }

    const meta: StoredMeta = {
      contentType: opts.contentType,
      visibility: opts.visibility,
      metadata: { ...opts.metadata },
      etag: `"${hash.digest('hex')}"`,
      ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
      ...(opts.contentDisposition ? { contentDisposition: opts.contentDisposition } : {}),
    };
    await this.writeMeta(key, meta);
    const object = await this.head(key);
    if (!object) throw new MediaError('PROVIDER_ERROR', `Stored file ${key} could not be read back`);
    return object;
  }

  async get(key: string): Promise<{ body: NodeJS.ReadableStream; object: ProviderObject }> {
    const object = await this.head(key);
    if (!object) throw notFound(key);
    return { body: createReadStream(await this.dataPath(key)), object };
  }

  async head(key: string): Promise<ProviderObject | null> {
    const file = await this.dataPath(key);
    let stats;
    try {
      stats = await stat(file);
    } catch (error) {
      if (isMissing(error)) return null;
      throw toLocalError(error, key);
    }
    if (!stats.isFile()) return null;
    const meta = await this.readMeta(key);
    return {
      key,
      size: stats.size,
      contentType: meta?.contentType ?? 'application/octet-stream',
      etag: meta?.etag ?? md5Etag(await readFile(file)),
      lastModified: stats.mtime,
      metadata: { ...(meta?.metadata ?? {}) },
      ...(meta?.visibility ? { visibility: meta.visibility } : {}),
      ...(meta?.cacheControl ? { cacheControl: meta.cacheControl } : {}),
      ...(meta?.contentDisposition ? { contentDisposition: meta.contentDisposition } : {}),
    };
  }

  async delete(keys: string[]): Promise<{ deleted: string[]; failed: { key: string; error: unknown }[] }> {
    const deleted: string[] = [];
    const failed: { key: string; error: unknown }[] = [];
    for (const key of keys) {
      try {
        await rm(await this.dataPath(key), { force: true });
        await rm(this.metaPath(key), { force: true });
        deleted.push(key);
      } catch (error) {
        failed.push({ key, error: toLocalError(error, key) });
      }
    }
    return { deleted, failed };
  }

  async copy(src: string, dest: string, opts: CopyOptions): Promise<ProviderObject> {
    const source = await this.head(src);
    if (!source) throw notFound(src);
    const target = await this.dataPath(dest);
    if (src !== dest) {
      await mkdir(path.dirname(target), { recursive: true });
      await this.assertInsideRoot(target);
      try {
        await copyFile(await this.dataPath(src), target);
      } catch (error) {
        throw toLocalError(error, src);
      }
    }
    await this.writeMeta(dest, {
      contentType: source.contentType,
      visibility: opts.visibility ?? source.visibility ?? 'private',
      metadata: opts.metadata ?? source.metadata,
      ...(source.etag ? { etag: source.etag } : {}),
      ...(source.cacheControl ? { cacheControl: source.cacheControl } : {}),
      ...(source.contentDisposition ? { contentDisposition: source.contentDisposition } : {}),
    });
    const copied = await this.head(dest);
    if (!copied) throw new MediaError('PROVIDER_ERROR', `Copied file ${dest} could not be read back`);
    return copied;
  }

  async list(opts: ListOptions): Promise<{ items: ProviderObject[]; nextCursor?: string }> {
    const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    const keys = (await this.walk(this.rootDir, ''))
      .filter((key) => key.startsWith(opts.prefix) && (after === undefined || key > after))
      .sort();
    const page = keys.slice(0, opts.limit);
    const items = (await Promise.all(page.map((key) => this.head(key)))).filter(
      (item): item is ProviderObject => item !== null,
    );
    return keys.length > opts.limit ? { items, nextCursor: encodeCursor(page[page.length - 1]!) } : { items };
  }

  async signedGetUrl(key: string, opts: SignedGetOptions): Promise<string> {
    await this.dataPath(key);
    const expiresAt = Date.now() + opts.expiresInSeconds * 1000;
    return `${this.baseUrl}/${encodeKeyForUrl(key)}?${signGetQuery(key, expiresAt, opts.contentDisposition, this.secret)}`;
  }

  async presignedPost(key: string, opts: PresignedPostOptions): Promise<{ url: string; fields: Record<string, string> }> {
    await this.dataPath(key);
    const fields = signUploadPolicy(
      {
        key,
        contentType: opts.contentType,
        maxSizeBytes: opts.maxSizeBytes,
        expiresAt: Date.now() + opts.expiresInSeconds * 1000,
        visibility: opts.visibility,
        metadata: opts.metadata,
        ...(opts.contentDisposition ? { contentDisposition: opts.contentDisposition } : {}),
      },
      this.secret,
    );
    return { url: `${this.baseUrl}/`, fields };
  }

  /**
   * Node http / Express / Connect request handler that serves files (public ones directly,
   * private ones through signed URLs) and accepts browser uploads made with a presigned post.
   * Mount it at the path of `baseUrl`. Development only.
   */
  handler(): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void {
    return (req, res) => {
      void this.handle(req, res).catch((error) => {
        const mapped = toMediaError(error);
        if (!res.headersSent) sendError(res, mapped);
        else res.destroy();
      });
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL((req as { originalUrl?: string }).originalUrl ?? req.url ?? '/', 'http://localhost');
    const basePath = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
    let pathname = url.pathname;
    if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
      pathname = pathname.slice(basePath.length);
    }
    const key = pathname
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');

    if (req.method === 'POST' && key === '') return this.handleUpload(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && key !== '') return this.handleDownload(key, url, req, res);
    sendError(res, new MediaError('PROVIDER_ERROR', 'Method not allowed', { statusCode: 405 }));
  }

  private async handleDownload(key: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    assertValidKey(key);
    const object = await this.head(key);
    let disposition = object?.contentDisposition;
    if (object?.visibility !== 'public' || url.searchParams.has('X-Evrree-Signature')) {
      disposition = verifyGetQuery(key, url.searchParams, this.secret) || disposition;
    }
    if (!object) throw notFound(key);
    res.statusCode = 200;
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Length', String(object.size));
    res.setHeader('Last-Modified', object.lastModified.toUTCString());
    if (object.etag) res.setHeader('ETag', object.etag);
    if (object.cacheControl) res.setHeader('Cache-Control', object.cacheControl);
    if (disposition) res.setHeader('Content-Disposition', disposition);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(createReadStream(await this.dataPath(key)), res);
  }

  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const request = new Request('http://localhost/', {
      method: 'POST',
      headers,
      body: Readable.toWeb(req) as ReadableStream,
      duplex: 'half',
    } as RequestInit);
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      throw new MediaError('UPLOAD_FAILED', 'Expected a multipart/form-data body', { statusCode: 400, cause: error });
    }

    const fields: Record<string, string> = {};
    let file: Blob | undefined;
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') fields[name] = value;
      else if (name === 'file') file = value;
    }
    const policy = verifyUploadPolicy(fields, this.secret);
    if (!file) throw new MediaError('UPLOAD_FAILED', 'Missing "file" field', { statusCode: 400 });
    if (file.size > policy.maxSizeBytes) {
      throw new MediaError('FILE_TOO_LARGE', 'Your proposed upload exceeds the maximum allowed size', {
        statusCode: 400,
      });
    }
    assertValidKey(policy.key);
    await this.put(policy.key, file, {
      contentType: policy.contentType,
      contentLength: file.size,
      visibility: policy.visibility,
      metadata: policy.metadata,
      ...(policy.contentDisposition ? { contentDisposition: policy.contentDisposition } : {}),
    });
    res.statusCode = 204;
    res.end();
  }

  /** Resolves a key to a path inside rootDir, or throws INVALID_KEY. */
  async dataPath(key: string): Promise<string> {
    const segments = key.split('/');
    if (segments[0] === LOCAL_META_DIR) {
      throw new MediaError('INVALID_KEY', `Keys may not start with "${LOCAL_META_DIR}" on the local provider`);
    }
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\0'))) {
      throw new MediaError('INVALID_KEY', 'Key contains an empty, "." or ".." path segment');
    }
    const resolved = path.resolve(this.rootDir, ...segments);
    if (!resolved.startsWith(this.rootDir + path.sep)) {
      throw new MediaError('INVALID_KEY', 'Key resolves outside the storage root');
    }
    await this.assertInsideRoot(resolved);
    return resolved;
  }

  private metaPath(key: string): string {
    return `${path.resolve(this.rootDir, LOCAL_META_DIR, 'objects', ...key.split('/'))}.json`;
  }

  /** Follows symlinks on the nearest existing ancestor and checks it is still inside rootDir. */
  private async assertInsideRoot(target: string): Promise<void> {
    this.realRoot ??= mkdir(this.rootDir, { recursive: true }).then(() => realpath(this.rootDir));
    const root = await this.realRoot;
    let current = target;
    for (;;) {
      try {
        const real = await realpath(current);
        if (real !== root && !real.startsWith(root + path.sep)) {
          throw new MediaError('INVALID_KEY', 'Key resolves outside the storage root');
        }
        return;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
      }
    }
  }

  private async readMeta(key: string): Promise<StoredMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(key), 'utf8')) as StoredMeta;
    } catch (error) {
      if (isMissing(error)) return null;
      throw toLocalError(error, key);
    }
  }

  private async writeMeta(key: string, meta: StoredMeta): Promise<void> {
    const file = this.metaPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(meta));
  }

  private async walk(dir: string, prefix: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw toLocalError(error);
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (prefix === '' && entry.name === LOCAL_META_DIR) continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) keys.push(...(await this.walk(path.join(dir, entry.name), key)));
      else if (entry.isFile()) keys.push(key);
    }
    return keys;
  }
}

/** Request handler for a local provider config; see LocalStorageProvider#handler. */
export function createLocalMediaHandler(
  config: Omit<LocalProviderConfig, 'type'>,
): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void {
  return new LocalStorageProvider(config).handler();
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function notFound(key: string): MediaError {
  return new MediaError('NOT_FOUND', `Object not found: ${key}`, { statusCode: 404 });
}

function toLocalError(error: unknown, key?: string): MediaError {
  if (error instanceof MediaError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (isMissing(error)) return new MediaError('NOT_FOUND', `Object not found${key ? `: ${key}` : ''}`, { cause: error });
  if (code === 'EACCES' || code === 'EPERM') {
    return new MediaError('ACCESS_DENIED', `Filesystem permission denied${key ? ` for ${key}` : ''}`, { cause: error });
  }
  return toMediaError(error, 'Local storage error');
}

const STATUS_BY_CODE: Partial<Record<MediaError['code'], number>> = {
  NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  INVALID_KEY: 400,
  FILE_TOO_LARGE: 400,
  UPLOAD_FAILED: 400,
};

const S3_CODE_BY_CODE: Partial<Record<MediaError['code'], string>> = {
  NOT_FOUND: 'NoSuchKey',
  ACCESS_DENIED: 'AccessDenied',
  FILE_TOO_LARGE: 'EntityTooLarge',
  INVALID_KEY: 'InvalidArgument',
};

function sendError(res: ServerResponse, error: MediaError): void {
  // S3-style XML error body, so the browser client reports local and S3 failures the same way.
  const code = S3_CODE_BY_CODE[error.code] ?? (error.statusCode === 405 ? 'MethodNotAllowed' : 'InternalError');
  const escape = (text: string) => text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  res.statusCode = error.statusCode ?? STATUS_BY_CODE[error.code] ?? 500;
  res.setHeader('Content-Type', 'application/xml');
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escape(error.message)}</Message></Error>`);
}
