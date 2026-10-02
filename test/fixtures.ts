import { Readable } from 'node:stream';

const pad = (head: number[], size = 64) => {
  const buf = Buffer.alloc(Math.max(size, head.length), 0x20);
  Buffer.from(head).copy(buf);
  return buf;
};
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** Minimal byte sequences that pass (or deliberately fail) the magic-byte checks. */
export const samples = {
  jpeg: pad([0xff, 0xd8, 0xff, 0xe0]),
  png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif87: pad(ascii('GIF87a')),
  gif89: pad(ascii('GIF89a')),
  webp: pad([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP')]),
  pdf: pad(ascii('%PDF-1.7\n')),
  mp4: pad([0, 0, 0, 0x18, ...ascii('ftypmp42')]),
  text: Buffer.from('plain text body'),
};

/** A stream of `total` bytes in `chunkSize` chunks that records how much was pulled. */
export function countingStream(total: number, chunkSize = 1024, first: Buffer = Buffer.alloc(0)) {
  const state = { pulled: 0 };
  let sent = 0;
  const stream = new Readable({
    read() {
      if (sent >= total) return this.push(null);
      let chunk: Buffer;
      if (sent === 0 && first.length) chunk = Buffer.concat([first, Buffer.alloc(Math.max(0, Math.min(chunkSize, total) - first.length), 1)]);
      else chunk = Buffer.alloc(Math.min(chunkSize, total - sent), 1);
      sent += chunk.length;
      state.pulled = sent;
      this.push(chunk);
    },
  });
  return { stream, state };
}

export function captureLogger() {
  const lines: string[] = [];
  const record = (level: string) => (message: string, context?: Record<string, unknown>) =>
    lines.push(`${level} ${message} ${JSON.stringify(context ?? {})}`);
  return {
    lines,
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  };
}
