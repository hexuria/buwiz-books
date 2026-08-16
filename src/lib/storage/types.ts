/**
 * Storage Type Definitions
 * Types for cloud storage operations (R2/S3)
 */

export interface UploadResult {
  /** Object key in the storage bucket */
  r2Key: string;
  /** Bucket name */
  r2Bucket: string;
  /** Public URL if the file is made public */
  publicUrl?: string;
}

export interface DocumentUploadInput {
  /** File buffer or Blob */
  file: Buffer | Blob;
  /** Original filename */
  filename: string;
  /** MIME type */
  contentType: string;
  /** Organization ID for RLS */
  organizationId: string;
  /** User who uploaded the file */
  uploadedById: string;
  /** Document classification */
  documentType?: "statement" | "bill" | "invoice" | "receipt" | "contract" | "tax_form" | "other";
  /** Display title (defaults to filename) */
  displayTitle?: string;
}

export interface PresignedUrlOptions {
  /** URL expiration in seconds (default: 3600 = 1 hour) */
  expiresIn?: number;
}

export type LinkableEntityType =
  | "journal_header"
  | "invoice"
  | "bill"
  | "party"
  | "reconciliation"
  | "financial_account";

export interface AttachDocumentInput {
  /** Document ID to attach */
  documentId: string;
  /** Entity type to attach to */
  linkableType: LinkableEntityType;
  /** Entity ID to attach to */
  linkableId: string;
  /** Organization ID for RLS */
  organizationId: string;
}
