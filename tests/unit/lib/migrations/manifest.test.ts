import { describe, expect, it } from "vitest";
import {
  migrationManifest,
  validateMigrationManifest,
  type MigrationManifestEntry,
} from "@/lib/migrations/manifest";

describe("manual migration manifest", () => {
  it("registers every handwritten migration numerically and declares phase-first execution", () => {
    expect(migrationManifest.map((entry) => entry.id)).toEqual(
      Array.from({ length: 19 }, (_, index) => String(index + 18).padStart(4, "0")),
    );
    expect(validateMigrationManifest(migrationManifest)).toEqual({ ok: true });
    const preSchema = migrationManifest
      .filter((entry) => entry.phase === "pre_schema")
      .map((entry) => entry.id);
    const postSchema = migrationManifest
      .filter((entry) => entry.phase === "post_schema")
      .map((entry) => entry.id);
    expect(preSchema).toEqual(["0026", "0027"]);
    expect(postSchema).toEqual([
      "0018",
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
    ]);
    expect(
      migrationManifest
        .filter((entry) => entry.execution === "strip_outer_transaction")
        .map((entry) => entry.id),
    ).toEqual(["0018", "0025"]);
  });

  it("keeps the immutable SHA-256 checksum beside every file", () => {
    expect(migrationManifest[0]).toMatchObject({
      file: "0018_integrity_and_server_secrets.sql",
      checksum: "94f1ca98472feef887b42a519992d86a390194008db52ed216dd663ce4edb566",
    });
    expect(migrationManifest.at(-1)).toMatchObject({
      file: "0036_enterprise_checkout.sql",
      checksum: "d3f86a77e1dc56129f18b1cdbe8d44c27e597432c6d0b2fb088661d8768f836f",
    });
  });

  it.each([
    ["duplicate id", [migrationManifest[0], migrationManifest[0]], /duplicate migration id/i],
    ["out-of-order id", [migrationManifest[1], migrationManifest[0]], /out of order/i],
    [
      "mismatched filename",
      [{ ...migrationManifest[0], file: "9999_wrong.sql" }],
      /mismatched filename/i,
    ],
    [
      "duplicate file",
      [migrationManifest[0], { ...migrationManifest[1], file: migrationManifest[0].file }],
      /mismatched filename|duplicate migration file/i,
    ],
    [
      "malformed checksum",
      [{ ...migrationManifest[0], checksum: "not-a-checksum" }],
      /invalid sha-256 checksum/i,
    ],
    [
      "unknown history alias",
      [{ ...migrationManifest[0], historyAliases: ["legacy-0018"] }],
      /invalid history alias/i,
    ],
    [
      "missing canonical history alias",
      [{ ...migrationManifest[0], historyAliases: [] }],
      /invalid history alias/i,
    ],
    [
      "unsafe filename",
      [{ ...migrationManifest[0], file: "0018_../unsafe.sql" }],
      /mismatched filename/i,
    ],
    ["invalid phase", [{ ...migrationManifest[0], phase: "during_schema" }], /invalid phase/i],
    [
      "invalid execution mode",
      [{ ...migrationManifest[0], execution: "nested_transaction" }],
      /invalid execution mode/i,
    ],
  ] as const)("rejects %s", (_name, entries, expected) => {
    const result = validateMigrationManifest(entries as readonly MigrationManifestEntry[]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(expected);
  });
});
