/**
 * Types for transaction audit log and change tracking
 */

export interface TransactionChangeDiff {
  old: string | number | boolean | null;
  new: string | number | boolean | null;
}

export interface TransactionLineData {
  [key: string]: string | number | boolean | null | TransactionChangeDiff;
}

export interface TransactionChanges {
  [key: string]: TransactionChangeDiff | string | number | boolean | null | TransactionLineData;
}

export type HeaderDiff = [string, TransactionChangeDiff];
export type LineEntry = [string, TransactionLineData];
export type HeaderSnapshotField = [string, string | number | boolean | null];
