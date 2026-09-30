// Browser / Electron renderer entry. Must never import Node built-ins, the AWS SDK or any
// server module: CI bundles it with --platform=browser to enforce that.
import { MediaError } from '../errors';

export { MediaError, isMediaError } from '../errors';
export type { MediaErrorCode, MediaErrorOptions } from '../errors';

export type Visibility = 'private' | 'public';

/** What the backend's media.createPresignedUpload() returns (sent to the browser as JSON). */
export interface PresignedUpload {
  key: string;
  url: string;
  method: 'POST';
  fields: Record<string, string>;
  /** A Date on the server; an ISO string after a JSON round trip. */
  expiresAt: Date | string;
  maxSizeBytes: number;
}

export interface UploadToPresignedUrlOptions {
  /** Called with 0 at the start, whole percentages as bytes go out, and 100 on success. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * Uploads a File/Blob straight to storage with a presigned POST. Uses XMLHttpRequest so
 * upload progress works. Rejects with MediaError: FILE_TOO_LARGE (checked before sending),
 * ABORTED, or UPLOAD_FAILED with the HTTP status.
 */
export function uploadToPresignedUrl(
  presigned: PresignedUpload,
  file: File | Blob,
  opts: UploadToPresignedUrlOptions = {},
): Promise<{ key: string }> {
  return new Promise((resolve, reject) => {
    const { onProgress, signal } = opts;

    if (signal?.aborted) {
      reject(new MediaError('ABORTED', 'Upload was aborted'));
      return;
    }
    if (typeof presigned?.maxSizeBytes === 'number' && file.size > presigned.maxSizeBytes) {
      reject(
        new MediaError(
          'FILE_TOO_LARGE',
          `File is ${file.size} bytes; the limit is ${presigned.maxSizeBytes} bytes`,
        ),
      );
      return;
    }

    const form = new FormData();
    for (const [name, value] of Object.entries(presigned.fields ?? {})) form.append(name, value);
    // S3 ignores every field after the file, so it must be last.
    const fileName = typeof File !== 'undefined' && file instanceof File ? file.name : 'blob';
    form.append('file', file, fileName);

    const xhr = new XMLHttpRequest();
    let settled = false;
    let lastPercent = -1;

    const report = (percent: number) => {
      if (!onProgress || percent === lastPercent) return;
      lastPercent = percent;
      onProgress(percent);
    };
    const onAbortSignal = () => xhr.abort();
    const finish = (error?: MediaError) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbortSignal);
      if (error) reject(error);
      else {
        report(100);
        resolve({ key: presigned.key });
      }
    };

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (!event.lengthComputable || event.total === 0) return;
      // 100 is reserved for "the server accepted it"; bytes sent is not the same thing.
      report(Math.min(99, Math.floor((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish();
        return;
      }
      const code = /<Code>([^<]+)<\/Code>/.exec(xhr.responseText ?? '')?.[1];
      finish(
        new MediaError(
          'UPLOAD_FAILED',
          `Upload failed with HTTP ${xhr.status}${code ? ` (${code})` : ''}`,
          { statusCode: xhr.status },
        ),
      );
    };
    xhr.onerror = () =>
      finish(new MediaError('UPLOAD_FAILED', 'Upload failed: network error', { statusCode: xhr.status }));
    xhr.ontimeout = () =>
      finish(new MediaError('UPLOAD_FAILED', 'Upload timed out', { statusCode: xhr.status }));
    xhr.onabort = () => finish(new MediaError('ABORTED', 'Upload was aborted', { statusCode: xhr.status }));

    signal?.addEventListener('abort', onAbortSignal, { once: true });
    xhr.open(presigned.method ?? 'POST', presigned.url, true);
    report(0);
    xhr.send(form);
  });
}
