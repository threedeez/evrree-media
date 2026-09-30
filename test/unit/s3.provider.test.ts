import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaClient, MediaError, type MediaClientConfig } from '../../src';
import { mapS3Error, MULTIPART_PART_SIZE_BYTES, S3StorageProvider } from '../../src/providers/s3.provider';
import { samples } from '../fixtures';

const MB = 1024 * 1024;
const s3 = mockClient(S3Client);

const baseConfig: MediaClientConfig = {
  provider: {
    type: 's3',
    bucket: 'evrree-test',
    region: 'eu-west-1',
    credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
  },
  keyPrefix: 'cbt',
  publicBaseUrl: 'https://cdn.evrree.com',
  validation: { maxSizeBytes: 50 * MB },
};

const client = (overrides: Partial<MediaClientConfig> = {}) => createMediaClient({ ...baseConfig, ...overrides });

function awsError(name: string, status: number, Ctor: typeof S3ServiceException = S3ServiceException) {
  return new Ctor({ name, message: `${name} message`, $fault: 'client', $metadata: { httpStatusCode: status } } as never);
}

const headOutput = {
  ContentLength: 64,
  ContentType: 'image/png',
  ETag: '"etag"',
  LastModified: new Date('2026-01-01T00:00:00Z'),
  Metadata: { 'evrree-visibility': 'public', owner: 'u1' },
  CacheControl: 'max-age=60',
  ContentDisposition: 'inline; filename="a.png"',
};

beforeEach(() => s3.reset());
afterEach(() => vi.useRealTimers());

async function expectCode(promise: Promise<unknown>, code: string): Promise<MediaError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MediaError);
  expect((error as MediaError).code).toBe(code);
  return error as MediaError;
}

describe('S3 upload', () => {
  it('uses a single PutObject for small files with metadata and visibility', async () => {
    s3.on(PutObjectCommand).resolves({ ETag: '"abc"' });
    const onProgress = vi.fn();
    const obj = await client().upload({
      body: samples.png,
      fileName: 'My Avatar.png',
      contentType: 'image/png',
      visibility: 'public',
      metadata: { UploadedBy: 'user_1' },
      cacheControl: 'max-age=300',
      onProgress,
    });
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({
      Bucket: 'evrree-test',
      Key: obj.key,
      ContentType: 'image/png',
      CacheControl: 'max-age=300',
      Metadata: { uploadedby: 'user_1', 'evrree-visibility': 'public' },
    });
    expect(put.ContentDisposition).toContain('filename="My Avatar.png"');
    expect(put.ACL).toBeUndefined();
    expect(s3.commandCalls(CreateMultipartUploadCommand)).toHaveLength(0);
    expect(obj).toMatchObject({ etag: '"abc"', size: samples.png.length, visibility: 'public', url: `https://cdn.evrree.com/${obj.key}` });
    expect(obj.key).toMatch(/^cbt\/\d{4}\/\d{2}\/[0-9a-f-]{36}-my-avatar\.png$/);
    expect(onProgress).toHaveBeenCalledWith({ loadedBytes: samples.png.length, totalBytes: samples.png.length });
  });

  it('sends an ACL only when useAcl is set', async () => {
    s3.on(PutObjectCommand).resolves({});
    const media = client({ provider: { ...(baseConfig.provider as object), useAcl: true } as MediaClientConfig['provider'] });
    await media.upload({ body: 'x', fileName: 'a.txt', contentType: 'text/plain', visibility: 'public' });
    await media.upload({ body: 'x', fileName: 'a.txt', contentType: 'text/plain' });
    expect(s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input.ACL)).toEqual(['public-read', 'private']);
  });

  it('uses multipart above 8 MB and reports progress per part (AC11)', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-1' });
    s3.on(UploadPartCommand).callsFake((input) => ({ ETag: `"part-${input.PartNumber}"` }));
    s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multi"' });
    const size = 20 * MB;
    const onProgress = vi.fn();
    const obj = await client().upload({ body: Buffer.alloc(size), fileName: 'big.bin', contentType: 'application/octet-stream', onProgress });

    expect(MULTIPART_PART_SIZE_BYTES).toBe(8 * MB);
    const parts = s3.commandCalls(UploadPartCommand);
    expect(parts).toHaveLength(3);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(s3.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input.MultipartUpload!.Parts).toHaveLength(3);
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(parts.length);
    expect(onProgress.mock.lastCall![0]).toEqual({ loadedBytes: size, totalBytes: size });
    expect(obj).toMatchObject({ size, etag: '"multi"' });
  });

  it('uploads an 8 MB file in a single request and streams of unknown length via multipart', async () => {
    s3.on(PutObjectCommand).resolves({});
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-2' });
    s3.on(UploadPartCommand).resolves({ ETag: '"p"' });
    s3.on(CompleteMultipartUploadCommand).resolves({});
    await client().upload({ body: Buffer.alloc(8 * MB), fileName: 'a', contentType: 'application/octet-stream' });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);

    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(MB));
    const obj = await client().upload({ body: Readable.from(chunks), fileName: 'b', contentType: 'application/octet-stream' });
    expect(s3.commandCalls(UploadPartCommand)).toHaveLength(2);
    expect(obj.size).toBe(10 * MB);
  });

  it('aborting via signal cancels a multipart upload and rejects with ABORTED (AC11)', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-3' });
    s3.on(UploadPartCommand).callsFake(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ETag: '"p"' };
    });
    s3.on(AbortMultipartUploadCommand).resolves({});
    s3.on(CompleteMultipartUploadCommand).resolves({});
    const controller = new AbortController();
    const promise = client().upload({
      body: Buffer.alloc(40 * MB),
      fileName: 'big.bin',
      contentType: 'application/octet-stream',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expectCode(promise, 'ABORTED');
    await vi.waitFor(() => expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1));
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0);
  });

  it('stops a too-large stream mid-upload with FILE_TOO_LARGE', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-4' });
    s3.on(UploadPartCommand).resolves({ ETag: '"p"' });
    s3.on(AbortMultipartUploadCommand).resolves({});
    const chunks = (function* () {
      for (let i = 0; i < 100; i++) yield Buffer.alloc(MB);
    })();
    await expectCode(
      client({ validation: { maxSizeBytes: 20 * MB } }).upload({ body: Readable.from(chunks), fileName: 'x', contentType: 'application/octet-stream' }),
      'FILE_TOO_LARGE',
    );
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0);
  });

  it('maps upload failures', async () => {
    s3.on(PutObjectCommand).rejects(awsError('AccessDenied', 403));
    const error = await expectCode(client().upload({ body: 'x', fileName: 'a', contentType: 'text/plain' }), 'ACCESS_DENIED');
    expect(error.statusCode).toBe(403);
    expect(error.cause).toBeInstanceOf(S3ServiceException);
  });
});

describe('S3 reads', () => {
  it('head maps metadata and visibility, and returns null when missing', async () => {
    s3.on(HeadObjectCommand, { Key: 'cbt/a.png' }).resolves(headOutput);
    s3.on(HeadObjectCommand, { Key: 'cbt/missing.png' }).rejects(awsError('NotFound', 404, NotFound as never));
    const media = client();
    expect(await media.head('cbt/a.png')).toEqual({
      key: 'cbt/a.png',
      size: 64,
      contentType: 'image/png',
      etag: '"etag"',
      visibility: 'public',
      metadata: { owner: 'u1' },
      lastModified: new Date('2026-01-01T00:00:00Z'),
      url: 'https://cdn.evrree.com/cbt/a.png',
    });
    expect(await media.head('cbt/missing.png')).toBeNull();
    expect(await media.exists('cbt/missing.png')).toBe(false);
  });

  it('head without a visibility entry falls back to defaultVisibility', async () => {
    s3.on(HeadObjectCommand).resolves({ ...headOutput, Metadata: {} });
    expect((await client().head('a'))!.visibility).toBe('private');
  });

  it('head surfaces real errors', async () => {
    s3.on(HeadObjectCommand).rejects(awsError('AccessDenied', 403));
    await expectCode(client().head('a'), 'ACCESS_DENIED');
  });

  it('getStream / getBuffer return the body; missing keys are NOT_FOUND', async () => {
    const body = () => sdkStreamMixin(Readable.from([samples.png]));
    s3.on(GetObjectCommand, { Key: 'cbt/a.png' }).callsFake(() => ({ ...headOutput, ContentLength: samples.png.length, Body: body() }));
    s3.on(GetObjectCommand, { Key: 'cbt/none' }).rejects(awsError('NoSuchKey', 404, NoSuchKey as never));
    const media = client();
    const buf = await media.getBuffer('cbt/a.png');
    expect(buf.body.equals(samples.png)).toBe(true);
    expect(buf.object.metadata).toEqual({ owner: 'u1' });
    const stream = await media.getStream('cbt/a.png');
    expect(stream.object.size).toBe(samples.png.length);
    const error = await expectCode(media.getBuffer('cbt/none'), 'NOT_FOUND');
    expect(error.statusCode).toBe(404);
    await expectCode(media.getStream('cbt/none'), 'NOT_FOUND');
  });

  it('getBuffer refuses objects over maxSizeBytes', async () => {
    s3.on(GetObjectCommand).callsFake(() => ({ ...headOutput, ContentLength: 100 * MB, Body: sdkStreamMixin(Readable.from([Buffer.alloc(1)])) }));
    await expectCode(client().getBuffer('a'), 'FILE_TOO_LARGE');
  });

  it('getSignedUrl presigns a GET with expiry and Content-Disposition (AC18)', async () => {
    const url = new URL(await client().getSignedUrl('cbt/report.pdf', { expiresInSeconds: 120, downloadFileName: 'Report Q1.pdf' }));
    expect(url.pathname).toContain('/cbt/report.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="Report Q1.pdf"; filename*=UTF-8''Report%20Q1.pdf`,
    );
    const plain = new URL(await client({ signedUrlExpiresInSeconds: 60 }).getSignedUrl('cbt/report.pdf'));
    expect(plain.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(plain.searchParams.has('response-content-disposition')).toBe(false);
  });
});

describe('S3 presigned post (AC14 unit side)', () => {
  it('builds a policy with size range, content type and metadata', async () => {
    const presigned = await client({ validation: { maxSizeBytes: 5 * MB } }).createPresignedUpload({
      fileName: 'Scan.pdf',
      contentType: 'application/pdf',
      folder: 'docs',
      metadata: { owner: 'u1' },
      visibility: 'public',
    });
    expect(presigned.url).toMatch(/^https:\/\/evrree-test\.s3\.eu-west-1\.amazonaws\.com\/?$/);
    expect(presigned.fields).toMatchObject({
      key: presigned.key,
      'Content-Type': 'application/pdf',
      'x-amz-meta-owner': 'u1',
      'x-amz-meta-evrree-visibility': 'public',
    });
    const policy = JSON.parse(Buffer.from(presigned.fields.Policy!, 'base64').toString());
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 0, 5 * MB],
        ['eq', '$Content-Type', 'application/pdf'],
        { key: presigned.key },
        { bucket: 'evrree-test' },
      ]),
    );
    expect(new Date(policy.expiration).getTime()).toBeGreaterThan(Date.now() + 290_000);
    expect(presigned.fields.acl).toBeUndefined();
  });
});

describe('S3 delete', () => {
  it('delete is idempotent and deleteMany sends 3 batches for 2,500 keys (AC20)', async () => {
    s3.on(DeleteObjectsCommand).callsFake((input) => ({
      Errors: input.Delete.Objects.some((o: { Key: string }) => o.Key === 'k1500')
        ? [{ Key: 'k1500', Code: 'AccessDenied', Message: 'nope' }, { Key: 'k1501', Code: 'InternalError', Message: 'x' }]
        : [],
    }));
    const media = client();
    await media.delete('cbt/missing.txt');
    const keys = Array.from({ length: 2500 }, (_, i) => `k${i}`);
    const result = await media.deleteMany(keys);
    const calls = s3.commandCalls(DeleteObjectsCommand).slice(1);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.args[0].input.Delete!.Objects!.length)).toEqual([1000, 1000, 500]);
    expect(calls[0]!.args[0].input.Delete!.Quiet).toBe(true);
    expect(result.deleted).toHaveLength(2498);
    expect(result.failed.map((f) => [f.key, f.error.code])).toEqual([
      ['k1500', 'ACCESS_DENIED'],
      ['k1501', 'PROVIDER_ERROR'],
    ]);
  });

  it('a failed batch request marks that batch failed and continues', async () => {
    s3.on(DeleteObjectsCommand).rejectsOnce(awsError('SlowDown', 503)).resolves({});
    const result = await client().deleteMany(Array.from({ length: 1500 }, (_, i) => `k${i}`));
    expect(result.failed).toHaveLength(1000);
    expect(result.failed[0]!.error).toMatchObject({ code: 'PROVIDER_ERROR', statusCode: 503 });
    expect(result.deleted).toHaveLength(500);
  });

  it('delete throws when S3 reports a per-key error', async () => {
    s3.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'cbt/a', Code: 'AccessDenied' }] });
    await expectCode(client().delete('cbt/a'), 'ACCESS_DENIED');
  });

  it('batches inside the provider too', async () => {
    s3.on(DeleteObjectsCommand).resolves({});
    const provider = new S3StorageProvider(baseConfig.provider as never);
    await provider.delete(Array.from({ length: 2001 }, (_, i) => `k${i}`));
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(3);
  });
});

describe('S3 copy, move, updateMetadata', () => {
  it('copy uses MetadataDirective COPY by default with an encoded CopySource', async () => {
    s3.on(CopyObjectCommand).resolves({});
    s3.on(HeadObjectCommand).resolves(headOutput);
    const obj = await client().copy('cbt/a b#1.png', 'copies/a.png');
    expect(s3.commandCalls(CopyObjectCommand)[0]!.args[0].input).toMatchObject({
      Bucket: 'evrree-test',
      Key: 'cbt/copies/a.png',
      CopySource: 'evrree-test/cbt/a%20b%231.png',
      MetadataDirective: 'COPY',
    });
    expect(obj.key).toBe('cbt/copies/a.png');
  });

  it('updateMetadata copies to itself with REPLACE, keeping content headers', async () => {
    s3.on(HeadObjectCommand).resolves(headOutput);
    s3.on(CopyObjectCommand).resolves({});
    await client().updateMetadata('cbt/a.png', { Owner: 'u2' });
    expect(s3.commandCalls(CopyObjectCommand)[0]!.args[0].input).toMatchObject({
      Key: 'cbt/a.png',
      CopySource: 'evrree-test/cbt/a.png',
      MetadataDirective: 'REPLACE',
      ContentType: 'image/png',
      CacheControl: 'max-age=60',
      ContentDisposition: 'inline; filename="a.png"',
      Metadata: { owner: 'u2', 'evrree-visibility': 'public' },
    });
    await client().updateMetadata('cbt/a.png', {}, { visibility: 'private' });
    expect(s3.commandCalls(CopyObjectCommand)[1]!.args[0].input.Metadata).toEqual({ 'evrree-visibility': 'private' });
  });

  it('copy of a missing source is NOT_FOUND', async () => {
    s3.on(CopyObjectCommand).rejects(awsError('NoSuchKey', 404, NoSuchKey as never));
    await expectCode(client().copy('cbt/none', 'x'), 'NOT_FOUND');
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404));
    await expectCode(client().copy('cbt/none', 'x', { visibility: 'public' }), 'NOT_FOUND');
  });

  it('move deletes the source after copying', async () => {
    s3.on(CopyObjectCommand).resolves({});
    s3.on(HeadObjectCommand).resolves(headOutput);
    s3.on(DeleteObjectsCommand).resolves({});
    await client().move('cbt/a.png', 'cbt/b.png');
    expect(s3.commandCalls(DeleteObjectsCommand)[0]!.args[0].input.Delete!.Objects).toEqual([{ Key: 'cbt/a.png' }]);
  });
});

describe('S3 list', () => {
  it('lists under the key prefix and passes the cursor through', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'cbt/docs/a.pdf', Size: 10, ETag: '"e"', LastModified: new Date(0) }],
      IsTruncated: true,
      NextContinuationToken: 'token-2',
    });
    const page = await client().list({ prefix: 'docs', limit: 1, cursor: 'token-1' });
    expect(s3.commandCalls(ListObjectsV2Command)[0]!.args[0].input).toEqual({
      Bucket: 'evrree-test',
      Prefix: 'cbt/docs',
      MaxKeys: 1,
      ContinuationToken: 'token-1',
    });
    expect(page).toEqual({
      items: [{ key: 'cbt/docs/a.pdf', size: 10, etag: '"e"', lastModified: new Date(0), contentType: '', metadata: {}, visibility: 'private' }],
      nextCursor: 'token-2',
    });
  });

  it('includeMetadata heads each item', async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'cbt/a' }, { Key: 'cbt/b' }], IsTruncated: false });
    s3.on(HeadObjectCommand, { Key: 'cbt/a' }).resolves(headOutput);
    s3.on(HeadObjectCommand, { Key: 'cbt/b' }).rejects(awsError('NotFound', 404));
    const page = await client().list({ includeMetadata: true });
    expect(s3.commandCalls(ListObjectsV2Command)[0]!.args[0].input.Prefix).toBe('cbt/');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ key: 'cbt/a', contentType: 'image/png', visibility: 'public' });
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('mapS3Error (AC23)', () => {
  it.each([
    ['NoSuchKey', 404, 'NOT_FOUND'],
    ['NotFound', 404, 'NOT_FOUND'],
    ['Whatever', 404, 'NOT_FOUND'],
    ['AccessDenied', 403, 'ACCESS_DENIED'],
    ['SignatureDoesNotMatch', 403, 'ACCESS_DENIED'],
    ['Forbidden', 403, 'ACCESS_DENIED'],
    ['EntityTooLarge', 400, 'FILE_TOO_LARGE'],
    ['NoSuchBucket', 404, 'PROVIDER_ERROR'],
    ['InternalError', 500, 'PROVIDER_ERROR'],
    ['SlowDown', 503, 'PROVIDER_ERROR'],
  ])('%s (%i) -> %s', (name, status, code) => {
    const raw = awsError(name, status);
    const mapped = mapS3Error(raw, 'k');
    expect(mapped).toBeInstanceOf(MediaError);
    expect(mapped.code).toBe(code);
    expect(mapped.statusCode).toBe(status);
    expect(mapped.cause).toBe(raw);
  });

  it('handles network errors, aborts and non-errors', () => {
    const network = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(mapS3Error(network)).toMatchObject({ code: 'PROVIDER_ERROR', cause: network });
    expect(mapS3Error(Object.assign(new Error('x'), { name: 'AbortError' })).code).toBe('ABORTED');
    expect(mapS3Error(undefined).code).toBe('PROVIDER_ERROR');
    const existing = new MediaError('NOT_FOUND', 'x');
    expect(mapS3Error(existing)).toBe(existing);
  });

  it('never lets a raw error out of any client method', async () => {
    const raw = awsError('InternalError', 500);
    for (const Command of [PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, ListObjectsV2Command, DeleteObjectsCommand]) {
      s3.on(Command as never).rejects(raw);
    }
    const media = client();
    const calls: Promise<unknown>[] = [
      media.upload({ body: 'x', fileName: 'a', contentType: 'text/plain' }),
      media.getStream('a'),
      media.getBuffer('a'),
      media.head('a'),
      media.delete('a'),
      media.copy('a', 'b'),
      media.move('a', 'b'),
      media.list(),
      media.updateMetadata('a', {}),
    ];
    for (const call of calls) {
      const error = await expectCode(call, 'PROVIDER_ERROR');
      expect(error.cause).toBe(raw);
    }
  });
});

describe('S3 client configuration', () => {
  it('passes endpoint, path style and relaxed checksums for S3-compatible stores', async () => {
    const provider = new S3StorageProvider({
      type: 's3',
      bucket: 'b',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    });
    expect(provider.client.config.forcePathStyle).toBe(true);
    expect(await provider.client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
    const endpoint = await provider.client.config.endpoint!();
    expect(endpoint.hostname).toBe('localhost');
  });
});
