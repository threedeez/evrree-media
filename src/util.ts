import { createHash } from 'node:crypto';
import { pipeline, Readable, Transform } from 'node:stream';
import { abortedError, MediaError } from './errors';
import type { MediaBody, UploadProgress } from './types';
import { assertSize } from './validation';

/** Byte length of a body, when it can be known without reading it. */
export function knownLength(body: MediaBody): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  if (isBlob(body)) return body.size;
  return undefined;
}

export function isBlob(body: unknown): body is Blob {
  return typeof Blob !== 'undefined' && body instanceof Blob;
}

export function toBuffer(body: string | Uint8Array): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

/** Any MediaBody as a Node Readable. */
export function toReadable(body: MediaBody): Readable {
  if (typeof body === 'string' || body instanceof Uint8Array) return Readable.from([toBuffer(body)]);
  if (isBlob(body)) return Readable.fromWeb(body.stream() as import('node:stream/web').ReadableStream);
  if (body instanceof Readable) return body;
  return new Readable({ objectMode: false }).wrap(body as NodeJS.ReadableStream);
}

function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array || typeof chunk === 'string') return toBuffer(chunk);
  throw new MediaError('UPLOAD_FAILED', 'Stream produced a chunk that is not bytes');
}

export interface ReadOptions {
  maxSizeBytes?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  totalBytes?: number;
}

/** Reads any body fully into memory, enforcing an optional size limit and abort signal. */
export async function readAll(body: MediaBody, opts: ReadOptions = {}): Promise<Buffer> {
  if (typeof body === 'string' || body instanceof Uint8Array) {
    if (opts.signal?.aborted) throw abortedError();
    const buf = toBuffer(body);
    if (opts.maxSizeBytes !== undefined) assertSize(buf.length, opts.maxSizeBytes);
    opts.onProgress?.({ loadedBytes: buf.length, totalBytes: buf.length });
    return buf;
  }
  const chunks: Buffer[] = [];
  let loaded = 0;
  for await (const chunk of toReadable(body)) {
    if (opts.signal?.aborted) throw abortedError();
    const buf = chunkToBuffer(chunk);
    loaded += buf.length;
    if (opts.maxSizeBytes !== undefined) assertSize(loaded, opts.maxSizeBytes);
    chunks.push(buf);
    opts.onProgress?.({ loadedBytes: loaded, totalBytes: opts.totalBytes });
  }
  return Buffer.concat(chunks);
}

export interface PreparedBody {
  /** Buffer when the whole body is in memory, otherwise a size-limited stream. */
  body: Buffer | Readable;
  size?: number;
  /** The first bytes, for signature checks. */
  head: Buffer;
}

/**
 * Normalises an upload body. Known-length bodies are size-checked up front. Streams are
 * peeked for their first bytes and wrapped so they fail with FILE_TOO_LARGE the moment the
 * limit is exceeded (and ABORTED as soon as the signal fires), before the rest is read.
 */
export async function prepareBody(
  body: MediaBody,
  opts: { maxSizeBytes: number; peekBytes: number; signal?: AbortSignal },
): Promise<PreparedBody> {
  if (typeof body === 'string' || body instanceof Uint8Array) {
    const buf = toBuffer(body);
    assertSize(buf.length, opts.maxSizeBytes);
    return { body: buf, size: buf.length, head: buf.subarray(0, opts.peekBytes) };
  }

  if (isBlob(body)) {
    assertSize(body.size, opts.maxSizeBytes);
    const head = Buffer.from(await body.slice(0, opts.peekBytes).arrayBuffer());
    return { body: limitStream(toReadable(body), opts.maxSizeBytes, opts.signal), size: body.size, head };
  }

  if (body === null || typeof body !== 'object' || typeof (body as NodeJS.ReadableStream).on !== 'function') {
    throw new MediaError('UPLOAD_FAILED', 'body must be a Buffer, Uint8Array, string, Blob or readable stream');
  }

  const stream = toReadable(body);
  const { head, ended } = await peekStream(stream, opts.peekBytes, opts.maxSizeBytes, opts.signal);
  if (ended) return { body: head, size: head.length, head: head.subarray(0, opts.peekBytes) };
  return {
    body: limitStream(stream, opts.maxSizeBytes, opts.signal),
    head: head.subarray(0, opts.peekBytes),
  };
}

function peekStream(
  stream: Readable,
  bytes: number,
  maxSizeBytes: number,
  signal?: AbortSignal,
): Promise<{ head: Buffer; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;

    const cleanup = () => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      cleanup();
      stream.destroy();
      reject(error);
    };
    function onError(error: unknown) {
      cleanup();
      reject(error);
    }
    function onAbort() {
      fail(abortedError(signal?.reason));
    }
    function onEnd() {
      cleanup();
      resolve({ head: Buffer.concat(chunks), ended: true });
    }
    function onReadable() {
      let chunk: unknown;
      while (length < bytes && (chunk = stream.read()) !== null) {
        try {
          const buf = chunkToBuffer(chunk);
          chunks.push(buf);
          length += buf.length;
          assertSize(length, maxSizeBytes);
        } catch (error) {
          fail(error);
          return;
        }
      }
      if (length >= bytes) {
        stream.off('readable', onReadable);
        stream.off('end', onEnd);
        signal?.removeEventListener('abort', onAbort);
        const head = Buffer.concat(chunks);
        stream.unshift(head);
        resolve({ head, ended: false });
      }
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Passes bytes through, erroring with FILE_TOO_LARGE past the limit and ABORTED on abort. */
export function limitStream(source: Readable, maxSizeBytes: number, signal?: AbortSignal): Readable {
  let total = 0;
  const limiter = new Transform({
    writableObjectMode: true,
    transform(chunk: unknown, _encoding, callback) {
      try {
        const buf = chunkToBuffer(chunk);
        total += buf.length;
        assertSize(total, maxSizeBytes);
        callback(null, buf);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  const onAbort = () => limiter.destroy(abortedError(signal?.reason));
  pipeline(source, limiter, () => signal?.removeEventListener('abort', onAbort));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return limiter;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(type: 'inline' | 'attachment', fileName?: string): string {
  if (!fileName) return type;
  const fallback = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .trim();
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback || 'download'}"; filename*=UTF-8''${encoded}`;
}

/** Lowercases metadata keys and checks every value is a string (S3 stores them as headers). */
export function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (metadata === undefined) return result;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new MediaError('CONFIG_ERROR', 'metadata must be an object of string values');
  }
  for (const [rawKey, value] of Object.entries(metadata)) {
    const key = rawKey.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      throw new MediaError('CONFIG_ERROR', `metadata key "${rawKey}" may only contain letters, digits, "-" and "_"`);
    }
    if (typeof value !== 'string') {
      throw new MediaError('CONFIG_ERROR', `metadata value for "${rawKey}" must be a string`);
    }
    result[key] = value;
  }
  return result;
}

export function md5Etag(data: Buffer): string {
  return `"${createHash('md5').update(data).digest('hex')}"`;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError(signal.reason);
}
