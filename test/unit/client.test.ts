import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaError, uploadToPresignedUrl, type PresignedUpload } from '../../src/client';

type Listener = ((event: ProgressEvent) => void) | null;

/** Just enough of XMLHttpRequest to drive the client from a test. */
class MockXHR {
  static instances: MockXHR[] = [];
  upload: { onprogress: Listener } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = '';
  method?: string;
  url?: string;
  body?: FormData;
  aborted = false;

  constructor() {
    MockXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.status = 0;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number, text = '') {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

const presigned: PresignedUpload = {
  key: 'cbt/uploads/2026/09/abc-photo.png',
  url: 'https://bucket.s3.amazonaws.com/',
  method: 'POST',
  fields: { key: 'cbt/uploads/2026/09/abc-photo.png', 'Content-Type': 'image/png', Policy: 'p', 'X-Amz-Signature': 's' },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  maxSizeBytes: 1000,
};

const file = (size: number) => new File([new Uint8Array(size)], 'photo.png', { type: 'image/png' });
const current = () => MockXHR.instances[MockXHR.instances.length - 1]!;

beforeEach(() => {
  MockXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', MockXHR);
});
afterEach(() => vi.unstubAllGlobals());

describe('uploadToPresignedUrl (AC16)', () => {
  it('posts every field first and the file last, reporting progress 0 -> 100', async () => {
    const onProgress = vi.fn();
    const promise = uploadToPresignedUrl(presigned, file(500), { onProgress });
    const xhr = current();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(presigned.url);
    const entries = [...xhr.body!.entries()];
    expect(entries.map(([name]) => name)).toEqual([...Object.keys(presigned.fields), 'file']);
    expect((entries.at(-1)![1] as File).name).toBe('photo.png');

    xhr.progress(0, 500);
    xhr.progress(250, 500);
    xhr.progress(250, 500);
    xhr.progress(500, 500);
    xhr.respond(204);
    await expect(promise).resolves.toEqual({ key: presigned.key });
    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([0, 50, 99, 100]);
  });

  it('works with a plain Blob and without options', async () => {
    const promise = uploadToPresignedUrl(presigned, new Blob(['x']));
    current().progress(1, 0);
    current().respond(201);
    await expect(promise).resolves.toEqual({ key: presigned.key });
  });

  it('rejects oversize files before sending anything', async () => {
    const error = await uploadToPresignedUrl(presigned, file(1001)).catch((e) => e);
    expect(error).toBeInstanceOf(MediaError);
    expect(error.code).toBe('FILE_TOO_LARGE');
    expect(MockXHR.instances).toHaveLength(0);
  });

  it('aborts via the signal with ABORTED', async () => {
    const controller = new AbortController();
    const promise = uploadToPresignedUrl(presigned, file(10), { signal: controller.signal });
    controller.abort();
    const error = await promise.catch((e) => e);
    expect(current().aborted).toBe(true);
    expect(error).toMatchObject({ code: 'ABORTED' });

    const already = await uploadToPresignedUrl(presigned, file(10), { signal: AbortSignal.abort() }).catch((e) => e);
    expect(already).toMatchObject({ code: 'ABORTED' });
    expect(MockXHR.instances).toHaveLength(1);
  });

  it('rejects HTTP errors with UPLOAD_FAILED, the status and the S3 error code', async () => {
    const promise = uploadToPresignedUrl(presigned, file(10));
    current().respond(403, '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Policy Condition failed</Message></Error>');
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(MediaError);
    expect(error).toMatchObject({ code: 'UPLOAD_FAILED', statusCode: 403 });
    expect(error.message).toContain('AccessDenied');
  });

  it('rejects network errors and timeouts with UPLOAD_FAILED', async () => {
    const network = uploadToPresignedUrl(presigned, file(10));
    current().onerror!();
    await expect(network).rejects.toMatchObject({ code: 'UPLOAD_FAILED', statusCode: 0 });
    const timeout = uploadToPresignedUrl(presigned, file(10));
    current().ontimeout!();
    await expect(timeout).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });

  it('settles only once', async () => {
    const onProgress = vi.fn();
    const promise = uploadToPresignedUrl(presigned, file(10), { onProgress });
    current().respond(204);
    current().onerror!();
    await expect(promise).resolves.toEqual({ key: presigned.key });
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });
});
