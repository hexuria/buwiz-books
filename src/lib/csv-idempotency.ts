import { createHash } from "node:crypto";

export function hashCsvFileContent(sourceContent: string): string {
  return createHash("sha256").update(sourceContent).digest("hex");
}

export function bankCsvSourceId(fileHash: string, rowOrdinal: number): string {
  return `csv-bank:${fileHash}:row:${rowOrdinal}`;
}

export function journalCsvSourceId(fileHash: string, groupOrdinal: number): string {
  return `csv-journal:${fileHash}:group:${groupOrdinal}`;
}
