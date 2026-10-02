#!/usr/bin/env node
// Same guard as evrree-ui: package.json "dependencies" must match an explicit allowlist, and
// the built dist/ may only import allowed packages or Node built-ins. On top of that, the
// core entry must not reference @nestjs at all (AC4) and the client entry must not reference
// anything external (AC3).
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_DEPENDENCIES = [
  '@aws-sdk/client-s3',
  '@aws-sdk/lib-storage',
  '@aws-sdk/s3-presigned-post',
  '@aws-sdk/s3-request-presigner',
];
const ALLOWED_PEER_DEPENDENCIES = ['@nestjs/common', 'reflect-metadata'];
const ALLOWED = [...ALLOWED_DEPENDENCIES, ...ALLOWED_PEER_DEPENDENCIES];

let failed = false;
const fail = (message) => {
  console.error(`\n✗ check-lib-deps: ${message}`);
  failed = true;
};

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const declared = Object.keys(pkg.dependencies ?? {});
const notAllowed = declared.filter((name) => !ALLOWED_DEPENDENCIES.includes(name));
if (notAllowed.length) {
  fail(`package.json "dependencies" includes packages not in the allowlist: ${notAllowed.join(', ')}`);
} else {
  console.log(`✓ package.json "dependencies" (${declared.length}) are all in the allowlist`);
}

function specifiers(file) {
  const text = readFileSync(file, 'utf8');
  const found = new Set();
  for (const m of text.matchAll(/require\(["']([^"']+)["']\)/g)) found.add(m[1]);
  for (const m of text.matchAll(/\b(?:import|export)\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)) found.add(m[1]);
  return [...found];
}

// Follows relative imports so a chunk shared by an entry is checked as part of that entry.
function graph(entry) {
  const seen = new Set();
  const external = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const s of specifiers(file)) {
      if (s.startsWith('.')) visit(resolve(dirname(file), s));
      else external.add(s);
    }
  };
  visit(resolve(root, entry));
  return [...external];
}

const isBuiltin = (s) => s.startsWith('node:') || builtinModules.includes(s.split('/')[0]);
const isAllowed = (s) => isBuiltin(s) || ALLOWED.some((a) => s === a || s.startsWith(`${a}/`));

let distFiles;
try {
  distFiles = readdirSync(resolve(root, 'dist'), { recursive: true }).filter((f) => /\.(c?js)$/.test(f));
} catch {
  fail('dist/ does not exist — run "pnpm build" first');
  process.exit(1);
}
const all = new Set(distFiles.flatMap((f) => specifiers(join(root, 'dist', f))).filter((s) => !s.startsWith('.')));
const disallowed = [...all].filter((s) => !isAllowed(s));
if (disallowed.length) fail(`dist/ imports packages that are not allowed: ${disallowed.join(', ')}`);
else console.log(`✓ dist/ imports only allowed packages and Node built-ins (${all.size} specifiers)`);

for (const format of ['js', 'cjs']) {
  const core = graph(`dist/index.${format}`);
  const nest = core.filter((s) => s.startsWith('@nestjs/') || s === 'reflect-metadata');
  if (nest.length) fail(`dist/index.${format} depends on ${nest.join(', ')}; the core entry must work without NestJS`);
  else console.log(`✓ dist/index.${format} does not depend on @nestjs/* or reflect-metadata`);

  const client = graph(`dist/client/index.${format}`);
  if (client.length) fail(`dist/client/index.${format} imports ${client.join(', ')}; it must be self-contained`);
  else console.log(`✓ dist/client/index.${format} has no external imports`);
}

if (failed) {
  console.error('\n✗ check-lib-deps failed — see above.\n');
  process.exit(1);
}
console.log('\n✓ check-lib-deps passed.');
