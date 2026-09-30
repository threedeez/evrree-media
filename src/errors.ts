// Browser-safe: imported by the @evrree/media/client entry, so this file must never import
// Node built-ins or the AWS SDK.

export type MediaErrorCode =
  | 'CONFIG_ERROR'
  | 'INVALID_KEY'
  | 'NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'CONTENT_MISMATCH'
  | 'UPLOAD_FAILED'
  | 'ABORTED'
  | 'ACCESS_DENIED'
  | 'PROVIDER_ERROR';

export interface MediaErrorOptions {
  /** HTTP status from the storage provider, if any. */
  statusCode?: number;
  /** The original error. */
  cause?: unknown;
}

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly statusCode?: number;
  override readonly cause?: unknown;

  constructor(code: MediaErrorCode, message: string, options: MediaErrorOptions = {}) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isMediaError(error: unknown, code?: MediaErrorCode): error is MediaError {
  return error instanceof MediaError && (code === undefined || error.code === code);
}

/** True for the AbortError shapes thrown by AbortSignal, fetch, streams and lib-storage. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || code === 'ABORT_ERR';
}

export function abortedError(cause?: unknown): MediaError {
  return new MediaError('ABORTED', 'The operation was aborted', { cause });
}

/**
 * Wraps anything that is not already a MediaError. Used as the last line of defence so no raw
 * provider error ever reaches the caller.
 */
export function toMediaError(error: unknown, fallbackMessage = 'Storage provider error'): MediaError {
  if (error instanceof MediaError) return error;
  if (isAbortError(error)) return abortedError(error);
  const message = error instanceof Error && error.message ? `${fallbackMessage}: ${error.message}` : fallbackMessage;
  return new MediaError('PROVIDER_ERROR', message, { cause: error });
}
