import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
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

  const iterator = toReadable(body)[Symbol.asyncIterator]() as AsyncIterator<unknown>;
  const peeked: Buffer[] = [];
  let peekedLength = 0;
  let ended = false;
  while (peekedLength < opts.peekBytes) {
    if (opts.signal?.aborted) {
      await iterator.return?.();
      throw abortedError();
    }
    const next = await iterator.next();
    if (next.done) {
      ended = true;
      break;
    }
    const buf = chunkToBuffer(next.value);
    peeked.push(buf);
    peekedLength += buf.length;
    if (peekedLength > opts.maxSizeBytes) {
      await iterator.return?.();
      assertSize(peekedLength, opts.maxSizeBytes);
    }
  }
  const first = Buffer.concat(peeked);

  if (ended) return { body: first, size: first.length, head: first.subarray(0, opts.peekBytes) };

  async function* rest(): AsyncGenerator<Buffer> {
    yield first;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield chunkToBuffer(next.value);
    }
  }
  return {
    body: limitStream(Readable.from(rest()), opts.maxSizeBytes, opts.signal),
    head: first.subarray(0, opts.peekBytes),
  };
}

/** Passes bytes through, erroring with FILE_TOO_LARGE past the limit and ABORTED on abort. */
export function limitStream(source: Readable, maxSizeBytes: number, signal?: AbortSignal): Readable {
  let total = 0;
  async function* limited(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of source) {
        if (signal?.aborted) throw abortedError();
        const buf = chunkToBuffer(chunk);
        total += buf.length;
        assertSize(total, maxSizeBytes);
        yield buf;
      }
    } finally {
      if (!source.destroyed) source.destroy();
    }
  }
  return Readable.from(limited());
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
