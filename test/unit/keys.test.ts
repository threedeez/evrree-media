import { describe, expect, it } from 'vitest';
import { MediaError } from '../../src/errors';
import { applyKeyPrefix, assertValidKey, encodeKeyForUrl, generateKey, joinKey, sanitizeFileName } from '../../src/keys';

const expectInvalid = (key: unknown) => {
  try {
    assertValidKey(key as string);
  } catch (error) {
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('INVALID_KEY');
    return;
  }
  throw new Error(`expected ${JSON.stringify(key)} to be rejected`);
};

describe('assertValidKey', () => {
  it.each(['', '../etc/passwd', '/abs', 'a\\b', 'a/../b', 'a\u0000b', 'tab\there', 'del\u007f', 'x'.repeat(1025)])(
    'rejects %j',
    (key) => expectInvalid(key),
  );

  it('rejects non-strings and keys over 1024 UTF-8 bytes', () => {
    expectInvalid(undefined);
    expectInvalid(42);
    expectInvalid('é'.repeat(513)); // 1026 bytes, 513 characters
  });

  it.each(['a', 'cbt/avatars/2026/01/x.png', 'x'.repeat(1024), 'with space/ünïcode.txt', 'a.b.c'])('accepts %j', (key) =>
    expect(() => assertValidKey(key)).not.toThrow(),
  );
});

describe('sanitizeFileName', () => {
  it.each([
    ['My Photo.JPG', 'my-photo.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\Report Final (v2).PDF', 'report-final-v2.pdf'],
    ['  weird   name!!.png ', 'weird-name.png'],
    ['Résumé été.docx', 'resume-ete.docx'],
    ['.env', 'env'],
    ['no-extension', 'no-extension'],
    ['???.png', 'file.png'],
    ['', 'file'],
    ['a..b...c.txt', 'a.b.c.txt'],
  ])('%j -> %j', (input, expected) => expect(sanitizeFileName(input)).toBe(expected));

  it('trims to 100 characters and keeps the extension', () => {
    const result = sanitizeFileName(`${'a'.repeat(300)}.jpeg`);
    expect(result).toHaveLength(100);
    expect(result.endsWith('.jpeg')).toBe(true);
  });

  it('never contains path separators or unsafe characters', () => {
    for (const name of ['a/b\\c.png', 'x<y>z|?.gif', 'tab\tnew\nline.txt', '%00.png']) {
      expect(sanitizeFileName(name)).toMatch(/^[a-z0-9._-]+$/);
    }
  });
});

describe('generateKey', () => {
  const date = new Date(Date.UTC(2026, 2, 9));

  it('follows {prefix}/{folder}/{yyyy}/{mm}/{uuid}-{sanitized-name}', () => {
    const key = generateKey({ prefix: 'cbt', folder: 'questions/images', fileName: 'Diagram 1.PNG', date });
    expect(key).toMatch(/^cbt\/questions\/images\/2026\/03\/[0-9a-f-]{36}-diagram-1\.png$/);
  });

  it('skips missing prefix and folder and tidies slashes', () => {
    expect(generateKey({ fileName: 'a.txt', date })).toMatch(/^2026\/03\/[0-9a-f-]{36}-a\.txt$/);
    expect(generateKey({ prefix: '/cbt/', folder: '//avatars/', fileName: 'a.txt', date })).toMatch(
      /^cbt\/avatars\/2026\/03\//,
    );
  });

  it('never collides for the same file name', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateKey({ fileName: 'same.png' })));
    expect(keys.size).toBe(1000);
  });

  it('rejects folders that would make an invalid key', () => {
    expect(() => generateKey({ folder: '../up', fileName: 'a.txt' })).toThrow(MediaError);
  });
});

describe('key utilities', () => {
  it('joinKey drops empty segments', () => expect(joinKey('/a/', undefined, '', 'b//c')).toBe('a/b/c'));

  it('applyKeyPrefix never adds the prefix twice', () => {
    expect(applyKeyPrefix('x.png', 'cbt')).toBe('cbt/x.png');
    expect(applyKeyPrefix('cbt/x.png', 'cbt')).toBe('cbt/x.png');
    expect(applyKeyPrefix('cbtx/x.png', 'cbt')).toBe('cbt/cbtx/x.png');
    expect(applyKeyPrefix('x.png', '')).toBe('x.png');
  });

  it('encodeKeyForUrl encodes segments but keeps slashes', () =>
    expect(encodeKeyForUrl('a b/c#d?.png')).toBe('a%20b/c%23d%3F.png'));
});
