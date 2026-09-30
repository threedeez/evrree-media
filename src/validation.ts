import { MediaError } from './errors';

export const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/** Bytes needed from the start of a file to check every known signature. */
export const SIGNATURE_PEEK_BYTES = 16;

/** Lowercased media type without parameters: 'Image/PNG; x=y' -> 'image/png'. */
export function normalizeContentType(contentType: string): string {
  return String(contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

export function isValidContentType(contentType: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalizeContentType(contentType));
}

/** True when allowed is undefined/empty, or the type matches an entry ('image/*' wildcards work). */
export function isMimeTypeAllowed(contentType: string, allowed: readonly string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  const type = normalizeContentType(contentType);
  return allowed.some((entry) => {
    const rule = normalizeContentType(entry);
    if (rule === '*/*') return true;
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return rule === type;
  });
}

export function assertContentType(contentType: string, allowed: readonly string[] | undefined): void {
  if (!isValidContentType(contentType)) {
    throw new MediaError('UNSUPPORTED_TYPE', 'contentType must be a valid media type such as "image/png"');
  }
  if (!isMimeTypeAllowed(contentType, allowed)) {
    throw new MediaError('UNSUPPORTED_TYPE', `Content type "${normalizeContentType(contentType)}" is not allowed`);
  }
}

export function assertSize(size: number, maxSizeBytes: number): void {
  if (size > maxSizeBytes) {
    throw new MediaError('FILE_TOO_LARGE', `File is ${size} bytes; the limit is ${maxSizeBytes} bytes`);
  }
}

type Signature = { offset: number; bytes: number[] };

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/** Each type matches if every signature in any one of its alternatives matches. */
const SIGNATURES: Record<string, Signature[][]> = {
  'image/jpeg': [[{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
  'image/png': [[{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
  'image/gif': [[{ offset: 0, bytes: ascii('GIF87a') }], [{ offset: 0, bytes: ascii('GIF89a') }]],
  'image/webp': [
    [
      { offset: 0, bytes: ascii('RIFF') },
      { offset: 8, bytes: ascii('WEBP') },
    ],
  ],
  'application/pdf': [[{ offset: 0, bytes: ascii('%PDF-') }]],
  'video/mp4': [[{ offset: 4, bytes: ascii('ftyp') }]],
};
SIGNATURES['image/jpg'] = SIGNATURES['image/jpeg']!;
SIGNATURES['image/pjpeg'] = SIGNATURES['image/jpeg']!;

/** Content types whose magic bytes are checked. Others skip the check. */
export const SIGNATURE_CHECKED_TYPES = Object.keys(SIGNATURES);

/**
 * Checks the first bytes of a file against its declared type.
 * Returns undefined when there is no signature on record for the type.
 */
export function matchesContentSignature(contentType: string, head: Uint8Array): boolean | undefined {
  const alternatives = SIGNATURES[normalizeContentType(contentType)];
  if (!alternatives) return undefined;
  return alternatives.some((signatures) =>
    signatures.every(({ offset, bytes }) => bytes.every((byte, i) => head[offset + i] === byte)),
  );
}

export function assertContentSignature(contentType: string, head: Uint8Array): void {
  if (matchesContentSignature(contentType, head) === false) {
    throw new MediaError(
      'CONTENT_MISMATCH',
      `File content does not match the declared type "${normalizeContentType(contentType)}"`,
    );
  }
}
