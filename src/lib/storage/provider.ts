/**
 * Storage provider abstraction.
 *
 * The app was hard-wired to Cloudflare R2, which meant white-label "Model C" (all client
 * data in the client's own GCP) could not actually keep uploaded files in-tenant. This seam
 * lets a deployment select its object-storage backend via the STORAGE_PROVIDER env var
 * without touching call sites — they use `storage.*` instead of the R2-specific functions.
 *
 *   STORAGE_PROVIDER=r2   (default) → Cloudflare R2 (current behavior)
 *   STORAGE_PROVIDER=gcs            → Google Cloud Storage (per-client GCP bucket)
 *
 * The GCS provider is a documented placeholder: implement it against @google-cloud/storage
 * when wiring the client-GCP deployment. Everything else in the app already goes through
 * this interface, so only this file changes.
 */
import type { PresignedUrlOptions, UploadResult } from "./types";
import {
  uploadToR2,
  getPresignedDownloadUrl,
  getPresignedUploadUrl,
  deleteFromR2,
  existsInR2,
  downloadFromR2,
  generateR2Key,
  isR2Configured,
} from "./r2-client";

export interface StorageProvider {
  /** Build a namespaced object key for an org + filename. */
  generateKey(orgId: string, filename: string): string;
  upload(key: string, body: Buffer | Blob | Uint8Array, contentType: string): Promise<UploadResult>;
  presignDownload(key: string, options?: PresignedUrlOptions): Promise<string>;
  presignUpload(key: string, contentType: string, options?: PresignedUrlOptions): Promise<string>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  download(key: string): Promise<Buffer>;
  isConfigured(): boolean;
}

const r2Provider: StorageProvider = {
  generateKey: generateR2Key,
  upload: uploadToR2,
  presignDownload: getPresignedDownloadUrl,
  presignUpload: (key, contentType, options) => getPresignedUploadUrl(key, contentType, options),
  delete: deleteFromR2,
  exists: existsInR2,
  download: downloadFromR2,
  isConfigured: isR2Configured,
};

function notImplemented(): never {
  throw new Error(
    "STORAGE_PROVIDER=gcs is selected but the GCS provider is not implemented. " +
      "Implement it in src/lib/storage/provider.ts using @google-cloud/storage before enabling it.",
  );
}

const gcsProvider: StorageProvider = {
  generateKey: generateR2Key, // key scheme is backend-agnostic; reuse it
  upload: notImplemented,
  presignDownload: notImplemented,
  presignUpload: notImplemented,
  delete: notImplemented,
  exists: notImplemented,
  download: notImplemented,
  isConfigured: notImplemented,
};

function selectProvider(): StorageProvider {
  const which = (process.env.STORAGE_PROVIDER ?? "r2").toLowerCase();
  if (which === "gcs") return gcsProvider;
  return r2Provider;
}

/** The configured storage backend. Call sites should use this instead of R2 functions. */
export const storage: StorageProvider = selectProvider();
