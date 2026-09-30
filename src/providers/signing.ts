import { createHmac, timingSafeEqual } from 'node:crypto';
import { MediaError } from '../errors';
import type { Visibility } from '../types';

// HMAC-signed upload policies and download links for the local and memory providers, which
// have no storage server of their own to do the signing. Mirrors what S3 enforces for a
// presigned POST: exact key, exact content type, maximum size and expiry.

export interface UploadPolicy {
  key: string;
  contentType: string;
  maxSizeBytes: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  visibility: Visibility;
  metadata: Record<string, string>;
  contentDisposition?: string;
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signUploadPolicy(policy: UploadPolicy, secret: string): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify(policy)).toString('base64url');
  return {
    key: policy.key,
    'Content-Type': policy.contentType,
    policy: encoded,
    signature: hmac(secret, `upload\n${encoded}`),
  };
}

/** Verifies presigned form fields and returns the policy. Throws ACCESS_DENIED otherwise. */
export function verifyUploadPolicy(fields: Record<string, string>, secret: string, now = Date.now()): UploadPolicy {
  const { policy: encoded, signature } = fields;
  if (!encoded || !signature || !safeEqual(signature, hmac(secret, `upload\n${encoded}`))) {
    throw new MediaError('ACCESS_DENIED', 'Invalid upload signature', { statusCode: 403 });
  }
  const policy = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UploadPolicy;
  if (now > policy.expiresAt) {
    throw new MediaError('ACCESS_DENIED', 'Upload policy has expired', { statusCode: 403 });
  }
  if (fields.key !== policy.key) {
    throw new MediaError('ACCESS_DENIED', 'Upload key does not match the policy', { statusCode: 403 });
  }
  if (fields['Content-Type'] !== policy.contentType) {
    throw new MediaError('ACCESS_DENIED', 'Content-Type does not match the policy', { statusCode: 403 });
  }
  return policy;
}

export const SIGNED_GET_PARAMS = {
  expires: 'X-Evrree-Expires',
  disposition: 'X-Evrree-Disposition',
  signature: 'X-Evrree-Signature',
} as const;

function getPayload(key: string, expiresAt: number, disposition: string): string {
  return `get\n${key}\n${expiresAt}\n${disposition}`;
}

/** Query string (without '?') for a signed download link. */
export function signGetQuery(key: string, expiresAt: number, disposition: string | undefined, secret: string): string {
  const params = new URLSearchParams();
  params.set(SIGNED_GET_PARAMS.expires, String(expiresAt));
  if (disposition) params.set(SIGNED_GET_PARAMS.disposition, disposition);
  params.set(SIGNED_GET_PARAMS.signature, hmac(secret, getPayload(key, expiresAt, disposition ?? '')));
  return params.toString();
}

/** Returns the signed Content-Disposition (or '') when valid, throws ACCESS_DENIED otherwise. */
export function verifyGetQuery(key: string, params: URLSearchParams, secret: string, now = Date.now()): string {
  const expiresAt = Number(params.get(SIGNED_GET_PARAMS.expires));
  const disposition = params.get(SIGNED_GET_PARAMS.disposition) ?? '';
  const signature = params.get(SIGNED_GET_PARAMS.signature) ?? '';
  if (!Number.isFinite(expiresAt) || !safeEqual(signature, hmac(secret, getPayload(key, expiresAt, disposition)))) {
    throw new MediaError('ACCESS_DENIED', 'Invalid signature', { statusCode: 403 });
  }
  if (now > expiresAt) throw new MediaError('ACCESS_DENIED', 'Signed URL has expired', { statusCode: 403 });
  return disposition;
}
