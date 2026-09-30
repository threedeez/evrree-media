import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MediaError, type MediaClient } from '../../src';
import { samples } from '../fixtures';
import { ensureBucket, minioClient, postForm, s3Config } from './minio';

const MB = 1024 * 1024;
let media: MediaClient;

beforeAll(async () => {
  await ensureBucket();
  media = minioClient();
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<MediaError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MediaError);
  expect((error as MediaError).code).toBe(code);
  return error as MediaError;
}

describe('presigned POST against MinIO', () => {
  it('uploads through the presigned post and head() finds it (AC14)', async () => {
    const presigned = await media.createPresignedUpload({
      fileName: 'Scan 1.pdf',
      contentType: 'application/pdf',
      folder: 'docs',
      metadata: { uploadedBy: 'user_1' },
    });
    const res = await postForm(presigned.url, presigned.fields, new Blob([samples.pdf], { type: 'application/pdf' }));
    expect(res.status, await res.clone().text()).toBe(204);

    const head = await media.head(presigned.key);
    expect(head).toMatchObject({
      key: presigned.key,
      size: samples.pdf.length,
      contentType: 'application/pdf',
      visibility: 'private',
      metadata: { uploadedby: 'user_1' },
    });
  });

  it('storage rejects a file over maxSizeBytes (AC15)', async () => {
    const presigned = await media.createPresignedUpload({ fileName: 'a.png', contentType: 'image/png', maxSizeBytes: 1024 });
    const res = await postForm(presigned.url, presigned.fields, new Blob([Buffer.alloc(1025)]));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toMatch(/EntityTooLarge|exceeds the maximum/);
    expect(await media.exists(presigned.key)).toBe(false);
  });

  it('storage rejects a different content type (AC15)', async () => {
    const presigned = await media.createPresignedUpload({ fileName: 'a.png', contentType: 'image/png' });
    const res = await postForm(presigned.url, { ...presigned.fields, 'Content-Type': 'text/html' }, new Blob(['<script>']));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('AccessDenied');
    expect(await media.exists(presigned.key)).toBe(false);
  });

  it('storage rejects a different key', async () => {
    const presigned = await media.createPresignedUpload({ fileName: 'a.png', contentType: 'image/png' });
    const res = await postForm(presigned.url, { ...presigned.fields, key: `${media.keyPrefix}/hijack.png` }, new Blob([samples.png]));
    expect(res.status).toBe(403);
  });
});

describe('signed GET URLs (AC18)', () => {
  it('work until expiry and stop afterwards', async () => {
    const obj = await media.upload({ body: 'secret report', fileName: 'r.txt', contentType: 'text/plain' });
    // Private objects are not reachable without a signature.
    expect((await fetch(media.getPublicUrl(obj.key))).status).toBe(403);

    const url = await media.getSignedUrl(obj.key, { expiresInSeconds: 2 });
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('secret report');

    await new Promise((resolve) => setTimeout(resolve, 3500));
    const expired = await fetch(url);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toMatch(/expired/i);
  });

  it('downloadFileName sets an attachment Content-Disposition', async () => {
    const obj = await media.upload({ body: samples.pdf, fileName: 'x.pdf', contentType: 'application/pdf' });
    const res = await fetch(await media.getSignedUrl(obj.key, { downloadFileName: 'Résultats Q1.pdf' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Resultats Q1.pdf"; filename*=UTF-8''R%C3%A9sultats%20Q1.pdf`,
    );
    const inline = await fetch(await media.getSignedUrl(obj.key, { inline: true }));
    expect(inline.headers.get('content-disposition')).toBe('inline');
    // Uploads also store an inline disposition with the original name.
    expect((await fetch(await media.getSignedUrl(obj.key))).headers.get('content-disposition')).toContain('filename="x.pdf"');
  });
});

describe('list pagination (AC21)', () => {
  it('pages through at least 3 pages with a cursor', async () => {
    const client = minioClient();
    const keys: string[] = [];
    for (let i = 0; i < 7; i++) {
      keys.push((await client.upload({ body: `n${i}`, fileName: 'n.txt', contentType: 'text/plain', key: `pages/${i}.txt` })).key);
    }
    await client.upload({ body: 'x', fileName: 'x.txt', contentType: 'text/plain', key: 'elsewhere/x.txt' });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.list({ prefix: 'pages/', limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((item) => item.key));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(keys);

    const everything = await client.list({ includeMetadata: true });
    expect(everything.items).toHaveLength(8);
    expect(everything.items.every((item) => item.key.startsWith(`${client.keyPrefix}/`))).toBe(true);
    expect(everything.items[0]!.contentType).toBe('text/plain');
  });
});

describe('uploads', () => {
  it('multipart uploads over 8 MB with progress per part (AC11)', async () => {
    const size = 20 * MB;
    const body = Buffer.alloc(size, 7);
    const onProgress = vi.fn();
    const obj = await media.upload({ body, fileName: 'big.bin', contentType: 'application/octet-stream', onProgress });
    expect(obj.size).toBe(size);
    expect(obj.etag).toMatch(/-3"$/); // multipart ETags end in -<part count>
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(3);
    const head = await media.head(obj.key);
    expect(head!.size).toBe(size);
  });

  it('streams of unknown length upload and round-trip', async () => {
    const chunks = Array.from({ length: 12 }, (_, i) => Buffer.alloc(MB, i));
    const obj = await media.upload({ body: Readable.from(chunks), fileName: 'stream.bin', contentType: 'application/octet-stream' });
    expect(obj.size).toBe(12 * MB);
    const { body } = await media.getBuffer(obj.key);
    expect(body.equals(Buffer.concat(chunks))).toBe(true);
  });

  it('aborting rejects with ABORTED and leaves nothing behind (AC11)', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn(() => controller.abort());
    const promise = media.upload({
      body: Buffer.alloc(40 * MB),
      fileName: 'abort.bin',
      contentType: 'application/octet-stream',
      key: 'abort.bin',
      signal: controller.signal,
      onProgress,
    });
    await expectCode(promise, 'ABORTED');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await media.exists(`${media.keyPrefix}/abort.bin`)).toBe(false);
  });

  it('public uploads return a working public URL (AC12)', async () => {
    const obj = await media.upload({ body: samples.png, fileName: 'p.png', contentType: 'image/png', visibility: 'public' });
    expect(obj.url).toBe(media.getPublicUrl(obj.key));
    expect((await media.head(obj.key))!.visibility).toBe('public');
  });
});

describe('reading, copying and deleting', () => {
  it('missing keys behave (AC19)', async () => {
    const missing = `${media.keyPrefix}/missing.txt`;
    expect(await media.head(missing)).toBeNull();
    await expectCode(media.getStream(missing), 'NOT_FOUND');
    await expectCode(media.getBuffer(missing), 'NOT_FOUND');
    await expectCode(media.copy(missing, 'x.txt'), 'NOT_FOUND');
    await expect(media.delete(missing)).resolves.toBeUndefined();
  });

  it('getStream proxies the content', async () => {
    const obj = await media.upload({ body: samples.jpeg, fileName: 'a.jpg', contentType: 'image/jpeg' });
    const { body, object } = await media.getStream(obj.key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).equals(samples.jpeg)).toBe(true);
    expect(object.contentType).toBe('image/jpeg');
  });

  it('copy, move and updateMetadata keep content headers', async () => {
    const src = await media.upload({ body: samples.png, fileName: 'orig.png', contentType: 'image/png', metadata: { a: '1' }, cacheControl: 'max-age=60' });
    const copy = await media.copy(src.key, 'copies/c.png', { metadata: { b: '2' } });
    expect(copy).toMatchObject({ contentType: 'image/png', metadata: { b: '2' }, size: samples.png.length });

    const updated = await media.updateMetadata(copy.key, { c: '3' }, { visibility: 'public' });
    expect(updated).toMatchObject({ contentType: 'image/png', metadata: { c: '3' }, visibility: 'public' });
    const res = await fetch(await media.getSignedUrl(copy.key));
    expect(res.headers.get('cache-control')).toBe('max-age=60');

    const moved = await media.move(copy.key, 'moved/m.png');
    expect(moved.key).toBe(`${media.keyPrefix}/moved/m.png`);
    expect(await media.exists(copy.key)).toBe(false);
    expect((await media.getBuffer(moved.key)).body.equals(samples.png)).toBe(true);
  });

  it('deleteMany removes existing and missing keys without throwing', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) keys.push((await media.upload({ body: 'x', fileName: 'd.txt', contentType: 'text/plain' })).key);
    const result = await media.deleteMany([...keys, `${media.keyPrefix}/never.txt`, '../bad']);
    expect(result.deleted).toHaveLength(6);
    expect(result.failed.map((f) => f.error.code)).toEqual(['INVALID_KEY']);
    for (const key of keys) expect(await media.exists(key)).toBe(false);
  });

  it('wrong credentials surface as ACCESS_DENIED, never a raw error', async () => {
    const bad = minioClient({
      provider: { ...s3Config, credentials: { accessKeyId: 'nope', secretAccessKey: 'nope-nope' } },
    });
    const error = await expectCode(bad.upload({ body: 'x', fileName: 'x', contentType: 'text/plain' }), 'ACCESS_DENIED');
    expect(error.statusCode).toBe(403);
    expect(error.cause).toBeDefined();
  });
});
