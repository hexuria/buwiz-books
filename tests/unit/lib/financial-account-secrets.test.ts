import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStatementPassword,
  setStatementPassword,
  clearStatementPassword,
  listOrgStatementPasswords,
} from "../../../src/lib/financial-account-secrets";
import { decryptSecret, isEncrypted } from "../../../src/lib/crypto";

type Row = Record<string, unknown>;
let selectRows: Row[] = [];
let lastInsertValues: Row | null = null;
let lastConflictSet: Row | null = null;
let deleteCalled = false;

const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => selectRows),
      })),
    })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn((values: Row) => {
      lastInsertValues = values;
      return {
        onConflictDoUpdate: vi.fn(async ({ set }: { set: Row }) => {
          lastConflictSet = set;
        }),
      };
    }),
  })),
  delete: vi.fn(() => ({
    where: vi.fn(async () => {
      deleteCalled = true;
    }),
  })),
} as never;

describe("financial-account-secrets", () => {
  beforeEach(() => {
    selectRows = [];
    lastInsertValues = null;
    lastConflictSet = null;
    deleteCalled = false;
    vi.clearAllMocks();
  });

  it("encrypts the password on write", async () => {
    await setStatementPassword(mockDb, "org-1", "acc-1", "hunter2");
    const enc = lastInsertValues!.statementPasswordEnc as string;
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptSecret(enc)).toBe("hunter2");
    expect(isEncrypted(lastConflictSet!.statementPasswordEnc as string)).toBe(true);
  });

  it("decrypts the password on read", async () => {
    const { encryptSecret } = await import("../../../src/lib/crypto");
    selectRows = [{ enc: encryptSecret("s3cret") }];
    expect(await getStatementPassword(mockDb, "acc-1")).toBe("s3cret");
  });

  it("returns null when no password is stored", async () => {
    selectRows = [];
    expect(await getStatementPassword(mockDb, "acc-1")).toBeNull();
  });

  it("clears a stored password", async () => {
    await clearStatementPassword(mockDb, "acc-1");
    expect(deleteCalled).toBe(true);
  });

  it("lists distinct decrypted org passwords", async () => {
    const { encryptSecret } = await import("../../../src/lib/crypto");
    selectRows = [
      { enc: encryptSecret("a") },
      { enc: encryptSecret("b") },
      { enc: encryptSecret("a") }, // duplicate
    ];
    const list = await listOrgStatementPasswords(mockDb, "org-1");
    expect(list.sort()).toEqual(["a", "b"]);
  });
});
