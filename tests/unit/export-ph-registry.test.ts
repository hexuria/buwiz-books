import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";

// The registry imports schema tables only (no client construction), but the
// route wiring assertions read source; keep the db module stubbed anyway for
// the schema imports' transitive safety.
vi.mock("@/db", () => ({
  db: {},
  withOrgContext: (_o: string, _u: string, _r: string, fn: (tx: unknown) => unknown) => fn({}),
}));

import {
  EXPORTABLE_ENTITIES,
  ENTITY_LABELS,
  EXPORT_VERSION,
  PH_EXPORTABLE_ENTITIES,
} from "../../src/lib/export-versions";
import { migrateToLatest } from "../../src/lib/export-migrations";
import {
  PH_ALWAYS_STRIP,
  PH_ENTITY_KEYS,
  PH_EXPORT_SPECS,
  PH_GLOBAL_TABLES_NOT_EXPORTED,
  PH_TENANT_TABLE_NAMES,
  phRowSchema,
  type PhEntityKey,
} from "../../src/lib/export-ph";
import { isPhTaxFilingEnabled } from "../../src/lib/tax/product-flag";

const REPO_ROOT = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

/**
 * Minimal wire-format rows that must satisfy `phRowSchema` for every Forms
 * key. Required insert columns only; stripped uuid/user fields omitted.
 */
const PH_SHAPE_FIXTURES: Record<PhEntityKey, Record<string, unknown>> = {
  phOrgTaxProfile: { registeredName: "ROUNDTRIP CORP", tin: "123456789" },
  phOrgTaxBranches: { branchCode: "00000", name: "Head Office" },
  phTaxYearElections: { taxableYear: 2026, regime: "vat" },
  phTaxRegistrations: {
    regimeKind: "vat",
    value: "registered",
    effectiveFrom: "2026-01-01",
  },
  phPartyTaxProfiles: {
    partyName: "Roundtrip Employee",
    tin: "987654321",
    lastName: "EMPLOYEE",
    firstName: "ROUNDTRIP",
  },
  phPreviousEmployer2316: {
    employeeName: "Roundtrip Employee",
    taxableYear: 2026,
    previousEmployerName: "PRIOR CORP",
    taxableCompensation: "100000.00",
    taxWithheld: "5000.00",
    periodsCovered: 6,
    employmentFrom: "2026-01-01",
    employmentTo: "2026-06-30",
  },
  phWithholdingPayments: {
    payeeName: "Roundtrip Payor",
    payeeTin: "111222333",
    payeeRegisteredName: "SUPPLIER CORP",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    atc: "WC160",
    incomePayment: "200000.00",
    taxWithheld: "10000.00",
  },
  phTaxCertificates: {
    payorName: "Roundtrip Payor",
    payorTin: "111222333",
    payorRegisteredName: "SUPPLIER CORP",
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    atc: "WC160",
    incomePayment: "200000.00",
    taxWithheld: "10000.00",
    certificateNumber: "2307-001",
  },
  phPayrollRuns: {
    taxableYear: 2026,
    payrollPeriod: "monthly",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    periodIndex: 1,
    status: "computed",
  },
  phPayrollLines: {
    basicSalary: "50000.00",
    employeeName: "Roundtrip Employee",
    runTaxableYear: 2026,
    runPayrollPeriod: "monthly",
    runPeriodIndex: 1,
  },
  phPayrollYearState: {
    employeeName: "Roundtrip Employee",
    taxableYear: 2026,
  },
  phComputedReturns: {
    formCode: "2550Q",
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    payload: { line15: "1000.00" },
  },
};

function pgTableNames(source: string): string[] {
  return [...source.matchAll(/pgTable\(\s*"([^"]+)"/g)].map((match) => match[1]);
}

function sqlCreateTableNames(source: string): string[] {
  return [
    ...source.matchAll(/CREATE TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?\s*\(/gi),
  ].map((match) => match[1]);
}

/**
 * Program 2 P5 / P4a — the PH tables join the versioned export system, and
 * every tenant key intended for Forms is registered, schema-validated, and
 * classified against global catalogs that must stay out of the file.
 */
describe("PH export registry", () => {
  it("every spec is a registered exportable entity with a label", () => {
    expect(PH_EXPORT_SPECS.length).toBe(PH_TENANT_TABLE_NAMES.length);
    expect(PH_ENTITY_KEYS).toEqual([...PH_EXPORTABLE_ENTITIES]);
    for (const spec of PH_EXPORT_SPECS) {
      expect(EXPORTABLE_ENTITIES, `${spec.key} missing from EXPORTABLE_ENTITIES`).toContain(
        spec.key,
      );
      expect(ENTITY_LABELS[spec.key as keyof typeof ENTITY_LABELS]).toBe(spec.label);
    }
  });

  it("maps each spec onto its tenant Postgres table, in order", () => {
    expect(PH_EXPORT_SPECS.map((spec) => getTableName(spec.table))).toEqual([
      ...PH_TENANT_TABLE_NAMES,
    ]);
  });

  it("classifies every PH schema table as tenant-exported or globally excluded", () => {
    const schemaFiles = [
      "src/db/schema/tax-reference.ts",
      "src/db/schema/tax-stage-remainder.ts",
      "src/db/schema/tax-certificates.ts",
      "src/db/schema/party-tax.ts",
      "src/db/schema/payroll.ts",
    ];
    const classified = new Set<string>([
      ...PH_TENANT_TABLE_NAMES,
      ...PH_GLOBAL_TABLES_NOT_EXPORTED,
    ]);
    const discovered = schemaFiles.flatMap((file) => pgTableNames(read(file)));
    expect(discovered.length).toBeGreaterThan(0);
    const unclassified = discovered.filter((name) => !classified.has(name));
    expect(
      unclassified,
      "new PH table must be added to PH_EXPORT_SPECS or the global exclusion list",
    ).toEqual([]);
    const missing = [...classified].filter((name) => !discovered.includes(name));
    expect(missing, "classified table is gone from the Drizzle schema").toEqual([]);
  });

  it("classifies CREATE TABLE names in tax/payroll drizzle SQL the same way", () => {
    const classified = new Set<string>([
      ...PH_TENANT_TABLE_NAMES,
      ...PH_GLOBAL_TABLES_NOT_EXPORTED,
    ]);
    const sqlFiles = readdirSync(join(REPO_ROOT, "drizzle")).filter(
      (file) => file.endsWith(".sql") && /tax|payroll|party_tax/i.test(file),
    );
    expect(sqlFiles.length).toBeGreaterThan(0);
    const created = sqlFiles.flatMap((file) => sqlCreateTableNames(read(`drizzle/${file}`)));
    const unclassified = created.filter((name) => !classified.has(name));
    expect(unclassified, "SQL-created PH table is neither exported nor marked global").toEqual([]);
  });

  it("does not export global statutory catalogs", () => {
    const exportedTables = new Set(PH_EXPORT_SPECS.map((spec) => getTableName(spec.table)));
    for (const table of PH_GLOBAL_TABLES_NOT_EXPORTED) {
      expect(exportedTables.has(table), `${table} must stay out of the tenant export`).toBe(false);
      expect(EXPORTABLE_ENTITIES as readonly string[]).not.toContain(table);
    }
  });

  it("payroll runs are ordered before the entities that resolve against them", () => {
    const order = EXPORTABLE_ENTITIES as readonly string[];
    const runs = order.indexOf("phPayrollRuns");
    expect(runs).toBeGreaterThan(-1);
    expect(order.indexOf("phPayrollLines")).toBeGreaterThan(runs);
    expect(order.indexOf("phPayrollYearState")).toBeGreaterThan(runs);
    expect(order.indexOf("phPartyTaxProfiles")).toBeGreaterThan(order.indexOf("employees"));
  });

  it("every Forms key has a wire-format schema that accepts a fixture and omits stripped columns", () => {
    expect(Object.keys(PH_SHAPE_FIXTURES).sort()).toEqual([...PH_ENTITY_KEYS].sort());
    for (const spec of PH_EXPORT_SPECS) {
      const schema = phRowSchema(spec);
      const parsed = schema.safeParse(PH_SHAPE_FIXTURES[spec.key]);
      expect(parsed.success, `${spec.key}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(
        true,
      );

      const cols = getTableColumns(spec.table);
      const shape = (schema as { shape?: Record<string, unknown> }).shape ?? {};
      for (const col of [...PH_ALWAYS_STRIP, ...spec.strip]) {
        expect(shape, `${spec.key} still exposes stripped ${col}`).not.toHaveProperty(col);
      }
      for (const col of spec.strip) {
        expect(cols, `${spec.key} strip ${col} is not a table column`).toHaveProperty(col);
      }
      if (spec.partyRef) {
        expect(cols).toHaveProperty(spec.partyRef.column);
        expect(shape).toHaveProperty(spec.partyRef.exportAs);
        expect(shape).not.toHaveProperty(spec.partyRef.column);
      }
      if (spec.runRef) {
        expect(cols).toHaveProperty(spec.runRef.column);
        expect(shape).toHaveProperty("runTaxableYear");
        expect(shape).toHaveProperty("runPayrollPeriod");
        expect(shape).toHaveProperty("runPeriodIndex");
        expect(shape).not.toHaveProperty(spec.runRef.column);
      }
      const displayIsRef = spec.partyRef?.exportAs === spec.display;
      if (!displayIsRef) expect(cols).toHaveProperty(spec.display);
      for (const key of spec.natural) {
        if (spec.partyRef && key === spec.partyRef.exportAs) continue;
        expect(cols, `${spec.key} natural key ${key}`).toHaveProperty(key);
      }
    }
  });

  it("v4 is current, and the migration chain lifts older files to it", () => {
    // P13 bumped v3 → v4 (party_tax_profiles.nationality, passthrough).
    expect(EXPORT_VERSION).toBe(4);
    const v2 = {
      meta: {
        version: 2,
        exportedAt: "2026-01-01T00:00:00.000Z",
        organizationName: "Legacy",
        organizationSlug: "legacy",
        entities: ["vendors"],
      },
      data: { vendors: [{ name: "Old Vendor" }] },
    };
    const migrated = migrateToLatest(v2);
    expect(migrated.meta.version).toBe(4);
    expect((migrated.data as Record<string, unknown>).vendors).toEqual([{ name: "Old Vendor" }]);
  });

  it("a NEWER file refuses loudly instead of half-importing", () => {
    const v99 = {
      meta: {
        version: 99,
        exportedAt: "2030-01-01T00:00:00.000Z",
        organizationName: "Future",
        organizationSlug: "future",
        entities: [],
      },
      data: {},
    };
    expect(() => migrateToLatest(v99)).toThrow(/newer version/i);
  });

  it("the route actually calls the migration engine and the PH handlers for every key", () => {
    const source = read("src/routes/api/-export-import.ts");
    expect(source).toContain('import { migrateToLatest } from "../../lib/export-migrations";');
    expect(source).not.toContain("// import { migrateToLatest }");
    expect(source).toContain("const migrated = migrateToLatest(parsed);");
    expect(source).toContain("await exportPhEntity(db, orgId, phSpec)");
    expect(source).toContain("await importPhEntity(db, orgId, phSpec, rows)");
    for (const key of PH_ENTITY_KEYS) {
      expect(source, `ENTITY_ENUM missing ${key}`).toContain(`"${key}"`);
    }
  });

  it("Settings export/import lists every tenant PH key (unchecked by default on export)", () => {
    const exportPanel = read("src/components/settings/ExportPanel.tsx");
    expect(exportPanel).toContain("...PH_EXPORTABLE_ENTITIES");
    expect(exportPanel).toContain("new Set(CHERRY_PICKABLE)");
    const cherryBlock = exportPanel.slice(
      exportPanel.indexOf("const CHERRY_PICKABLE"),
      exportPanel.indexOf("const PH_ICON"),
    );
    for (const key of PH_ENTITY_KEYS) {
      expect(cherryBlock, `${key} must not default-select on export`).not.toContain(`"${key}"`);
    }
    const importPanel = read("src/components/settings/ImportPanel.tsx");
    expect(importPanel).toContain("...PH_EXPORTABLE_ENTITIES.map");
  });

  it("does not enable BUWIZ_PH_TAX_FILING by default", () => {
    expect(isPhTaxFilingEnabled({})).toBe(false);
    const example = read(".env.example");
    expect(example).toMatch(/# BUWIZ_PH_TAX_FILING=1/);
    expect(example).not.toMatch(/^BUWIZ_PH_TAX_FILING=/m);
    const testEnv = read(".env.test");
    expect(testEnv).not.toMatch(/^BUWIZ_PH_TAX_FILING=/m);
    const testExample = read(".env.test.example");
    expect(testExample).not.toMatch(/^BUWIZ_PH_TAX_FILING=/m);
  });

  it("documents the Forms handoff, excluded catalogs, and peel non-goals", () => {
    const runbook = read("docs/tax/forms-handoff.md");
    expect(runbook).toContain("Buwiz Forms");
    expect(runbook).toContain("BUWIZ_PH_TAX_FILING");
    expect(runbook).toContain("No schema drop");
    for (const key of PH_ENTITY_KEYS) {
      expect(runbook, `runbook missing ${key}`).toContain(`\`${key}\``);
    }
    for (const table of PH_GLOBAL_TABLES_NOT_EXPORTED) {
      expect(runbook, `runbook missing excluded ${table}`).toContain(`\`${table}\``);
    }
    expect(runbook).toContain("journalHeaderId");
    expect(runbook).toContain("buwiz-forms");
  });
});
