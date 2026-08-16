export * from "./types";
export { storage, type StorageProvider } from "./provider";

// Compatibility facade. Existing call sites keep their established names while every
// operation is dispatched through the configured provider.
import { storage } from "./provider";
import type { PresignedUrlOptions } from "./types";

export const generateR2Key = (orgId: string, filename: string) =>
  storage.generateKey(orgId, filename);
export const uploadToR2 = (key: string, body: Buffer | Blob | Uint8Array, contentType: string) =>
  storage.upload(key, body, contentType);
export const getPresignedDownloadUrl = (key: string, options?: PresignedUrlOptions) =>
  storage.presignDownload(key, options);
export const getPresignedUploadUrl = (
  key: string,
  contentType: string,
  options?: PresignedUrlOptions,
) => storage.presignUpload(key, contentType, options);
export const deleteFromR2 = (key: string) => storage.delete(key);
export const existsInR2 = (key: string) => storage.exists(key);
export const downloadFromR2 = (key: string) => storage.download(key);
export const isR2Configured = () => storage.isConfigured();
// R2-only diagnostic compatibility; application code must not use this to access storage.
export { R2_BUCKET } from "./r2-client";
