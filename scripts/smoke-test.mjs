#!/usr/bin/env node
// AC2 / AC4: packs the package exactly as it would be published, installs the tarball into a
// fresh CommonJS project and a fresh ESM project (without the optional NestJS peers), and
// exercises every entry point that should load there. Run after `pnpm build`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(process.env.SMOKE_TMPDIR ?? tmpdir(), 'evrree-media-smoke-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

try {
  run('pnpm', ['pack', '--pack-destination', work], root);
  const tarball = join(work, readdirSync(work).find((f) => f.endsWith('.tgz')));

  const checks = `
    const media = createMediaClient({ provider: { type: 'memory' }, keyPrefix: 'smoke' });
    const obj = await media.upload({ body: 'hello', fileName: 'Hello World.txt', contentType: 'text/plain' });
    if (!obj.key.startsWith('smoke/')) throw new Error('keyPrefix not applied: ' + obj.key);
    const { body } = await media.getBuffer(obj.key);
    if (body.toString() !== 'hello') throw new Error('round trip failed');
    let code;
    try { createMediaClient({ provider: { type: 's3' } }); } catch (e) { code = e.code; }
    if (code !== 'CONFIG_ERROR' || !(new MediaError('NOT_FOUND', 'x') instanceof Error)) throw new Error('errors broken');
    if (typeof uploadToPresignedUrl !== 'function') throw new Error('client entry broken');
    let nestMissing = false;
    try { __resolve('@nestjs/common'); } catch { nestMissing = true; }
    if (!nestMissing) throw new Error('@nestjs/common is installed; the smoke test must run without it');
    console.log('  ok:', obj.key);
  `;

  const projects = {
    cjs: {
      pkg: { name: 'smoke-cjs', private: true, type: 'commonjs' },
      file: 'index.cjs',
      code: `
        const { createMediaClient, MediaError } = require('@evrree/media');
        const { uploadToPresignedUrl } = require('@evrree/media/client');
        const __resolve = (m) => require.resolve(m);
        (async () => { ${checks} })().catch((e) => { console.error(e); process.exit(1); });
      `,
    },
    esm: {
      pkg: { name: 'smoke-esm', private: true, type: 'module' },
      file: 'index.mjs',
      code: `
        import { createMediaClient, MediaError } from '@evrree/media';
        import { uploadToPresignedUrl } from '@evrree/media/client';
        import { createRequire } from 'node:module';
        const __resolve = (m) => createRequire(import.meta.url).resolve(m);
        ${checks}
      `,
    },
  };

  for (const [name, project] of Object.entries(projects)) {
    const dir = join(work, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(project.pkg));
    writeFileSync(join(dir, project.file), project.code);
    run('npm', ['install', '--no-audit', '--no-fund', '--omit=peer', '--loglevel=error', tarball], dir);
    console.log(`▶ ${name}`);

    process.stdout.write(run('node', [project.file], dir));
  }
  console.log('✓ smoke test passed (CommonJS + ESM, without NestJS installed)');
} finally {
  rmSync(work, { recursive: true, force: true });
}
