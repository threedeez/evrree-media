import { randomUUID } from 'node:crypto';
import { MediaError } from './errors';

const MAX_KEY_BYTES = 1024;
const MAX_FILE_NAME_LENGTH = 100;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Throws INVALID_KEY if the key is empty, starts with '/', contains '..', '\' or control
 * characters, or is longer than 1024 bytes (UTF-8).
 */
export function assertValidKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new MediaError('INVALID_KEY', 'Key must be a non-empty string');
  }
  if (key.startsWith('/')) throw new MediaError('INVALID_KEY', 'Key must not start with "/"');
  if (key.includes('..')) throw new MediaError('INVALID_KEY', 'Key must not contain ".."');
  if (key.includes('\\')) throw new MediaError('INVALID_KEY', 'Key must not contain "\\"');
  if (CONTROL_CHARS.test(key)) throw new MediaError('INVALID_KEY', 'Key must not contain control characters');
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) {
    throw new MediaError('INVALID_KEY', `Key must be at most ${MAX_KEY_BYTES} bytes`);
  }
}

/**
 * Lowercases, replaces spaces and unsafe characters with '-', strips any directory part,
 * trims to 100 characters and keeps the extension. Never returns an empty string.
 */
export function sanitizeFileName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const ascii = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  const dot = ascii.lastIndexOf('.');
  const rawStem = dot > 0 ? ascii.slice(0, dot) : ascii;
  const ext = (dot > 0 ? ascii.slice(dot + 1) : '').replace(/[^a-z0-9]+/g, '').slice(0, 16);
  const suffix = ext ? `.${ext}` : '';

  const stem =
    rawStem
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, MAX_FILE_NAME_LENGTH - suffix.length)
      .replace(/[-._]+$/g, '') || 'file';

  return `${stem}${suffix}`;
}

export interface GenerateKeyOptions {
  fileName: string;
  folder?: string;
  prefix?: string;
  /** Defaults to now. Year and month are taken in UTC. */
  date?: Date;
}

/** Returns {prefix}/{folder}/{yyyy}/{mm}/{uuid}-{sanitized-file-name}, skipping empty parts. */
export function generateKey({ fileName, folder, prefix, date = new Date() }: GenerateKeyOptions): string {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const key = joinKey(prefix, folder, yyyy, mm, `${randomUUID()}-${sanitizeFileName(fileName)}`);
  assertValidKey(key);
  return key;
}

/** Joins key segments, dropping empty ones and stray slashes. */
export function joinKey(...parts: (string | undefined)[]): string {
  return parts
    .flatMap((part) => (part ?? '').split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
}

/** Normalises a keyPrefix/folder-like value: no leading, trailing or doubled slashes. */
export function normalizePrefix(prefix: string | undefined): string {
  return joinKey(prefix);
}

/** Prepends keyPrefix unless the key already starts with it, so it is never added twice. */
export function applyKeyPrefix(key: string, keyPrefix: string): string {
  if (!keyPrefix) return key;
  if (key === keyPrefix || key.startsWith(`${keyPrefix}/`)) return key;
  return `${keyPrefix}/${key}`;
}

/** Encodes each path segment of a key for use in a URL, keeping the slashes. */
export function encodeKeyForUrl(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
