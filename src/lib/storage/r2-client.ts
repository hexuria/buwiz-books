/**
 * Cloudflare R2 Storage Client
 * S3-compatible API for cloud file storage
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { UploadResult, PresignedUrlOptions } from "./types";
import { createLogger } from "../logger";

const logger = createLogger("storage.r2");

// R2 Configuration from environment
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
export const R2_BUCKET = process.env.R2_BUCKET || "mvg";

/**
 * Check if R2 is properly configured
 */
export function isR2Configured(): boolean {
  return Boolean(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

/**
 * Create S3 client for R2 (lazy initialization)
 */
function createR2Client(): S3Client {
  if (!isR2Configured()) {
    throw new Error(
      "R2 storage not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID!,
      secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
  });
}

// Lazy-initialized client
let _r2Client: S3Client | null = null;

function getR2Client(): S3Client {
  if (!_r2Client) {
    _r2Client = createR2Client();
  }
  return _r2Client;
}

/**
 * Whether R2 calls should be short-circuited (Playwright E2E runs).
 *
 * Gated on a dedicated flag set by the `dev:test` server. Hard-blocked in production so a
 * stray env var can never make uploads silently no-op (returning fake keys / claiming files
 * exist). In non-prod it stays independent of NODE_ENV, which Vitest sets automatically.
 */
function isR2Bypassed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.E2E_BYPASS_R2 === "true";
}

/**
 * Generate a unique R2 object key with organization prefix
 * Format: {orgId}/{timestamp}-{randomId}-{sanitizedFilename}
 */
export function generateR2Key(orgId: string, filename: string): string {
  const timestamp = Date.now();
  const randomId = crypto.randomUUID().slice(0, 8);
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `${orgId}/${timestamp}-${randomId}-${sanitized}`;
}

/**
 * Upload a file to R2 storage
 */
export async function uploadToR2(
  key: string,
  body: Buffer | Blob | Uint8Array,
  contentType: string,
): Promise<UploadResult> {
  // E2E: avoid live third-party storage (see isR2Bypassed)
  if (isR2Bypassed()) {
    return { r2Key: key, r2Bucket: "test-bucket" };
  }

  const client = getR2Client();

  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return {
    r2Key: key,
    r2Bucket: R2_BUCKET,
  };
}

/**
 * Generate a presigned URL for secure file download
 */
export async function getPresignedDownloadUrl(
  key: string,
  options: PresignedUrlOptions = {},
): Promise<string> {
  const client = getR2Client();
  const { expiresIn = 3600 } = options; // Default 1 hour

  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Generate a presigned URL for secure file upload (direct browser upload)
 */
export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  options: PresignedUrlOptions = {},
): Promise<string> {
  const client = getR2Client();
  const { expiresIn = 3600 } = options;

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Delete a file from R2 storage
 */
export async function deleteFromR2(key: string): Promise<void> {
  if (isR2Bypassed()) return;

  const client = getR2Client();

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      }),
    );
  } catch (err: unknown) {
    // If the file is already gone, that's fine (idempotent deletion)
    const isNotFound =
      (err instanceof Error && err.name === "NoSuchKey") ||
      (typeof err === "object" &&
        err !== null &&
        "$metadata" in err &&
        (err as { $metadata: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);
    if (isNotFound) {
      logger.warn("Key not found during deletion (ignoring)", { key });
      return;
    }
    // Re-throw other errors
    throw err;
  }
}

/**
 * Check if a file exists in R2 storage
 */
export async function existsInR2(key: string): Promise<boolean> {
  if (isR2Bypassed()) return true;

  const client = getR2Client();

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a file from R2 storage as a Buffer
 */
export async function downloadFromR2(key: string): Promise<Buffer> {
  const client = getR2Client();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }),
  );

  if (!response.Body) throw new Error(`Empty response body for key: ${key}`);

  const stream = response.Body as NodeJS.ReadableStream;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks);
}

/**
 * Get file metadata from R2
 */
export async function getR2Metadata(
  key: string,
): Promise<{ contentType?: string; contentLength?: number } | null> {
  const client = getR2Client();

  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      }),
    );
    return {
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    };
  } catch {
    return null;
  }
}
