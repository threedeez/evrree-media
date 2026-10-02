import { describe, expect, it } from 'vitest';
import { MediaError } from '../../src/errors';
import {
  assertContentSignature,
  assertContentType,
  assertSize,
  isMimeTypeAllowed,
  matchesContentSignature,
  normalizeContentType,
} from '../../src/validation';
import { samples } from '../fixtures';

describe('content signatures', () => {
  it.each([
    ['image/jpeg', samples.jpeg],
    ['image/jpg', samples.jpeg],
    ['image/png', samples.png],
    ['image/gif', samples.gif87],
    ['image/gif', samples.gif89],
    ['image/webp', samples.webp],
    ['application/pdf', samples.pdf],
    ['video/mp4', samples.mp4],
    ['IMAGE/PNG; charset=binary', samples.png],
  ])('%s matches its magic bytes', (type, bytes) => expect(matchesContentSignature(type, bytes)).toBe(true));

  it.each([
    ['image/jpeg', samples.png],
    ['image/png', samples.jpeg],
    ['image/gif', samples.pdf],
    ['image/webp', Buffer.from('RIFF\0\0\0\0WAVE')],
    ['application/pdf', samples.text],
    ['video/mp4', samples.gif89],
    ['image/png', Buffer.alloc(0)],
  ])('%s rejects mismatched bytes', (type, bytes) => {
    expect(matchesContentSignature(type, bytes)).toBe(false);
    expect(() => assertContentSignature(type, bytes)).toThrow(expect.objectContaining({ code: 'CONTENT_MISMATCH' }));
  });

  it('skips types without a signature', () => {
    expect(matchesContentSignature('text/plain', samples.png)).toBeUndefined();
    expect(() => assertContentSignature('application/zip', samples.text)).not.toThrow();
  });
});

describe('mime types', () => {
  it('normalises case and parameters', () => expect(normalizeContentType(' Text/HTML; charset=utf-8')).toBe('text/html'));

  it('allows everything when no list is configured', () => {
    expect(isMimeTypeAllowed('anything/goes', undefined)).toBe(true);
    expect(isMimeTypeAllowed('anything/goes', [])).toBe(true);
  });

  it('matches exact entries and wildcards', () => {
    const allowed = ['image/*', 'application/pdf'];
    expect(isMimeTypeAllowed('image/webp', allowed)).toBe(true);
    expect(isMimeTypeAllowed('application/pdf', allowed)).toBe(true);
    expect(isMimeTypeAllowed('application/zip', allowed)).toBe(false);
    expect(isMimeTypeAllowed('video/mp4', ['*/*'])).toBe(true);
  });

  it('assertContentType throws UNSUPPORTED_TYPE', () => {
    expect(() => assertContentType('application/zip', ['image/png'])).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_TYPE' }),
    );
    expect(() => assertContentType('not a type', undefined)).toThrow(MediaError);
  });

  it('assertSize throws FILE_TOO_LARGE only above the limit', () => {
    expect(() => assertSize(10, 10)).not.toThrow();
    expect(() => assertSize(11, 10)).toThrow(expect.objectContaining({ code: 'FILE_TOO_LARGE' }));
  });
});
