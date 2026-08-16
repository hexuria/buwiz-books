import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocateInvoiceNumber,
  allocateJournalTransactionNumber,
  seedSequenceFromExistingMax,
} from "@/lib/sequence";

const { insertMock, selectMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    insert: insertMock,
    select: selectMock,
  },
}));

vi.mock("@/db/schema/number-sequences", () => ({
  numberSequences: {
    scope: "scope",
    currentValue: "currentValue",
  },
}));

describe("sequence helpers", () => {
  beforeEach(() => {
    insertMock.mockReset();
    selectMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockInsertReturning(currentValue: number) {
    const returning = vi.fn().mockResolvedValue([{ currentValue }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });

    insertMock.mockReturnValue({ values });

    return { values, onConflictDoUpdate, returning };
  }

  it("formats journal transaction numbers from the sequence allocator", async () => {
    mockInsertReturning(12);

    await expect(allocateJournalTransactionNumber("org-1")).resolves.toBe("TXN-000012");
  });

  it("formats invoice numbers from the sequence allocator", async () => {
    mockInsertReturning(7);

    await expect(allocateInvoiceNumber("org-1")).resolves.toBe("INV-0007");
  });

  it("seeds a missing sequence from an existing maximum", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    selectMock.mockReturnValue({ from });

    const onConflictDoUpdate = vi.fn().mockReturnValue({});
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    insertMock.mockReturnValue({ values });

    await seedSequenceFromExistingMax("journal:org-1", 42);

    expect(insertMock).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "journal:org-1",
        currentValue: 42,
      }),
    );
  });

  it("does not overwrite a sequence that is already ahead", async () => {
    const limit = vi.fn().mockResolvedValue([{ currentValue: 100 }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    selectMock.mockReturnValue({ from });

    await seedSequenceFromExistingMax("journal:org-1", 42);

    expect(insertMock).not.toHaveBeenCalled();
  });
});
