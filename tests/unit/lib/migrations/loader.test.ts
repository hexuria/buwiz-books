import { describe, expect, it, vi } from "vitest";
import { checksumMigration } from "@/lib/migrations/engine";
import { createMigrationEngine } from "@/lib/migrations/engine";
import { loadPreparedMigrations, prepareExecutionSql } from "@/lib/migrations/loader";
import type { MigrationId, MigrationManifestEntry } from "@/lib/migrations/manifest";

function entry<const Id extends MigrationId>(
  id: Id,
  sql: string,
  execution: MigrationManifestEntry["execution"] = "plain",
): MigrationManifestEntry<Id> {
  return {
    id,
    file: `${id}_test.sql`,
    historyAliases: [id],
    phase: "post_schema",
    checksum: checksumMigration(sql),
    execution,
  };
}

describe("migration loader", () => {
  it("loads and validates the complete manifest before returning prepared SQL", async () => {
    const files = new Map([
      ["0018_test.sql", "SELECT 18;\n"],
      ["0019_test.sql", "SELECT 19;\n"],
    ]);
    const manifest = [
      entry("0018", files.get("0018_test.sql")!),
      entry("0019", files.get("0019_test.sql")!),
    ];

    await expect(
      loadPreparedMigrations({
        manifest,
        readFile: vi.fn(async (file) => files.get(file.pathname.split("/").at(-1)!)!),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "0018",
        sql: "SELECT 18;\n",
        executionSql: "SELECT 18;\n",
      }),
      expect.objectContaining({
        id: "0019",
        sql: "SELECT 19;\n",
        executionSql: "SELECT 19;\n",
      }),
    ]);
  });

  it("validates the manifest before reading any migration file", async () => {
    const readFile = vi.fn(async () => "SELECT 1;\n");
    await expect(
      loadPreparedMigrations({
        manifest: [entry("0019", "SELECT 1;\n"), entry("0018", "SELECT 1;\n")],
        readFile,
      }),
    ).rejects.toThrow(/out of order/i);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects a missing file or one-byte checksum drift", async () => {
    const sql = "SELECT 18;\n";
    const manifest = [entry("0018", sql)];
    await expect(
      loadPreparedMigrations({
        manifest,
        readFile: vi.fn(async () => Promise.reject(new Error("missing"))),
      }),
    ).rejects.toThrow(/unable to read managed migration 0018/i);
    await expect(
      loadPreparedMigrations({
        manifest,
        readFile: vi.fn(async () => `${sql} `),
      }),
    ).rejects.toThrow(/checksum drift/i);
  });

  it("strips only the declared outer transaction while checksumming original bytes", async () => {
    const sql = "-- retained comment\nBEGIN;\nSELECT 18;\nCOMMIT;\n";
    const manifest = [entry("0018", sql, "strip_outer_transaction")];
    const [prepared] = await loadPreparedMigrations({
      manifest,
      readFile: vi.fn(async () => sql),
    });

    expect(prepared.sql).toBe(sql);
    expect(prepared.checksum).toBe(checksumMigration(sql));
    expect(prepared.executionSql).toContain("-- retained comment");
    expect(prepared.executionSql).toContain("SELECT 18;");
    expect(prepared.executionSql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/im);
  });

  it("rejects undeclared or malformed transaction envelopes", () => {
    expect(() =>
      prepareExecutionSql(
        entry("0018", "BEGIN;\nSELECT 1;\nCOMMIT;\n"),
        "BEGIN;\nSELECT 1;\nCOMMIT;\n",
      ),
    ).toThrow(/not declared strip_outer_transaction/i);
    expect(() =>
      prepareExecutionSql(
        entry("0018", "BEGIN;\nSELECT 1;\n", "strip_outer_transaction"),
        "BEGIN;\nSELECT 1;\n",
      ),
    ).toThrow(/exactly one standalone begin/i);
    expect(() =>
      prepareExecutionSql(
        entry("0018", "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\n", "strip_outer_transaction"),
        "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\n",
      ),
    ).toThrow(/outer transaction envelope/i);
    expect(() =>
      prepareExecutionSql(
        entry("0018", "COMMIT;\nSELECT 1;\nBEGIN;\n", "strip_outer_transaction"),
        "COMMIT;\nSELECT 1;\nBEGIN;\n",
      ),
    ).toThrow(/exactly one standalone begin/i);
    expect(() =>
      prepareExecutionSql(
        entry("0018", "BEGIN;\nBEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;\n", "strip_outer_transaction"),
        "BEGIN;\nBEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;\n",
      ),
    ).toThrow(/exactly one standalone begin/i);
  });

  it("detects top-level transaction control without confusing SQL bodies or values", () => {
    const bodySql = [
      "CREATE FUNCTION example() RETURNS void LANGUAGE plpgsql AS $$",
      "BEGIN",
      "  RAISE NOTICE 'COMMIT;';",
      "END;",
      "$$;",
      "SELECT 'BEGIN;' AS value;",
      "-- COMMIT;",
      "/* ROLLBACK; */",
      "SELECT 1;",
      "",
    ].join("\n");
    expect(prepareExecutionSql(entry("0018", bodySql), bodySql)).toBe(bodySql);

    const escapeStringSql = String.raw`SELECT E'quote\\\'; BEGIN; still data';
SELECT e'backslash\\\\ and COMMIT;';
`;
    expect(prepareExecutionSql(entry("0018", escapeStringSql), escapeStringSql)).toBe(
      escapeStringSql,
    );

    for (const sql of [
      "START TRANSACTION;\nSELECT 1;\nCOMMIT;\n",
      "BEGIN WORK;\nSELECT 1;\nROLLBACK;\n",
    ]) {
      expect(() => prepareExecutionSql(entry("0018", sql), sql)).toThrow(/transaction statement/i);
    }
  });

  it("requires complete, terminated SQL", () => {
    expect(() =>
      prepareExecutionSql(entry("0018", "SELECT 'unterminated;"), "SELECT 'unterminated;"),
    ).toThrow(/unterminated/i);
    expect(() => prepareExecutionSql(entry("0018", "SELECT 1"), "SELECT 1")).toThrow(
      /statement terminator/i,
    );
  });

  it("loads the repository manifest with all immutable checksums intact", async () => {
    const prepared = await loadPreparedMigrations();
    expect(prepared).toHaveLength(19);
    expect(prepared.map((item) => item.id)).toEqual(
      Array.from({ length: 19 }, (_, index) => String(index + 18).padStart(4, "0")),
    );
  });

  it("returns frozen prepared migrations detached from mutable manifest aliases", async () => {
    const sql = "SELECT 18;\n";
    const manifestEntry = entry("0018", sql);
    const aliases = manifestEntry.historyAliases as string[];
    const prepared = await loadPreparedMigrations({
      manifest: [manifestEntry],
      readFile: vi.fn(async () => sql),
    });

    aliases[0] = "tampered";
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared[0])).toBe(true);
    expect(Object.isFrozen(prepared[0].historyAliases)).toBe(true);
    expect(prepared[0].historyAliases).toEqual(["0018"]);
  });

  it("feeds validated loader output directly into the engine seam", async () => {
    const sql = "SELECT 18;\n";
    const [prepared] = await loadPreparedMigrations({
      manifest: [entry("0018", sql)],
      readFile: vi.fn(async () => sql),
    });
    const adapter = {
      async withGlobalLock<T>(operation: () => Promise<T>) {
        return operation();
      },
      async readHistory() {
        return [];
      },
      async verifyHistoricalState() {
        return { state: "absent", evidence: [] } as const;
      },
      async transaction() {
        throw new Error("not used by status");
      },
    };

    await expect(createMigrationEngine([prepared], adapter).status()).resolves.toMatchObject({
      outcomes: [{ id: "0018", state: "pending" }],
    });
  });
});
