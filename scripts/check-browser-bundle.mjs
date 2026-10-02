#!/usr/bin/env node
// AC3: @evrree/media/client must bundle for the browser with no Node built-ins and no AWS
// SDK. esbuild with --platform=browser refuses to resolve node:* / fs / stream imports, so any
// leak fails this build. Both the source entry and the built dist files are checked, since
// the dist ones are what consumers actually bundle.
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = ['src/client/index.ts', 'dist/client/index.js', 'dist/client/index.cjs'];
const forbidden = [/^node:/, /^@aws-sdk\//, /^@nestjs\//, ...builtinModules.map((m) => new RegExp(`^${m}(/|$)`))];

let failed = false;
for (const entry of entries) {
  const result = await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  }).catch((error) => ({ error }));

  if (result.error) {
    failed = true;
    console.error(`✗ ${entry} does not bundle for the browser:\n${result.error.message}`);
    continue;
  }
  const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((i) => i.path));
  const leaked = imports.filter((path) => forbidden.some((pattern) => pattern.test(path)));
  const inputs = Object.keys(result.metafile.inputs);
  const serverCode = inputs.filter((path) => /media-client|providers[\\/]|keys\.|util\./.test(path));
  if (leaked.length || serverCode.length) {
    failed = true;
    console.error(`✗ ${entry} pulls in server-only code: ${[...leaked, ...serverCode].join(', ')}`);
    continue;
  }
  const size = result.outputFiles[0].contents.length;
  console.log(`✓ ${entry} bundles for the browser (${size} bytes, ${inputs.length} inputs)`);
}

if (failed) process.exit(1);
