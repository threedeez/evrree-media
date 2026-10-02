# Evrree Media

`@evrree/media` is the one package Evrree apps use to store and serve files: profile photos,
question images, uploaded documents, exports. Apps call `media.upload(...)`,
`media.getSignedUrl(...)` and so on, and never touch the AWS SDK. Storage is any
S3-compatible service (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO), the local disk for
development, or memory for tests.

| Import                 | Runs in                    | Contents                                                          |
| ---------------------- | -------------------------- | ----------------------------------------------------------------- |
| `@evrree/media`        | Node 20+                   | `createMediaClient`, `MediaClient`, providers, errors, key helpers |
| `@evrree/media/client` | Browser / Electron renderer | `uploadToPresignedUrl`, `MediaError`, browser types              |
| `@evrree/media/nestjs` | NestJS 10+                 | `MediaModule`, `InjectMedia`, `MEDIA_CLIENT`                      |

The core and client entries don't need NestJS installed. The client entry has no Node or AWS
SDK imports; CI bundles it with `--platform=browser` to keep it that way.

## Contents

- [Install](#install)
- [Configuration](#configuration): [AWS S3](#aws-s3), [Cloudflare R2](#cloudflare-r2), [MinIO](#minio), [DigitalOcean Spaces](#digitalocean-spaces), [local disk](#local-disk-development), [memory](#memory-tests)
- [Plain Node example](#plain-node-example)
- [NestJS](#nestjs)
- [Browser uploads with presigned URLs](#browser-uploads-with-presigned-urls)
- [Bucket CORS for browser uploads](#bucket-cors-for-browser-uploads)
- [API reference](#api-reference)
- [Errors](#errors)
- [Security notes](#security-notes)
- [Custom providers](#custom-providers)
- [Development](#development)

## Install

```bash
pnpm add @evrree/media
```

The package is published to the private `@evrree` scope. Copy `.npmrc.example` into the
consuming repo as `.npmrc` and provide `NPM_READ_TOKEN`, the same way as for `@evrree/ui`.

For NestJS apps, `@nestjs/common` (10 or later) and `reflect-metadata` are optional peer
dependencies. A Nest app already has both.

## Configuration

```ts
import { createMediaClient } from '@evrree/media';

const media = createMediaClient({
  provider: {
    type: 's3',                       // 's3' | 'local' | 'memory' | 'custom'
    bucket: 'evrree-cbt-prod',
    region: 'eu-west-1',              // 'auto' for Cloudflare R2
    endpoint: undefined,              // set for R2 / Spaces / MinIO
    forcePathStyle: false,            // true for MinIO
    credentials: { accessKeyId: '...', secretAccessKey: '...' }, // optional: AWS default chain otherwise
    useAcl: false,                    // optional, see "Visibility" below
  },
  publicBaseUrl: 'https://cdn.evrree.com',  // optional; used for public URLs
  defaultVisibility: 'private',             // 'private' | 'public'
  keyPrefix: 'cbt',                         // optional; namespaces this app's files
  validation: {
    maxSizeBytes: 10 * 1024 * 1024,         // default 10 MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], // default: all; 'image/*' works
    verifyContentSignature: true,           // default true: magic bytes must match the declared type
  },
  signedUrlExpiresInSeconds: 900,           // default 15 min, max 7 days
  logger: console,                          // optional: anything with debug/info/warn/error
});
```

`createMediaClient` checks the whole config up front. A missing bucket, a negative size, an
expiry over 7 days or any other bad value throws `MediaError` with code `CONFIG_ERROR`, and
the message names the field (`Invalid media config: provider.bucket is required`). Nothing is
sent to storage at this point.

**The package never reads `process.env`.** Pass it everything it needs. The one exception is
the local provider, which reads `NODE_ENV` to warn when it is used in production. The AWS SDK
itself may still read the standard `AWS_*` variables when you leave `credentials` out: that's
the default credential chain, and it's how IAM roles on ECS/EC2/Lambda work.

### Key prefix

`keyPrefix` is prepended to every generated key and scopes `list()`. Keys returned by the
client always include it, so store them as they are and pass them back to any method. The
client never adds the prefix twice. An explicit key given to `upload`, `createPresignedUpload`,
`copy` or `move` gets the prefix unless it already starts with it.

### Visibility

Each object is `private` (default) or `public`. Visibility is stored in the object's metadata
(`x-amz-meta-evrree-visibility`) and returned on every `MediaObject`. Public objects get a
`url` built from `publicBaseUrl`.

The package does not open a bucket up by itself. New AWS buckets have ACLs disabled, and R2
doesn't support them, so public access normally comes from a CDN or a bucket policy on the
public paths. If your bucket does use ACLs, set `provider.useAcl: true` and uploads also send
`public-read` or `private`.

### AWS S3

```ts
createMediaClient({
  provider: { type: 's3', bucket: 'evrree-cbt-prod', region: 'eu-west-1' }, // IAM role credentials
  publicBaseUrl: 'https://cdn.evrree.com',  // CloudFront in front of the bucket
  keyPrefix: 'cbt',
});
```

The IAM policy needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on
the bucket, plus `s3:PutObjectAcl` if `useAcl` is on. Multipart uploads use the same
permissions.

### Cloudflare R2

```ts
createMediaClient({
  provider: {
    type: 's3',
    bucket: 'evrree-cbt',
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  },
  publicBaseUrl: 'https://media.evrree.com', // the bucket's custom domain or r2.dev URL
});
```

When `endpoint` is set, the client only sends request checksums when an operation needs them,
because R2 and some other S3-compatible services reject the SDK's newer default checksums.

### MinIO

```ts
createMediaClient({
  provider: {
    type: 's3',
    bucket: 'evrree-local',
    region: 'us-east-1',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  },
  publicBaseUrl: 'http://localhost:9000/evrree-local',
});
```

### DigitalOcean Spaces

```ts
createMediaClient({
  provider: {
    type: 's3',
    bucket: 'evrree-cbt',
    region: 'fra1',
    endpoint: 'https://fra1.digitaloceanspaces.com',
    credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
  },
  publicBaseUrl: 'https://evrree-cbt.fra1.cdn.digitaloceanspaces.com',
});
```

### Local disk (development)

```ts
import express from 'express';
import { createLocalMediaHandler, createMediaClient } from '@evrree/media';

const local = { rootDir: './.media', baseUrl: 'http://localhost:4000/media' };
const media = createMediaClient({ provider: { type: 'local', ...local } });

const app = express();
app.use('/media', createLocalMediaHandler(local)); // serves files + accepts presigned uploads
```

Files are written to `rootDir/<key>`, with metadata kept under `rootDir/.evrree-meta/`. Every
path is resolved and checked, symlinks included, so no key can read or write outside
`rootDir`. The handler serves public files directly and private ones through signed URLs, and
it accepts browser uploads made with `createPresignedUpload` (checking the size, type, key and
expiry the way S3 would), so the full browser flow works locally without MinIO.
`publicBaseUrl` defaults to `baseUrl`.

Signed URLs and upload policies are signed with `signingSecret`. If you leave it out, a value
derived from `rootDir` is used, which is fine for development only. When
`NODE_ENV === 'production'`, the provider logs a warning at startup. This is the one place the
package reads the environment.

### Memory (tests)

```ts
import { createMediaClient, MemoryStorageProvider } from '@evrree/media';

const media = createMediaClient({ provider: { type: 'memory' } });
const memory = media.provider as MemoryStorageProvider;

// Complete a presigned upload the way a browser would, with the same checks:
const presigned = await media.createPresignedUpload({ fileName: 'a.png', contentType: 'image/png' });
await memory.acceptPresignedPost(presigned.fields, pngBuffer);
// Follow a signed URL, checking expiry and signature:
const { body, contentDisposition } = await memory.resolveSignedUrl(await media.getSignedUrl(key));
```

Each memory client is isolated. `memory.clear()` resets it.

## Plain Node example

```ts
import { createReadStream } from 'node:fs';
import { createMediaClient, isMediaError } from '@evrree/media';

const media = createMediaClient({
  provider: { type: 's3', bucket: 'evrree-cbt-prod', region: 'eu-west-1' },
  publicBaseUrl: 'https://cdn.evrree.com',
  keyPrefix: 'cbt',
  validation: { maxSizeBytes: 50 * 1024 * 1024, allowedMimeTypes: ['image/*', 'application/pdf'] },
});

// Upload: validated, then sent. Over 8 MB goes multipart automatically.
const file = await media.upload({
  body: createReadStream('./question-12.png'),
  fileName: 'question-12.png',
  contentType: 'image/png',
  folder: 'questions/images',
  visibility: 'public',
  metadata: { uploadedBy: 'user_123' },
  onProgress: ({ loadedBytes, totalBytes }) => console.log(loadedBytes, totalBytes),
});
// file.key -> 'cbt/questions/images/2026/09/1b4e...-question-12.png'   (save this)
// file.url -> 'https://cdn.evrree.com/cbt/questions/images/2026/09/1b4e...-question-12.png'

// Temporary link to a private file, downloaded under a friendly name.
const link = await media.getSignedUrl(reportKey, { expiresInSeconds: 300, downloadFileName: 'Results.pdf' });

// Proxy a file through an API route.
app.get('/files/:id', async (req, res) => {
  try {
    const { body, object } = await media.getStream(await keyFor(req.params.id));
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Length', object.size);
    body.pipe(res);
  } catch (error) {
    if (isMediaError(error, 'NOT_FOUND')) return res.sendStatus(404);
    throw error;
  }
});

// Clean up.
const { failed } = await media.deleteMany(oldKeys);
```

With Multer or similar, pass the buffer: `media.upload({ body: file.buffer, fileName:
file.originalname, contentType: file.mimetype })`.

## NestJS

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MediaModule } from '@evrree/media/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    MediaModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        provider: {
          type: 's3',
          bucket: config.getOrThrow('MEDIA_BUCKET'),
          region: config.getOrThrow('MEDIA_REGION'),
          endpoint: config.get('MEDIA_ENDPOINT'),
        },
        publicBaseUrl: config.get('MEDIA_PUBLIC_BASE_URL'),
        keyPrefix: 'cbt',
      }),
    }),
  ],
})
export class AppModule {}
```

```ts
import { Injectable } from '@nestjs/common';
import type { MediaClient } from '@evrree/media';
import { InjectMedia } from '@evrree/media/nestjs';

@Injectable()
export class AvatarService {
  constructor(@InjectMedia() private readonly media: MediaClient) {}

  async setAvatar(userId: string, file: Express.Multer.File) {
    const avatar = await this.media.upload({
      body: file.buffer,
      fileName: file.originalname,
      contentType: file.mimetype,
      folder: 'avatars',
      visibility: 'public',
      metadata: { userId },
    });
    return avatar.url;
  }
}
```

- `MediaModule.forRoot(config)` takes the same config as `createMediaClient`, plus `isGlobal`.
- `MediaModule.forRootAsync({ imports?, inject?, useFactory, isGlobal? })` builds it from other
  providers.
- `isGlobal` defaults to `true`, so feature modules can inject the client without importing
  `MediaModule`.
- `@InjectMedia()` is shorthand for `@Inject(MEDIA_CLIENT)`. The client is also registered
  under the `MediaClient` class for type-based injection.
- Invalid config fails the app at bootstrap with `CONFIG_ERROR`.

## Browser uploads with presigned URLs

Large files should go straight from the browser to storage, not through the API. The API
signs a short-lived upload policy, the browser posts the file to storage with it, and the
API then checks the result.

```
Browser                       API (MediaClient)                     Storage
   | 1. "I want to upload x.pdf"  |                                     |
   |----------------------------->| createPresignedUpload()             |
   |<-----------------------------|  { key, url, fields, maxSizeBytes } |
   | 2. uploadToPresignedUrl()    |                                     |
   |------------------------------------------------------------------->| checks size, type, key, expiry
   | 3. "done", key               |                                     |
   |----------------------------->| head(key): exists? size? type?      |
   |                              | save key in DB                      |
```

The storage server enforces the size limit (`content-length-range`), the exact content type,
the exact key and the expiry. The browser can't change any of them, because they are signed
into the policy.

### Backend

```ts
// POST /uploads/presign  { fileName, contentType }
app.post('/uploads/presign', async (req, res) => {
  const presigned = await media.createPresignedUpload({
    fileName: req.body.fileName,
    contentType: req.body.contentType,   // checked against allowedMimeTypes before signing
    folder: `submissions/${req.user.id}`,
    maxSizeBytes: 20 * 1024 * 1024,      // may not exceed validation.maxSizeBytes
    metadata: { uploadedBy: req.user.id },
    expiresInSeconds: 300,               // default 300
  });
  // Remember which key this user may confirm (e.g. a pending_uploads row or the session).
  await pendingUploads.create({ userId: req.user.id, key: presigned.key });
  res.json(presigned);
});

// POST /uploads/confirm  { key }
app.post('/uploads/confirm', async (req, res) => {
  const pending = await pendingUploads.find({ userId: req.user.id, key: req.body.key });
  if (!pending) return res.sendStatus(403);

  const object = await media.head(req.body.key);
  if (!object) return res.status(400).json({ error: 'Upload not found' });
  if (object.size > 20 * 1024 * 1024 || object.contentType !== 'application/pdf') {
    await media.delete(object.key);
    return res.status(400).json({ error: 'Unexpected file' });
  }
  await documents.create({ userId: req.user.id, key: object.key, size: object.size });
  res.json({ key: object.key });
});
```

The presigned POST can't inspect file contents. If you need the magic-byte check for browser
uploads, read the start of the file in the confirm step:

```ts
import { matchesContentSignature } from '@evrree/media';

const { body } = await media.getStream(object.key);
for await (const chunk of body) {
  if (matchesContentSignature(object.contentType, chunk as Buffer) === false) {
    await media.delete(object.key);
    return res.status(400).json({ error: 'File content does not match its type' });
  }
  break;
}
```

### Frontend

```ts
import { isMediaError, uploadToPresignedUrl } from '@evrree/media/client';

async function uploadDocument(file: File, onProgress: (percent: number) => void, signal?: AbortSignal) {
  const presigned = await fetch('/uploads/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, contentType: file.type }),
  }).then((r) => r.json());

  try {
    const { key } = await uploadToPresignedUrl(presigned, file, { onProgress, signal });
    await fetch('/uploads/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    return key;
  } catch (error) {
    if (isMediaError(error, 'FILE_TOO_LARGE')) alert('That file is too large.');
    else if (isMediaError(error, 'ABORTED')) return null;
    else throw error; // UPLOAD_FAILED, with error.statusCode
  }
}

// Cancel button:
const controller = new AbortController();
uploadDocument(file, setPercent, controller.signal);
cancelButton.onclick = () => controller.abort();
```

`uploadToPresignedUrl` uses `XMLHttpRequest`, which, unlike `fetch`, reports upload
progress. It sends every presigned field first and the file last (S3 ignores fields after the
file). `onProgress` gets 0 at the start and 100 once storage accepts the file. A file over
`maxSizeBytes` is rejected before anything is sent.

## Bucket CORS for browser uploads

Browsers can only post to the bucket if its CORS rules allow the app's origin.

**AWS S3** (Bucket → Permissions → CORS):

```json
[
  {
    "AllowedOrigins": ["https://app.evrree.com", "http://localhost:3000"],
    "AllowedMethods": ["POST", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**Cloudflare R2**: the same JSON under R2 → bucket → Settings → CORS policy.

**MinIO**: MinIO allows all origins by default. To restrict them, set
`MINIO_API_CORS_ALLOW_ORIGIN=https://app.evrree.com`.

**Electron**: the renderer's origin is `file://` or a custom scheme. Add that origin, or make
the upload from a page served over http(s).

## API reference

All methods reject with `MediaError`. Every method that takes a key validates it first (see
`assertValidKey`).

### `createMediaClient(config): MediaClient`

Validates the config (throwing `CONFIG_ERROR`) and returns a client. See
[Configuration](#configuration).

### `MediaObject`

```ts
interface MediaObject {
  key: string;                       // full key, including keyPrefix
  size: number;                      // bytes
  contentType: string;
  etag?: string;
  visibility: 'private' | 'public';
  metadata: Record<string, string>;  // keys are lowercase
  lastModified: Date;
  url?: string;                      // when public and publicBaseUrl is set
}
```

### Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `upload(input)` | `MediaObject` | Validates type, size and magic bytes, then uploads. Over 8 MB uses multipart. `onProgress` fires at least once per part. `signal` cancels (`ABORTED`). |
| `createPresignedUpload(opts)` | `PresignedUpload` | Presigned POST for browsers. Checks `contentType` before signing. Storage enforces size and type. |
| `getSignedUrl(key, opts?)` | `string` | Temporary read URL. `expiresInSeconds`, `downloadFileName` (attachment), `inline`. |
| `getPublicUrl(key)` | `string` | `${publicBaseUrl}/${key}`. `CONFIG_ERROR` without `publicBaseUrl`. Synchronous. |
| `getStream(key)` | `{ body, object }` | Node readable stream. `NOT_FOUND` if missing. |
| `getBuffer(key)` | `{ body: Buffer, object }` | Whole file in memory. `FILE_TOO_LARGE` over `maxSizeBytes`. |
| `head(key)` | `MediaObject \| null` | `null` if missing. Never throws for a missing key. |
| `exists(key)` | `boolean` | `head(key) !== null`. |
| `delete(key)` | `void` | Deleting a missing key succeeds. |
| `deleteMany(keys)` | `{ deleted, failed }` | Batches of 1000. Invalid keys and per-key failures go in `failed`. Never throws for individual failures. |
| `copy(src, dest, opts?)` | `MediaObject` | Server-side copy. `opts.visibility` / `opts.metadata` replace the destination's. |
| `move(src, dest)` | `MediaObject` | Copy, then delete the source. If the delete fails, the error is thrown and the copy is kept. |
| `list(opts?)` | `{ items, nextCursor? }` | Scoped to `keyPrefix`. `prefix` (relative), `limit` (default 100, max 1000), `cursor`. |
| `updateMetadata(key, metadata, opts?)` | `MediaObject` | Replaces metadata (and `opts.visibility`), keeping the content type, disposition and cache control. |

#### `upload(input: UploadInput)`

| Field | Type | |
| --- | --- | --- |
| `body` | `Buffer \| Uint8Array \| NodeJS.ReadableStream \| Blob \| string` | Streams of unknown length are cut off as soon as they exceed `maxSizeBytes`. |
| `fileName` | `string` | Original name. Used for the generated key and `Content-Disposition`. |
| `contentType` | `string` | Checked against `allowedMimeTypes` and, for JPEG/PNG/GIF/WebP/PDF/MP4, the file's magic bytes. |
| `key?` | `string` | Explicit key. Otherwise `generateKey()` is used. |
| `folder?` | `string` | e.g. `'avatars'`, `'questions/images'`. |
| `visibility?` | `'private' \| 'public'` | Defaults to `defaultVisibility`. |
| `metadata?` | `Record<string, string>` | Keys are lowercased and may contain letters, digits, `-` and `_`. |
| `cacheControl?` | `string` | e.g. `'public, max-age=31536000, immutable'`. |
| `onProgress?` | `({ loadedBytes, totalBytes? }) => void` | |
| `signal?` | `AbortSignal` | |

#### `createPresignedUpload(opts: PresignedUploadOptions)`

Input: `fileName`, `contentType`, `folder?`, `key?`, `maxSizeBytes?` (defaults to and may not
exceed `validation.maxSizeBytes`), `visibility?`, `expiresInSeconds?` (default 300),
`metadata?`.

Output: `{ key, url, method: 'POST', fields, expiresAt, maxSizeBytes }`. Store `key` on the
backend: that is where the file will be.

#### `list(opts?)`

Pages through keys in order. Pass `nextCursor` back as `cursor` until it is `undefined`.
S3's listing API doesn't return content type, metadata or visibility, so on the S3 provider
those come back empty (and visibility defaults to `defaultVisibility`) unless you pass
`includeMetadata: true`, which makes one HEAD request per item. The local and memory
providers always include them.

### Helpers

| Export | |
| --- | --- |
| `generateKey({ fileName, folder?, prefix? })` | `{prefix}/{folder}/{yyyy}/{mm}/{uuid}-{sanitized-name}` (UTC). Empty parts are skipped. |
| `sanitizeFileName(name)` | Lowercases, turns spaces and unsafe characters into `-`, drops any directory part, trims to 100 characters, keeps the extension. |
| `assertValidKey(key)` | Throws `INVALID_KEY` for empty keys, a leading `/`, `..`, `\`, control characters, or more than 1024 UTF-8 bytes. |
| `matchesContentSignature(type, bytes)` | `true`/`false`, or `undefined` when there is no signature for the type. |
| `isMediaError(error, code?)` | Type guard. |
| `createLocalMediaHandler(config)` | Dev HTTP handler for the local provider. |

### Browser: `uploadToPresignedUrl(presigned, file, opts?)`

`opts`: `onProgress?: (percent: number) => void`, `signal?: AbortSignal`. Resolves
`{ key }`. Rejects with `FILE_TOO_LARGE` (before sending), `ABORTED`, or `UPLOAD_FAILED` with
`statusCode` and the storage error code in the message.

## Errors

Every failure is a `MediaError`:

```ts
class MediaError extends Error {
  code: MediaErrorCode;
  statusCode?: number;  // HTTP status from the provider, if any
  cause?: unknown;      // the original error
}
```

| Code | When |
| --- | --- |
| `CONFIG_ERROR` | Invalid config at `createMediaClient`, an invalid option value (e.g. `expiresInSeconds` over 7 days, bad metadata), or `getPublicUrl` without `publicBaseUrl`. |
| `INVALID_KEY` | A key failed `assertValidKey`, or (local provider) would resolve outside `rootDir`. |
| `NOT_FOUND` | `getStream` / `getBuffer` / `copy` / `move` / `updateMetadata` on a missing key. S3 `NoSuchKey` / 404. |
| `FILE_TOO_LARGE` | Over `maxSizeBytes`: upload, `getBuffer`, browser pre-check, or S3 `EntityTooLarge`. |
| `UNSUPPORTED_TYPE` | `contentType` isn't allowed by `allowedMimeTypes`, or isn't a valid media type. |
| `CONTENT_MISMATCH` | Magic bytes don't match the declared type (JPEG, PNG, GIF, WebP, PDF, MP4). |
| `UPLOAD_FAILED` | Browser upload rejected by storage or a network error (with `statusCode`), or an invalid upload body. |
| `ABORTED` | The `AbortSignal` fired. |
| `ACCESS_DENIED` | S3 `AccessDenied` / 403, bad credentials or signature, expired signed link (local/memory), or a filesystem permission error. |
| `PROVIDER_ERROR` | Anything else from storage (5xx, throttling, network, missing bucket). The original is in `cause`. |

Raw AWS SDK errors never reach the caller. They are always wrapped, with the original kept
as `cause`. A missing bucket is reported as `PROVIDER_ERROR` rather than `NOT_FOUND`, so
"file doesn't exist" handling can't hide a misconfiguration.

## Security notes

- **Keys** are validated on every call. The file-name part of generated keys is sanitized to
  `[a-z0-9._-]`, so user-supplied names can't inject paths.
- **Types** are checked against `allowedMimeTypes`, and file contents against their declared
  type (`verifyContentSignature`). The check only covers JPEG, PNG, GIF, WebP, PDF and MP4.
- **Logging:** the client logs operation names, keys, sizes, content types and error codes.
  It never logs file contents, metadata values, signed URLs, presigned fields or credentials.
- **Virus scanning is not included.** Add it for untrusted uploads, for example with a
  bucket-event scanner, or by scanning in your confirm step before the key is saved or served.
- Presigned uploads are limited to one key, one content type and a maximum size, and expire
  after 5 minutes by default.

## Custom providers

Anything that implements `StorageProvider` can be plugged in, e.g. for Google Cloud Storage
or Azure:

```ts
import { createMediaClient, type StorageProvider } from '@evrree/media';

class GcsProvider implements StorageProvider {
  put(key, body, opts) { /* ... */ }
  get(key) { /* ... */ }
  head(key) { /* ... resolve null when missing */ }
  delete(keys) { /* ... missing keys count as deleted */ }
  copy(src, dest, opts) { /* ... */ }
  list(opts) { /* ... */ }
  signedGetUrl(key, opts) { /* ... */ }
  presignedPost(key, opts) { /* ... */ }
}

const media = createMediaClient({ provider: { type: 'custom', instance: new GcsProvider() } });
```

The client handles key validation, key prefixes, size/type/signature checks, batching
(`delete` never gets more than 1000 keys) and error wrapping. Anything a provider throws that
isn't already a `MediaError` becomes `PROVIDER_ERROR`. Throw `MediaError('NOT_FOUND')` from
`get` and `copy` for missing keys.

## Development

```bash
pnpm install
pnpm test               # unit tests + coverage (80% line threshold)
pnpm minio:up           # MinIO on localhost:9100 via docker-compose.test.yml
pnpm test:integration   # presigned POST, signed URL expiry, pagination, multipart against MinIO
pnpm minio:down
pnpm build              # ESM + CJS + .d.ts for ., ./client, ./nestjs
pnpm check-lib-deps     # dependency allowlist; core must not depend on NestJS
pnpm check-browser      # client entry bundles with --platform=browser
pnpm smoke              # pack, install into fresh CJS and ESM projects, require/import
```

Unit tests use the memory provider for client logic and `aws-sdk-client-mock` for the S3
provider. Set `MINIO_PORT` or `MINIO_ENDPOINT` to point the integration tests at another
MinIO.

Releases use Changesets, the same as evrree-ui: add one with `pnpm changeset`. Merging to
`main` opens a "Version Packages" PR, and merging that PR publishes to npm through Trusted
Publishing.
