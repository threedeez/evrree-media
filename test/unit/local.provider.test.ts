import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalMediaHandler, createMediaClient, LocalStorageProvider, MediaError, type MediaClient } from '../../src';
import { captureLogger, samples } from '../fixtures';

let root: string;
let outside: string;
let media: MediaClient;
let provider: LocalStorageProvider;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'evrree-media-local-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await mkdir(outside, { recursive: true });
  media = createMediaClient({
    provider: { type: 'local', rootDir: root, baseUrl: 'http://localhost:4000/media' },
    keyPrefix: 'cbt',
  });
  provider = media.provider as LocalStorageProvider;
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
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

describe('local provider operations (AC17)', () => {
  it('writes files under rootDir at their key and reads them back', async () => {
    const obj = await media.upload({ body: samples.png, fileName: 'A.png', contentType: 'image/png', metadata: { a: '1' } });
    expect(await readFile(path.join(root, ...obj.key.split('/')))).toEqual(samples.png);
    expect(await media.head(obj.key)).toMatchObject({ size: samples.png.length, contentType: 'image/png', metadata: { a: '1' }, visibility: 'private' });
    expect((await media.getBuffer(obj.key)).body.equals(samples.png)).toBe(true);
    // Public URLs default to the local baseUrl.
    const pub = await media.upload({ body: samples.png, fileName: 'b.png', contentType: 'image/png', visibility: 'public' });
    expect(pub.url).toBe(`http://localhost:4000/media/${pub.key}`);
  });

  it('streams uploads with progress and cleans up on abort', async () => {
    const onProgress = vi.fn();
    const obj = await media.upload({
      body: Readable.from([Buffer.alloc(1000), Buffer.alloc(1000)]),
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      onProgress,
    });
    expect(obj.size).toBe(2000);
    expect(onProgress.mock.lastCall![0].loadedBytes).toBe(2000);

    const controller = new AbortController();
    const slow = new Readable({ read() {} });
    const promise = media.upload({ body: slow, fileName: 'slow.bin', contentType: 'application/octet-stream', signal: controller.signal, key: 'slow.bin' });
    slow.push(Buffer.alloc(100));
    setTimeout(() => controller.abort(), 20);
    await expectCode(promise, 'ABORTED');
    expect(await media.exists('cbt/slow.bin')).toBe(false);
    expect(await readdir(path.join(root, '.evrree-meta', 'tmp'))).toEqual([]);
  });

  it('copy, move, updateMetadata, delete, deleteMany', async () => {
    const src = await media.upload({ body: 'hello', fileName: 'a.txt', contentType: 'text/plain', key: 'a.txt', metadata: { x: '1' } });
    const copy = await media.copy(src.key, 'b.txt', { metadata: { y: '2' } });
    expect(copy).toMatchObject({ key: 'cbt/b.txt', metadata: { y: '2' }, contentType: 'text/plain' });
    const moved = await media.move('cbt/b.txt', 'nested/c.txt');
    expect(moved.key).toBe('cbt/nested/c.txt');
    expect(await media.exists('cbt/b.txt')).toBe(false);
    const updated = await media.updateMetadata(moved.key, { z: '3' }, { visibility: 'public' });
    expect(updated).toMatchObject({ metadata: { z: '3' }, visibility: 'public' });
    expect((await media.getBuffer(moved.key)).body.toString()).toBe('hello');
    await media.delete(src.key);
    await media.delete(src.key);
    expect(await media.exists(src.key)).toBe(false);
    const result = await media.deleteMany([moved.key, 'cbt/never-existed']);
    expect(result).toEqual({ deleted: [moved.key, 'cbt/never-existed'], failed: [] });
    await expectCode(media.getStream(src.key), 'NOT_FOUND');
    await expectCode(media.copy(src.key, 'x'), 'NOT_FOUND');
  });

  it('lists with pagination, skipping its own metadata directory', async () => {
    for (let i = 0; i < 5; i++) await media.upload({ body: 'x', fileName: 'x', contentType: 'text/plain', key: `docs/${i}.txt` });
    await writeFile(path.join(root, 'stray.txt'), 'outside the prefix');
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await media.list({ prefix: 'docs/', limit: 2, ...(cursor ? { cursor } : {}) });
      pages.push(page.items.map((i) => i.key));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual([
      ['cbt/docs/0.txt', 'cbt/docs/1.txt'],
      ['cbt/docs/2.txt', 'cbt/docs/3.txt'],
      ['cbt/docs/4.txt'],
    ]);
    const unscoped = createMediaClient({ provider: { type: 'local', rootDir: root, baseUrl: 'http://localhost:4000/media' } });
    const all = (await unscoped.list()).items.map((i) => i.key);
    expect(all).toContain('stray.txt');
    expect(all.some((k) => k.includes('.evrree-meta'))).toBe(false);
    // A file written without the SDK still has sensible metadata.
    expect(await unscoped.head('stray.txt')).toMatchObject({ contentType: 'application/octet-stream', metadata: {} });
  });

  it('lists an empty or missing root', async () => {
    expect((await media.list()).items).toEqual([]);
  });
});

describe('path traversal protection (AC22)', () => {
  it.each(['../outside/x.txt', '/etc/passwd', 'a\\..\\b', ''])('the client rejects %j', async (key) => {
    await expectCode(media.head(key), 'INVALID_KEY');
    await expectCode(media.getBuffer(key), 'INVALID_KEY');
  });

  it.each(['../outside/x.txt', 'a/../../outside/x.txt', '.evrree-meta/objects/x.json', 'a//b', 'a/./b', 'trailing/'])(
    'the provider itself refuses %j',
    async (key) => {
      await expectCode(provider.put(key, 'x', { contentType: 'text/plain', visibility: 'private', metadata: {} }), 'INVALID_KEY');
      await expectCode(provider.get(key), 'INVALID_KEY');
      await expectCode(provider.head(key), 'INVALID_KEY');
      await expectCode(provider.copy('a', key, {}).catch(async (e) => {
        if ((e as MediaError).code === 'NOT_FOUND') {
          await provider.put('a', 'x', { contentType: 'text/plain', visibility: 'private', metadata: {} });
          return provider.copy('a', key, {});
        }
        throw e;
      }), 'INVALID_KEY');
      await expectCode(provider.signedGetUrl(key, { expiresInSeconds: 1 }), 'INVALID_KEY');
      const result = await provider.delete([key]);
      expect(result.failed[0]!.error).toMatchObject({ code: 'INVALID_KEY' });
    },
  );

  it('does not follow a symlink out of rootDir', async () => {
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await mkdir(root, { recursive: true });
    await symlink(outside, path.join(root, 'link'));
    await expectCode(provider.get('link/secret.txt'), 'INVALID_KEY');
    await expectCode(provider.put('link/new.txt', 'x', { contentType: 'text/plain', visibility: 'private', metadata: {} }), 'INVALID_KEY');
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });
});

describe('production warning (AC25)', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('warns through the logger when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    const { lines, logger } = captureLogger();
    createMediaClient({ provider: { type: 'local', rootDir: root, baseUrl: 'http://x' }, logger });
    expect(lines.filter((l) => l.startsWith('warn'))).toHaveLength(1);
    expect(lines[0]).toContain('development only');
  });

  it('falls back to console.warn and stays quiet outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NODE_ENV = 'production';
    createMediaClient({ provider: { type: 'local', rootDir: root, baseUrl: 'http://x' } });
    process.env.NODE_ENV = 'development';
    createMediaClient({ provider: { type: 'local', rootDir: root, baseUrl: 'http://x' } });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('local media handler', () => {
  let server: Server;
  let base: string;
  let serverRoot: string;
  let client: MediaClient;

  beforeAll(async () => {
    serverRoot = await mkdtemp(path.join(tmpdir(), 'evrree-media-handler-'));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/media`;
    const config = { rootDir: serverRoot, baseUrl: base, signingSecret: 'test-secret' };
    const handler = createLocalMediaHandler(config);
    server.on('request', (req, res) => {
      if (req.url?.startsWith('/media')) handler(req, res);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    client = createMediaClient({ provider: { type: 'local', ...config }, keyPrefix: 'app', validation: { maxSizeBytes: 1000 } });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(serverRoot, { recursive: true, force: true });
  });

  const postForm = async (url: string, fields: Record<string, string>, file: Blob) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file, 'upload.bin');
    return fetch(url, { method: 'POST', body: form });
  };

  it('accepts a browser upload through a presigned post, then head() finds it', async () => {
    const presigned = await client.createPresignedUpload({ fileName: 'Doc.pdf', contentType: 'application/pdf', metadata: { owner: 'u1' } });
    const res = await postForm(presigned.url, presigned.fields, new Blob([samples.pdf]));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await client.head(presigned.key)).toMatchObject({ size: samples.pdf.length, contentType: 'application/pdf', metadata: { owner: 'u1' } });
  });

  it('rejects oversize files, a different content type and tampered fields', async () => {
    const presigned = await client.createPresignedUpload({ fileName: 'a.png', contentType: 'image/png', maxSizeBytes: 100 });
    const tooBig = await postForm(presigned.url, presigned.fields, new Blob([Buffer.alloc(101)]));
    expect(tooBig.status).toBe(400);
    expect(await tooBig.text()).toContain('<Code>EntityTooLarge</Code>');
    const wrongType = await postForm(presigned.url, { ...presigned.fields, 'Content-Type': 'image/gif' }, new Blob(['x']));
    expect(wrongType.status).toBe(403);
    const otherKey = await postForm(presigned.url, { ...presigned.fields, key: 'app/elsewhere.png' }, new Blob(['x']));
    expect(otherKey.status).toBe(403);
    const noFile = await fetch(presigned.url, { method: 'POST', body: new URLSearchParams(presigned.fields) });
    expect(noFile.status).toBe(400);
    expect(await client.exists(presigned.key)).toBe(false);
  });

  it('serves private files only through signed URLs, with download names and expiry', async () => {
    const obj = await client.upload({ body: 'private data', fileName: 'r.txt', contentType: 'text/plain' });
    expect((await fetch(`${base}/${obj.key}`)).status).toBe(403);

    const url = await client.getSignedUrl(obj.key, { downloadFileName: 'Report.txt', expiresInSeconds: 60 });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('private data');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Report.txt"; filename*=UTF-8''Report.txt`);
    expect(res.headers.get('content-type')).toBe('text/plain');

    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('12');

    const tampered = url.replace(/X-Evrree-Expires=\d+/, 'X-Evrree-Expires=9999999999999');
    expect((await fetch(tampered)).status).toBe(403);

    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    try {
      expect((await fetch(url)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves public files directly and 404s missing ones', async () => {
    const obj = await client.upload({ body: samples.png, fileName: 'p.png', contentType: 'image/png', visibility: 'public' });
    const res = await fetch(obj.url!);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(samples.png)).toBe(true);
    const missing = await fetch(await client.getSignedUrl('app/missing.png'));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('NoSuchKey');
  });

  it('answers CORS preflight and rejects other methods', async () => {
    expect((await fetch(`${base}/`, { method: 'OPTIONS' })).status).toBe(204);
    expect((await fetch(`${base}/x`, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(`${base}/..%2Fsecret`)).status).toBe(400);
  });
});
