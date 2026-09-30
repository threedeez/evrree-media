import type { StorageProvider } from './providers/storage-provider';

export type Visibility = 'private' | 'public';

export type MediaBody = Buffer | Uint8Array | NodeJS.ReadableStream | Blob | string;

export interface MediaObject {
  /** Full storage key, including keyPrefix. Store it as-is and pass it back to any method. */
  key: string;
  /** Size in bytes. */
  size: number;
  contentType: string;
  etag?: string;
  visibility: Visibility;
  /** User metadata. Keys are always lowercase (S3 lowercases them; other providers match). */
  metadata: Record<string, string>;
  lastModified: Date;
  /** Public URL, present only when visibility === 'public' and publicBaseUrl is configured. */
  url?: string;
}

export interface UploadProgress {
  loadedBytes: number;
  totalBytes?: number;
}

export interface UploadInput {
  body: MediaBody;
  /** Original file name, used for the generated key and Content-Disposition. */
  fileName: string;
  contentType: string;
  /** Explicit key. keyPrefix is prepended unless the key already starts with it. */
  key?: string;
  /** e.g. 'avatars', 'questions/images'. Ignored when `key` is given. */
  folder?: string;
  visibility?: Visibility;
  /** e.g. { uploadedBy: 'user_123' }. Keys are lowercased. */
  metadata?: Record<string, string>;
  cacheControl?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface PresignedUploadOptions {
  fileName: string;
  contentType: string;
  folder?: string;
  key?: string;
  /** Defaults to config.validation.maxSizeBytes and may not exceed it. */
  maxSizeBytes?: number;
  visibility?: Visibility;
  /** Default 300. */
  expiresInSeconds?: number;
  metadata?: Record<string, string>;
}

export interface PresignedUpload {
  /** Where the file will be stored. The backend must keep this. */
  key: string;
  url: string;
  method: 'POST';
  /** Form fields the browser must send, before the file. */
  fields: Record<string, string>;
  expiresAt: Date;
  maxSizeBytes: number;
}

export interface GetSignedUrlOptions {
  /** Defaults to config.signedUrlExpiresInSeconds. Max 7 days. */
  expiresInSeconds?: number;
  /** Sets Content-Disposition: attachment; filename="..." on the response. */
  downloadFileName?: string;
  /** Sets Content-Disposition: inline (with the download file name, if given). */
  inline?: boolean;
}

export interface MediaCopyOptions {
  /** Replaces the destination visibility. Defaults to the source's. */
  visibility?: Visibility;
  /** Replaces the destination metadata. Defaults to the source's. */
  metadata?: Record<string, string>;
}

export interface UpdateMetadataOptions {
  visibility?: Visibility;
}

export interface MediaListOptions {
  /** Relative to keyPrefix. A prefix that already includes keyPrefix is used as-is. */
  prefix?: string;
  /** Default 100, max 1000. */
  limit?: number;
  cursor?: string;
  /**
   * S3 only: listings do not include content type, metadata or visibility. Set this to fetch
   * them with a HEAD request per item. Other providers always include them.
   */
  includeMetadata?: boolean;
}

export interface ListResult {
  items: MediaObject[];
  nextCursor?: string;
}

export interface DeleteManyResult {
  deleted: string[];
  failed: { key: string; error: import('./errors').MediaError }[];
}

export interface MediaLogger {
  debug?: (message: string, context?: Record<string, unknown>) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
  error?: (message: string, context?: Record<string, unknown>) => void;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3ProviderConfig {
  type: 's3';
  bucket: string;
  /** Use 'auto' for Cloudflare R2. */
  region: string;
  /** Set for R2 / Spaces / MinIO. */
  endpoint?: string;
  /** true for MinIO. */
  forcePathStyle?: boolean;
  /** Optional; falls back to the AWS default credential chain. */
  credentials?: S3Credentials;
  /**
   * Also send a canned ACL (public-read / private) matching the visibility. Off by default:
   * new AWS buckets have ACLs disabled and Cloudflare R2 ignores them, so public access is
   * normally granted by a bucket policy or CDN instead. Visibility is always recorded in
   * object metadata either way.
   */
  useAcl?: boolean;
}

export interface LocalProviderConfig {
  type: 'local';
  /** Directory files are written to. Created if missing. */
  rootDir: string;
  /** URL the local media handler is served at, e.g. http://localhost:4000/media. */
  baseUrl: string;
  /**
   * Secret for signing local URLs and upload policies. Defaults to a value derived from
   * rootDir, which is fine for development only.
   */
  signingSecret?: string;
}

export interface MemoryProviderConfig {
  type: 'memory';
}

export interface CustomProviderConfig {
  type: 'custom';
  instance: StorageProvider;
}

export type ProviderConfig = S3ProviderConfig | LocalProviderConfig | MemoryProviderConfig | CustomProviderConfig;

export interface ValidationConfig {
  /** Default 10 MB. */
  maxSizeBytes?: number;
  /** Default: allow all. Supports wildcards such as 'image/*'. */
  allowedMimeTypes?: string[];
  /** Check magic bytes match the declared type. Default true. */
  verifyContentSignature?: boolean;
}

export interface MediaClientConfig {
  provider: ProviderConfig;
  /** Used by getPublicUrl() and for public upload URLs. */
  publicBaseUrl?: string;
  /** Default 'private'. */
  defaultVisibility?: Visibility;
  /** Prepended to every key; namespaces one app's files. */
  keyPrefix?: string;
  validation?: ValidationConfig;
  /** Default 900 (15 min). Max 604800 (7 days). */
  signedUrlExpiresInSeconds?: number;
  logger?: MediaLogger;
}
