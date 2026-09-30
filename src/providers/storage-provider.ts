import type { MediaBody, UploadProgress, Visibility } from '../types';

/** Object metadata as returned by a provider. */
export interface ProviderObject {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified: Date;
  /** User metadata, lowercase keys, without any provider-internal entries. */
  metadata: Record<string, string>;
  /** Undefined when the provider does not know (e.g. an S3 listing without HEAD). */
  visibility?: Visibility;
  contentDisposition?: string;
  cacheControl?: string;
}

export interface PutOptions {
  contentType: string;
  /** Known body length in bytes, when the client could determine it. */
  contentLength?: number;
  visibility: Visibility;
  metadata: Record<string, string>;
  cacheControl?: string;
  contentDisposition?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface CopyOptions {
  /**
   * When `visibility` or `metadata` is set the copy replaces the destination's metadata
   * (keeping the source's content type, disposition and cache control); otherwise the source
   * metadata is copied unchanged. Copying a key onto itself always sets one of them.
   */
  visibility?: Visibility;
  metadata?: Record<string, string>;
}

export interface ListOptions {
  /** Full prefix, already including the client's keyPrefix. */
  prefix: string;
  /** 1–1000. */
  limit: number;
  cursor?: string;
  includeMetadata?: boolean;
}

export interface SignedGetOptions {
  expiresInSeconds: number;
  /** Response Content-Disposition header value. */
  contentDisposition?: string;
}

export interface PresignedPostOptions {
  contentType: string;
  maxSizeBytes: number;
  expiresInSeconds: number;
  visibility: Visibility;
  metadata: Record<string, string>;
  contentDisposition?: string;
}

/**
 * Implement this to plug in another storage backend:
 * `createMediaClient({ provider: { type: 'custom', instance: myProvider } })`.
 *
 * The MediaClient validates keys, sizes and types before calling a provider, and wraps
 * anything a provider throws that is not already a MediaError as PROVIDER_ERROR. Providers
 * should throw MediaError('NOT_FOUND') from get() and copy() for a missing key.
 */
export interface StorageProvider {
  put(key: string, body: MediaBody, opts: PutOptions): Promise<ProviderObject>;
  get(key: string): Promise<{ body: NodeJS.ReadableStream; object: ProviderObject }>;
  /** Resolves null when the key does not exist. */
  head(key: string): Promise<ProviderObject | null>;
  /** Deleting a missing key counts as deleted. Receives at most 1000 keys per call. */
  delete(keys: string[]): Promise<{ deleted: string[]; failed: { key: string; error: unknown }[] }>;
  copy(src: string, dest: string, opts: CopyOptions): Promise<ProviderObject>;
  list(opts: ListOptions): Promise<{ items: ProviderObject[]; nextCursor?: string }>;
  signedGetUrl(key: string, opts: SignedGetOptions): Promise<string>;
  presignedPost(key: string, opts: PresignedPostOptions): Promise<{ url: string; fields: Record<string, string> }>;
}
