export { createMediaClient, MediaClient } from './media-client';
export { MediaError, isMediaError } from './errors';
export type { MediaErrorCode, MediaErrorOptions } from './errors';
export { generateKey, sanitizeFileName, assertValidKey } from './keys';
export type { GenerateKeyOptions } from './keys';
export {
  DEFAULT_MAX_SIZE_BYTES,
  SIGNATURE_CHECKED_TYPES,
  isMimeTypeAllowed,
  matchesContentSignature,
} from './validation';
export { S3StorageProvider, mapS3Error, MULTIPART_PART_SIZE_BYTES } from './providers/s3.provider';
export { LocalStorageProvider, createLocalMediaHandler } from './providers/local.provider';
export { MemoryStorageProvider } from './providers/memory.provider';
export type {
  StorageProvider,
  ProviderObject,
  PutOptions,
  CopyOptions,
  ListOptions,
  SignedGetOptions,
  PresignedPostOptions,
} from './providers/storage-provider';
export type {
  Visibility,
  MediaBody,
  MediaObject,
  UploadInput,
  UploadProgress,
  PresignedUploadOptions,
  PresignedUpload,
  GetSignedUrlOptions,
  MediaCopyOptions,
  MediaListOptions,
  UpdateMetadataOptions,
  ListResult,
  DeleteManyResult,
  MediaLogger,
  MediaClientConfig,
  ValidationConfig,
  ProviderConfig,
  S3ProviderConfig,
  S3Credentials,
  LocalProviderConfig,
  MemoryProviderConfig,
  CustomProviderConfig,
} from './types';
