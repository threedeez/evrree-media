import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createMediaClient,
  MediaClient,
  MediaError,
  MemoryStorageProvider,
  type MediaClientConfig,
  type StorageProvider,
} from '../../src';
import { captureLogger, countingStream, samples } from '../fixtures';

const MB = 1024 * 1024;

function setup(overrides: Partial<MediaClientConfig> = {}) {
  const media = createMediaClient({ provider: { type: 'memory' }, ...overrides });
  return { media, memory: media.provider as MemoryStorageProvider };
}

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string) {
  let error: unknown;
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}`).toBeInstanceOf(MediaError);
  expect((error as MediaError).code).toBe(code);
  return error as MediaError;
}

describe('createMediaClient config validation (AC5)', () => {
  const cases: [string, unknown, RegExp][] = [
    ['missing provider', {}, /provider/],
    ['unknown provider type', { provider: { type: 'ftp' } }, /provider\.type/],
    ['missing bucket', { provider: { type: 's3', region: 'eu-west-1' } }, /provider\.bucket/],
    ['missing region', { provider: { type: 's3', bucket: 'b' } }, /provider\.region/],
    ['bad endpoint', { provider: { type: 's3', bucket: 'b', region: 'auto', endpoint: 'nope' } }, /provider\.endpoint/],
    [
      'half credentials',
      { provider: { type: 's3', bucket: 'b', region: 'r', credentials: { accessKeyId: 'x' } } },
      /provider\.credentials\.secretAccessKey/,
    ],
    ['local without rootDir', { provider: { type: 'local', baseUrl: 'http://x' } }, /provider\.rootDir/],
    ['local without baseUrl', { provider: { type: 'local', rootDir: '/tmp/x' } }, /provider\.baseUrl/],
    ['custom without methods', { provider: { type: 'custom', instance: { put() {} } } }, /provider\.instance.*get/],
    ['negative size', { provider: { type: 'memory' }, validation: { maxSizeBytes: -1 } }, /validation\.maxSizeBytes/],
    ['fractional size', { provider: { type: 'memory' }, validation: { maxSizeBytes: 1.5 } }, /validation\.maxSizeBytes/],
    ['expiry over 7 days', { provider: { type: 'memory' }, signedUrlExpiresInSeconds: 604801 }, /signedUrlExpiresInSeconds/],
    ['zero expiry', { provider: { type: 'memory' }, signedUrlExpiresInSeconds: 0 }, /signedUrlExpiresInSeconds/],
    ['bad visibility', { provider: { type: 'memory' }, defaultVisibility: 'world' }, /defaultVisibility/],
    ['public without base url', { provider: { type: 'memory' }, defaultVisibility: 'public' }, /publicBaseUrl/],
    ['bad publicBaseUrl', { provider: { type: 'memory' }, publicBaseUrl: 'ftp://cdn' }, /publicBaseUrl/],
    ['bad keyPrefix', { provider: { type: 'memory' }, keyPrefix: 'a/../b' }, /keyPrefix/],
    ['bad mime list', { provider: { type: 'memory' }, validation: { allowedMimeTypes: 'image/png' } }, /allowedMimeTypes/],
    ['bad signature flag', { provider: { type: 'memory' }, validation: { verifyContentSignature: 'yes' } }, /verifyContentSignature/],
    ['bad logger', { provider: { type: 'memory' }, logger: 'console' }, /logger/],
  ];

  it.each(cases)('%s throws CONFIG_ERROR naming the field', async (_name, config, field) => {
    const error = await expectCode(() => createMediaClient(config as MediaClientConfig), 'CONFIG_ERROR');
    expect(error.message).toMatch(field);
  });

  it('accepts a full S3 config without making any request', () => {
    const media = createMediaClient({
      provider: {
        type: 's3',
        bucket: 'evrree-cbt-prod',
        region: 'auto',
        endpoint: 'https://account.r2.cloudflarestorage.com',
        forcePathStyle: false,
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
      },
      publicBaseUrl: 'https://cdn.evrree.com/',
      keyPrefix: '/cbt/',
      validation: { maxSizeBytes: 5 * MB, allowedMimeTypes: ['image/png'], verifyContentSignature: false },
      signedUrlExpiresInSeconds: 604800,
      logger: console,
    });
    expect(media).toBeInstanceOf(MediaClient);
    expect(media.keyPrefix).toBe('cbt');
    expect(media.getPublicUrl('cbt/a b.png')).toBe('https://cdn.evrree.com/cbt/a%20b.png');
  });
});

describe('process.env (AC6)', () => {
  it('is only read in one place: the local provider NODE_ENV warning', () => {
    const files = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name));
    const readers = files.filter((file) => readFileSync(file, 'utf8').includes('process.env'));
    expect(readers.map((f) => f.replaceAll('\\', '/'))).toEqual(['src/providers/local.provider.ts']);
    const matches = readFileSync('src/providers/local.provider.ts', 'utf8').match(/process\.env\.?\w*/g);
    expect(matches).toEqual(['process.env.NODE_ENV']);
  });

  it('does not touch process.env when creating and using a memory client', async () => {
    const reads: PropertyKey[] = [];
    const original = process.env;
    process.env = new Proxy(original, {
      get(target, prop) {
        // Only reads made by this package's source count, not the test runner's.
        if (/[\\/]src[\\/]/.test(new Error().stack ?? '')) reads.push(prop);
        return Reflect.get(target, prop);
      },
    });
    try {
      const { media } = setup({ keyPrefix: 'app' });
      const obj = await media.upload({ body: samples.png, fileName: 'a.png', contentType: 'image/png' });
      await media.getBuffer(obj.key);
      await media.list();
    } finally {
      process.env = original;
    }
    expect(reads).toEqual([]);
  });
});

describe('upload', () => {
  it('stores a file and returns a MediaObject', async () => {
    const { media } = setup();
    const obj = await media.upload({
      body: samples.png,
      fileName: 'Avatar.PNG',
      contentType: 'image/png',
      folder: 'avatars',
      metadata: { UploadedBy: 'user_123' },
      cacheControl: 'max-age=60',
    });
    expect(obj).toMatchObject({
      size: samples.png.length,
      contentType: 'image/png',
      visibility: 'private',
      metadata: { uploadedby: 'user_123' },
    });
    expect(obj.key).toMatch(/^avatars\/\d{4}\/\d{2}\/[0-9a-f-]{36}-avatar\.png$/);
    expect(obj.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(obj.lastModified).toBeInstanceOf(Date);
    expect(obj.url).toBeUndefined();
  });

  it('accepts every body type', async () => {
    const { media } = setup();
    const bodies = [
      samples.text,
      new Uint8Array(samples.text),
      samples.text.toString(),
      new Blob([samples.text]),
      Readable.from([samples.text.subarray(0, 3), samples.text.subarray(3)]),
    ];
    for (const body of bodies) {
      const obj = await media.upload({ body, fileName: 'a.txt', contentType: 'text/plain' });
      expect((await media.getBuffer(obj.key)).body.equals(samples.text)).toBe(true);
    }
  });

  it('rejects files over maxSizeBytes before storing anything (AC8)', async () => {
    const { media, memory } = setup({ validation: { maxSizeBytes: 100 } });
    const put = vi.spyOn(memory, 'put');
    await expectCode(media.upload({ body: Buffer.alloc(101), fileName: 'a.bin', contentType: 'application/octet-stream' }), 'FILE_TOO_LARGE');
    await expectCode(media.upload({ body: new Blob([Buffer.alloc(101)]), fileName: 'a.bin', contentType: 'application/octet-stream' }), 'FILE_TOO_LARGE');
    await expectCode(media.upload({ body: 'x'.repeat(101), fileName: 'a.txt', contentType: 'text/plain' }), 'FILE_TOO_LARGE');
    expect(put).not.toHaveBeenCalled();
    expect(memory.size).toBe(0);
  });

  it('stops reading a stream of unknown length as soon as the limit is passed (AC8)', async () => {
    const { media, memory } = setup({ validation: { maxSizeBytes: 10 * 1024 } });
    const { stream, state } = countingStream(10 * MB, 1024);
    await expectCode(media.upload({ body: stream, fileName: 'big.bin', contentType: 'application/octet-stream' }), 'FILE_TOO_LARGE');
    expect(state.pulled).toBeLessThan(MB);
    expect(memory.size).toBe(0);
  });

  it('fails on a tiny first chunk that already exceeds the limit', async () => {
    const { media } = setup({ validation: { maxSizeBytes: 4 } });
    await expectCode(media.upload({ body: Readable.from([Buffer.alloc(8)]), fileName: 'a', contentType: 'text/plain' }), 'FILE_TOO_LARGE');
  });

  it('accepts a stream exactly at the limit', async () => {
    const { media } = setup({ validation: { maxSizeBytes: 5000 } });
    const { stream } = countingStream(5000, 700);
    const obj = await media.upload({ body: stream, fileName: 'a.bin', contentType: 'application/octet-stream' });
    expect(obj.size).toBe(5000);
  });

  it('rejects types outside allowedMimeTypes with UNSUPPORTED_TYPE (AC9)', async () => {
    const { media } = setup({ validation: { allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'] } });
    await expectCode(media.upload({ body: samples.gif89, fileName: 'a.gif', contentType: 'image/gif' }), 'UNSUPPORTED_TYPE');
    await expectCode(media.upload({ body: samples.text, fileName: 'a.txt', contentType: 'nonsense' }), 'UNSUPPORTED_TYPE');
    await expect(media.upload({ body: samples.pdf, fileName: 'a.pdf', contentType: 'Application/PDF' })).resolves.toBeTruthy();
  });

  it.each([
    ['image/jpeg', samples.jpeg],
    ['image/png', samples.png],
    ['image/gif', samples.gif89],
    ['image/webp', samples.webp],
    ['application/pdf', samples.pdf],
    ['video/mp4', samples.mp4],
  ])('verifies magic bytes for %s (AC10)', async (contentType, bytes) => {
    const { media } = setup();
    await expect(media.upload({ body: bytes, fileName: 'f', contentType })).resolves.toBeTruthy();
    await expectCode(media.upload({ body: samples.text, fileName: 'f', contentType }), 'CONTENT_MISMATCH');
    await expectCode(
      media.upload({ body: Readable.from([samples.text]), fileName: 'f', contentType }),
      'CONTENT_MISMATCH',
    );
    await expectCode(media.upload({ body: new Blob([samples.text]), fileName: 'f', contentType }), 'CONTENT_MISMATCH');
  });

  it('checks the signature across small stream chunks', async () => {
    const { media } = setup();
    const chunks = [...samples.png.subarray(0, 12)].map((byte) => Buffer.from([byte]));
    const obj = await media.upload({ body: Readable.from([...chunks, samples.png.subarray(12)]), fileName: 'a.png', contentType: 'image/png' });
    expect(obj.size).toBe(samples.png.length);
  });

  it('skips the signature check for other types or when disabled', async () => {
    await expect(setup().media.upload({ body: samples.png, fileName: 'a.csv', contentType: 'text/csv' })).resolves.toBeTruthy();
    const { media } = setup({ validation: { verifyContentSignature: false } });
    await expect(media.upload({ body: samples.text, fileName: 'a.png', contentType: 'image/png' })).resolves.toBeTruthy();
  });

  it('returns a public URL for public uploads only (AC12)', async () => {
    const { media } = setup({ publicBaseUrl: 'https://cdn.evrree.com' });
    const pub = await media.upload({ body: samples.png, fileName: 'a.png', contentType: 'image/png', visibility: 'public' });
    expect(pub.url).toBe(`https://cdn.evrree.com/${pub.key}`);
    const priv = await media.upload({ body: samples.png, fileName: 'a.png', contentType: 'image/png' });
    expect(priv.url).toBeUndefined();
    expect((await media.head(pub.key))!.url).toBe(pub.url);
  });

  it('uses defaultVisibility', async () => {
    const { media } = setup({ publicBaseUrl: 'https://cdn.x', defaultVisibility: 'public' });
    const obj = await media.upload({ body: samples.png, fileName: 'a.png', contentType: 'image/png' });
    expect(obj.visibility).toBe('public');
    expect(obj.url).toBeDefined();
  });

  it('generates unique keys for the same file name (AC13)', async () => {
    const { media } = setup({ keyPrefix: 'cbt' });
    const [a, b] = await Promise.all(
      [1, 2].map(() => media.upload({ body: samples.png, fileName: 'Same Name.png', contentType: 'image/png', folder: 'questions/images' })),
    );
    expect(a!.key).not.toBe(b!.key);
    expect(a!.key).toMatch(/^cbt\/questions\/images\/\d{4}\/\d{2}\/[0-9a-f-]{36}-same-name\.png$/);
  });

  it('uses an explicit key, adding keyPrefix only once (AC7)', async () => {
    const { media } = setup({ keyPrefix: 'cbt' });
    const a = await media.upload({ body: 'a', fileName: 'a.txt', contentType: 'text/plain', key: 'exports/a.txt' });
    const b = await media.upload({ body: 'b', fileName: 'b.txt', contentType: 'text/plain', key: 'cbt/exports/b.txt' });
    expect(a.key).toBe('cbt/exports/a.txt');
    expect(b.key).toBe('cbt/exports/b.txt');
    expect(await media.exists(a.key)).toBe(true);
    await expectCode(media.upload({ body: 'x', fileName: 'x', contentType: 'text/plain', key: '../x' }), 'INVALID_KEY');
  });

  it('reports progress', async () => {
    const { media } = setup();
    const onProgress = vi.fn();
    await media.upload({ body: Readable.from([Buffer.alloc(10), Buffer.alloc(20)]), fileName: 'a', contentType: 'text/plain', onProgress });
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.lastCall![0]).toMatchObject({ loadedBytes: 30 });
  });

  it('rejects a stream that yields a non-byte chunk after the first bytes', async () => {
    const { media, memory } = setup();
    const body = Readable.from([Buffer.alloc(32), { not: 'bytes' }]);
    await expectCode(media.upload({ body, fileName: 'x', contentType: 'application/octet-stream' }), 'UPLOAD_FAILED');
    expect(memory.size).toBe(0);
  });

  it('rejects with the source error, without an unhandled error, when the stream fails right after the first bytes', async () => {
    const { media, memory } = setup();
    let reads = 0;
    const body = new Readable({
      read() {
        if (reads++ === 0) this.push(Buffer.alloc(32));
        else this.destroy(new Error('source broke'));
      },
    });
    const error = await expectCode(media.upload({ body, fileName: 'x', contentType: 'application/octet-stream' }), 'PROVIDER_ERROR');
    expect((error.cause as Error).message).toBe('source broke');
    expect(memory.size).toBe(0);
  });

  it('aborts promptly while the source stream is idle waiting for data', async () => {
    const { media, memory } = setup();
    const idle = new Readable({ read() {} });
    idle.push(Buffer.alloc(100));
    const controller = new AbortController();
    const upload = media.upload({ body: idle, fileName: 'x', contentType: 'application/octet-stream', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expectCode(upload, 'ABORTED');
    expect(idle.destroyed).toBe(true);
    expect(memory.size).toBe(0);
  }, 2000);

  it('rejects with ABORTED for an already-aborted signal and aborts mid-stream', async () => {
    const { media, memory } = setup({ validation: { maxSizeBytes: 100 * MB } });
    await expectCode(
      media.upload({ body: 'x', fileName: 'x', contentType: 'text/plain', signal: AbortSignal.abort() }),
      'ABORTED',
    );
    const controller = new AbortController();
    const { stream } = countingStream(50 * MB, 64 * 1024);
    const onProgress = vi.fn(({ loadedBytes }) => {
      if (loadedBytes > MB) controller.abort();
    });
    await expectCode(
      media.upload({ body: stream, fileName: 'x', contentType: 'application/octet-stream', signal: controller.signal, onProgress }),
      'ABORTED',
    );
    expect(memory.size).toBe(0);
  });

  it('validates input shape', async () => {
    const { media } = setup();
    await expectCode(media.upload(undefined as never), 'UPLOAD_FAILED');
    await expectCode(media.upload({ body: 'x', fileName: ' ', contentType: 'text/plain' }), 'UPLOAD_FAILED');
    await expectCode(media.upload({ body: 42 as never, fileName: 'a', contentType: 'text/plain' }), 'UPLOAD_FAILED');
    await expectCode(media.upload({ body: 'x', fileName: 'a', contentType: 'text/plain', metadata: { 'bad key': 'x' } }), 'CONFIG_ERROR');
    await expectCode(media.upload({ body: 'x', fileName: 'a', contentType: 'text/plain', metadata: { a: 1 as never } }), 'CONFIG_ERROR');
    await expectCode(media.upload({ body: 'x', fileName: 'a', contentType: 'text/plain', visibility: 'world' as never }), 'CONFIG_ERROR');
  });
});

describe('createPresignedUpload', () => {
  it('returns a presigned post that the storage accepts', async () => {
    const { media, memory } = setup({ keyPrefix: 'cbt', validation: { maxSizeBytes: 1000 } });
    const presigned = await media.createPresignedUpload({ fileName: 'Scan.pdf', contentType: 'application/pdf', folder: 'docs', metadata: { owner: 'u1' } });
    expect(presigned).toMatchObject({ method: 'POST', maxSizeBytes: 1000 });
    expect(presigned.key).toMatch(/^cbt\/docs\/\d{4}\/\d{2}\/[0-9a-f-]{36}-scan\.pdf$/);
    expect(presigned.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000);
    expect(presigned.fields['Content-Type']).toBe('application/pdf');

    await memory.acceptPresignedPost(presigned.fields, samples.pdf);
    const head = await media.head(presigned.key);
    expect(head).toMatchObject({ size: samples.pdf.length, contentType: 'application/pdf', metadata: { owner: 'u1' } });
  });

  it('enforces the limits on the storage side', async () => {
    const { media, memory } = setup();
    const presigned = await media.createPresignedUpload({ fileName: 'a.png', contentType: 'image/png', maxSizeBytes: 10 });
    await expectCode(memory.acceptPresignedPost(presigned.fields, Buffer.alloc(11)), 'UPLOAD_FAILED');
    await expectCode(memory.acceptPresignedPost({ ...presigned.fields, 'Content-Type': 'image/gif' }, Buffer.alloc(1)), 'ACCESS_DENIED');
    await expectCode(memory.acceptPresignedPost({ ...presigned.fields, key: 'other' }, Buffer.alloc(1)), 'ACCESS_DENIED');
    await expectCode(memory.acceptPresignedPost({ ...presigned.fields, signature: 'f'.repeat(64) }, Buffer.alloc(1)), 'ACCESS_DENIED');

    vi.useFakeTimers({ now: Date.now() + 301_000 });
    try {
      await expectCode(memory.acceptPresignedPost(presigned.fields, Buffer.alloc(1)), 'ACCESS_DENIED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks the content type before signing', async () => {
    const { media, memory } = setup({ validation: { allowedMimeTypes: ['image/*'] } });
    const spy = vi.spyOn(memory, 'presignedPost');
    await expectCode(media.createPresignedUpload({ fileName: 'a.pdf', contentType: 'application/pdf' }), 'UNSUPPORTED_TYPE');
    expect(spy).not.toHaveBeenCalled();
  });

  it('validates options', async () => {
    const { media } = setup({ validation: { maxSizeBytes: 100 } });
    await expectCode(media.createPresignedUpload({ fileName: 'a', contentType: 'text/plain', maxSizeBytes: 101 }), 'FILE_TOO_LARGE');
    await expectCode(media.createPresignedUpload({ fileName: 'a', contentType: 'text/plain', maxSizeBytes: 0 }), 'CONFIG_ERROR');
    await expectCode(media.createPresignedUpload({ fileName: 'a', contentType: 'text/plain', expiresInSeconds: 604801 }), 'CONFIG_ERROR');
    await expectCode(media.createPresignedUpload({ fileName: '', contentType: 'text/plain' }), 'UPLOAD_FAILED');
    const explicit = await media.createPresignedUpload({ fileName: 'a', contentType: 'text/plain', key: 'x/y.txt' });
    expect(explicit.key).toBe('x/y.txt');
  });
});

describe('reading', () => {
  it('getSignedUrl signs a link that works until expiry, with a download name', async () => {
    const { media, memory } = setup();
    const obj = await media.upload({ body: samples.pdf, fileName: 'a.pdf', contentType: 'application/pdf' });
    const url = await media.getSignedUrl(obj.key, { expiresInSeconds: 60, downloadFileName: 'Report "Q1".pdf' });
    const resolved = await memory.resolveSignedUrl(url);
    expect(resolved.body.equals(samples.pdf)).toBe(true);
    expect(resolved.contentDisposition).toBe(`attachment; filename="Report Q1.pdf"; filename*=UTF-8''Report%20%22Q1%22.pdf`);

    const inline = await memory.resolveSignedUrl(await media.getSignedUrl(obj.key, { inline: true }));
    expect(inline.contentDisposition).toBe('inline');

    vi.useFakeTimers({ now: Date.now() + 61_000 });
    try {
      await expectCode(memory.resolveSignedUrl(url), 'ACCESS_DENIED');
    } finally {
      vi.useRealTimers();
    }
    await expectCode(media.getSignedUrl(obj.key, { expiresInSeconds: 604801 }), 'CONFIG_ERROR');
    await expectCode(media.getSignedUrl('../x'), 'INVALID_KEY');
  });

  it('getPublicUrl needs publicBaseUrl', () => {
    expect(() => setup().media.getPublicUrl('a.png')).toThrow(expect.objectContaining({ code: 'CONFIG_ERROR' }));
    expect(setup({ publicBaseUrl: 'https://cdn.evrree.com/' }).media.getPublicUrl('cbt/a.png')).toBe('https://cdn.evrree.com/cbt/a.png');
  });

  it('getStream and getBuffer return the content', async () => {
    const { media } = setup();
    const obj = await media.upload({ body: samples.jpeg, fileName: 'a.jpg', contentType: 'image/jpeg' });
    const { body, object } = await media.getStream(obj.key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(samples.jpeg)).toBe(true);
    expect(object.key).toBe(obj.key);
    expect((await media.getBuffer(obj.key)).body.equals(samples.jpeg)).toBe(true);
  });

  it('getBuffer refuses files over maxSizeBytes', async () => {
    const memory = new MemoryStorageProvider();
    const big = createMediaClient({ provider: { type: 'custom', instance: memory }, validation: { maxSizeBytes: 100 } });
    const small = createMediaClient({ provider: { type: 'custom', instance: memory }, validation: { maxSizeBytes: 50 } });
    const obj = await big.upload({ body: Buffer.alloc(80), fileName: 'a', contentType: 'application/octet-stream' });
    await expectCode(small.getBuffer(obj.key), 'FILE_TOO_LARGE');
    await expect(small.getStream(obj.key)).resolves.toBeTruthy();
  });

  it('missing keys: head -> null, reads and copy -> NOT_FOUND, delete succeeds (AC19)', async () => {
    const { media } = setup();
    expect(await media.head('nope.png')).toBeNull();
    expect(await media.exists('nope.png')).toBe(false);
    await expectCode(media.getStream('nope.png'), 'NOT_FOUND');
    await expectCode(media.getBuffer('nope.png'), 'NOT_FOUND');
    await expectCode(media.copy('nope.png', 'other.png'), 'NOT_FOUND');
    await expectCode(media.move('nope.png', 'other.png'), 'NOT_FOUND');
    await expectCode(media.updateMetadata('nope.png', {}), 'NOT_FOUND');
    await expect(media.delete('nope.png')).resolves.toBeUndefined();
  });
});

describe('deleting', () => {
  it('delete removes the object', async () => {
    const { media } = setup();
    const obj = await media.upload({ body: 'x', fileName: 'x.txt', contentType: 'text/plain' });
    await media.delete(obj.key);
    expect(await media.exists(obj.key)).toBe(false);
  });

  it('deleteMany batches by 1000 and reports failures without throwing (AC20)', async () => {
    const { media, memory } = setup();
    const keys = Array.from({ length: 2500 }, (_, i) => `bulk/${i}.txt`);
    for (const key of keys.slice(0, 10)) await media.upload({ body: 'x', fileName: key, contentType: 'text/plain', key });
    const spy = vi.spyOn(memory, 'delete');
    const result = await media.deleteMany([...keys, '../bad']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1000, 500]);
    expect(result.deleted).toHaveLength(2500);
    expect(result.failed).toEqual([{ key: '../bad', error: expect.objectContaining({ code: 'INVALID_KEY' }) }]);
    expect(memory.size).toBe(0);
  });

  it('deleteMany turns provider failures into per-key MediaErrors', async () => {
    const { media, memory } = setup();
    vi.spyOn(memory, 'delete')
      .mockResolvedValueOnce({ deleted: ['a'], failed: [{ key: 'b', error: new Error('boom') }] })
      .mockRejectedValueOnce(new Error('network down'));
    const keys = [...Array.from({ length: 1000 }, (_, i) => `k${i}`)];
    keys[0] = 'a';
    keys[1] = 'b';
    const result = await media.deleteMany([...keys, 'c']);
    expect(result.deleted).toEqual(['a']);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]).toMatchObject({ key: 'b', error: { code: 'PROVIDER_ERROR' } });
    expect(result.failed[1]).toMatchObject({ key: 'c', error: { code: 'PROVIDER_ERROR', message: expect.stringContaining('network down') } });
    expect(result.failed.every((f) => f.error instanceof MediaError)).toBe(true);
  });

  it('delete throws the provider failure', async () => {
    const { media, memory } = setup();
    vi.spyOn(memory, 'delete').mockResolvedValueOnce({ deleted: [], failed: [{ key: 'a', error: new Error('denied') }] });
    await expectCode(media.delete('a'), 'PROVIDER_ERROR');
  });
});

describe('copy, move, updateMetadata', () => {
  it('copy duplicates content and can override visibility/metadata', async () => {
    const { media } = setup({ keyPrefix: 'cbt', publicBaseUrl: 'https://cdn.x' });
    const src = await media.upload({ body: samples.png, fileName: 'a.png', contentType: 'image/png', metadata: { a: '1' } });
    const same = await media.copy(src.key, 'copies/a.png');
    expect(same).toMatchObject({ key: 'cbt/copies/a.png', visibility: 'private', metadata: { a: '1' }, contentType: 'image/png' });
    const changed = await media.copy(src.key, 'cbt/copies/b.png', { visibility: 'public', metadata: { b: '2' } });
    expect(changed).toMatchObject({ key: 'cbt/copies/b.png', visibility: 'public', metadata: { b: '2' }, url: 'https://cdn.x/cbt/copies/b.png' });
    expect((await media.getBuffer(changed.key)).body.equals(samples.png)).toBe(true);
    expect(await media.exists(src.key)).toBe(true);
  });

  it('move copies then deletes the source', async () => {
    const { media } = setup();
    const src = await media.upload({ body: 'x', fileName: 'a.txt', contentType: 'text/plain' });
    const moved = await media.move(src.key, 'moved/a.txt');
    expect(moved.key).toBe('moved/a.txt');
    expect(await media.exists(src.key)).toBe(false);
    expect(await media.exists('moved/a.txt')).toBe(true);
  });

  it('move onto itself keeps the file', async () => {
    const { media } = setup();
    const src = await media.upload({ body: 'x', fileName: 'a.txt', contentType: 'text/plain', key: 'a.txt' });
    await media.move(src.key, src.key);
    expect(await media.exists(src.key)).toBe(true);
  });

  it('move surfaces a failed delete but keeps the copy', async () => {
    const { media, memory } = setup();
    const src = await media.upload({ body: 'x', fileName: 'a.txt', contentType: 'text/plain' });
    vi.spyOn(memory, 'delete').mockResolvedValueOnce({ deleted: [], failed: [{ key: src.key, error: new MediaError('ACCESS_DENIED', 'no') }] });
    const error = await expectCode(media.move(src.key, 'moved/a.txt'), 'ACCESS_DENIED');
    expect(error.message).toContain('moved/a.txt');
    expect(await media.exists('moved/a.txt')).toBe(true);
    expect(await media.exists(src.key)).toBe(true);
  });

  it('updateMetadata replaces metadata and optionally visibility', async () => {
    const { media } = setup({ publicBaseUrl: 'https://cdn.x' });
    const src = await media.upload({ body: samples.png, fileName: 'a.png', contentType: 'image/png', metadata: { old: '1' } });
    const updated = await media.updateMetadata(src.key, { New: '2' });
    expect(updated).toMatchObject({ key: src.key, metadata: { new: '2' }, visibility: 'private', contentType: 'image/png' });
    const pub = await media.updateMetadata(src.key, { new: '3' }, { visibility: 'public' });
    expect(pub).toMatchObject({ visibility: 'public', url: `https://cdn.x/${src.key}` });
  });
});

describe('list', () => {
  it('paginates with a cursor and stays inside keyPrefix (AC7, AC21)', async () => {
    const memory = new MemoryStorageProvider();
    const other = createMediaClient({ provider: { type: 'custom', instance: memory }, keyPrefix: 'other' });
    const media = createMediaClient({ provider: { type: 'custom', instance: memory }, keyPrefix: 'cbt' });
    await other.upload({ body: 'x', fileName: 'x.txt', contentType: 'text/plain' });
    await media.upload({ body: 'x', fileName: 'x.txt', contentType: 'text/plain', key: 'cbtx.txt' });
    for (let i = 0; i < 7; i++) {
      await media.upload({ body: 'x', fileName: `${i}.txt`, contentType: 'text/plain', key: `docs/${i}.txt` });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await media.list({ prefix: 'docs', limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.key));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `cbt/docs/${i}.txt`));

    const all = await media.list();
    expect(all.items.map((i) => i.key).every((k) => k.startsWith('cbt/'))).toBe(true);
    expect(all.items).toHaveLength(8);
    expect((await media.list({ prefix: 'cbt/docs' })).items).toHaveLength(7);
    expect((await media.list({ prefix: 'cbt' })).items).toHaveLength(8);
    // Returned keys go straight back into other methods.
    await expect(media.head(all.items[0]!.key)).resolves.not.toBeNull();
  });

  it('clamps limit and validates prefix', async () => {
    const { media, memory } = setup();
    const spy = vi.spyOn(memory, 'list');
    await media.list({ limit: 5000 });
    await media.list({ limit: 0 });
    expect(spy.mock.calls.map(([o]) => o.limit)).toEqual([1000, 1]);
    await expectCode(media.list({ prefix: '../x' }), 'INVALID_KEY');
    await expectCode(media.list({ limit: Number.NaN }), 'CONFIG_ERROR');
  });
});

describe('key validation on every method (AC22)', () => {
  const bad = ['../etc/passwd', '/abs', 'a\\b', ''];
  it.each(bad)('rejects %j everywhere', async (key) => {
    const { media } = setup();
    await expectCode(media.head(key), 'INVALID_KEY');
    await expectCode(media.exists(key), 'INVALID_KEY');
    await expectCode(media.getStream(key), 'INVALID_KEY');
    await expectCode(media.getBuffer(key), 'INVALID_KEY');
    await expectCode(media.getSignedUrl(key), 'INVALID_KEY');
    await expectCode(() => media.getPublicUrl(key), 'INVALID_KEY');
    await expectCode(media.delete(key), 'INVALID_KEY');
    await expectCode(media.copy(key, 'ok'), 'INVALID_KEY');
    await expectCode(media.copy('ok', key), 'INVALID_KEY');
    await expectCode(media.move(key, 'ok'), 'INVALID_KEY');
    await expectCode(media.updateMetadata(key, {}), 'INVALID_KEY');
    if (key) {
      await expectCode(media.upload({ body: 'x', fileName: 'x', contentType: 'text/plain', key }), 'INVALID_KEY');
      await expectCode(media.createPresignedUpload({ fileName: 'x', contentType: 'text/plain', key }), 'INVALID_KEY');
    }
    expect((await media.deleteMany([key])).failed[0]!.error.code).toBe('INVALID_KEY');
  });
});

describe('custom providers and error wrapping (AC23)', () => {
  it('wraps raw errors from any provider method as PROVIDER_ERROR with cause', async () => {
    const raw = new Error('socket hang up');
    const fail = async () => {
      throw raw;
    };
    const instance: StorageProvider = {
      put: fail, get: fail, head: fail, delete: fail, copy: fail, list: fail, signedGetUrl: fail, presignedPost: fail,
    };
    const media = createMediaClient({ provider: { type: 'custom', instance } });
    const calls = [
      media.upload({ body: 'x', fileName: 'x', contentType: 'text/plain' }),
      media.createPresignedUpload({ fileName: 'x', contentType: 'text/plain' }),
      media.getSignedUrl('k'),
      media.getStream('k'),
      media.getBuffer('k'),
      media.head('k'),
      media.exists('k'),
      media.delete('k'),
      media.copy('k', 'j'),
      media.move('k', 'j'),
      media.list(),
      media.updateMetadata('k', {}),
    ];
    for (const call of calls) {
      const error = await expectCode(call, 'PROVIDER_ERROR');
      expect(error.cause).toBe(raw);
    }
    const many = await media.deleteMany(['k']);
    expect(many.failed[0]!.error).toMatchObject({ code: 'PROVIDER_ERROR', cause: raw });
  });

  it('maps a raw AbortError to ABORTED', async () => {
    const instance = new MemoryStorageProvider();
    vi.spyOn(instance, 'put').mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const media = createMediaClient({ provider: { type: 'custom', instance } });
    await expectCode(media.upload({ body: 'x', fileName: 'x', contentType: 'text/plain' }), 'ABORTED');
  });
});

describe('logging (AC24)', () => {
  it('never logs secrets, file contents or signed URLs', async () => {
    const { lines, logger } = captureLogger();
    const secretBody = 'TOP-SECRET-FILE-CONTENT';
    const media = createMediaClient({ provider: { type: 'memory' }, logger, publicBaseUrl: 'https://cdn.x' });
    const memory = media.provider as MemoryStorageProvider;

    const obj = await media.upload({ body: secretBody, fileName: 'secret.txt', contentType: 'text/plain', metadata: { token: 'META-SECRET' } });
    const signedUrl = await media.getSignedUrl(obj.key, { downloadFileName: 'x.txt' });
    const presigned = await media.createPresignedUpload({ fileName: 'a.txt', contentType: 'text/plain' });
    await memory.acceptPresignedPost(presigned.fields, 'x');
    await media.getBuffer(obj.key);
    await media.copy(obj.key, 'copy.txt');
    await media.move('copy.txt', 'moved.txt');
    await media.updateMetadata('moved.txt', { token: 'META-SECRET' });
    await media.list();
    await media.deleteMany(['moved.txt']);
    await media.delete(obj.key);
    await media.getStream('missing').catch(() => undefined);

    const output = lines.join('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(output).not.toContain(secretBody);
    expect(output).not.toContain('META-SECRET');
    expect(output).not.toContain(signedUrl);
    expect(output).not.toContain(new URL(signedUrl).search.slice(1, 30));
    expect(output).not.toContain(presigned.fields.signature!);
    expect(output).not.toContain(presigned.fields.policy!);
    expect(output).not.toMatch(/memory:\/\//);
  });

  it('does not log S3 credentials', async () => {
    const { lines, logger } = captureLogger();
    const media = createMediaClient({
      provider: {
        type: 's3', bucket: 'b', region: 'eu-west-1', endpoint: 'http://127.0.0.1:1',
        credentials: { accessKeyId: 'AKIDLOGTEST', secretAccessKey: 'SECRETLOGTEST' },
      },
      logger,
    });
    await media.getSignedUrl('a.txt');
    await media.createPresignedUpload({ fileName: 'a.txt', contentType: 'text/plain' });
    const output = lines.join('\n');
    expect(output).not.toContain('SECRETLOGTEST');
    expect(output).not.toContain('AKIDLOGTEST');
    expect(output).not.toContain('X-Amz-Signature');
  });

  it('survives a throwing logger', async () => {
    const logger = { info: () => { throw new Error('logger broke'); } };
    const media = createMediaClient({ provider: { type: 'memory' }, logger });
    await expect(media.upload({ body: 'x', fileName: 'x', contentType: 'text/plain' })).resolves.toBeTruthy();
  });
});
