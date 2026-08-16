import { createHash } from "node:crypto";

interface BillOcrCategoryContext {
  accountNumber: string;
  name: string;
  type: string;
  subtype?: string;
  parentName?: string;
}

export function billOcrContextHash(categories: readonly BillOcrCategoryContext[]): string {
  const stableCategories = [...categories].sort((left, right) =>
    `${left.accountNumber}:${left.name}`.localeCompare(`${right.accountNumber}:${right.name}`),
  );
  return createHash("sha256").update(JSON.stringify(stableCategories)).digest("hex");
}
