import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATASET_V1, DE_MINIMIS_CEILINGS, WITHHOLDING_BRACKETS } from "@/lib/tax/reference-catalog";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

/**
 * Guards two bug classes that this repo has already been bitten by once each.
 *
 * 1. A SEEDING STEP IS ONLY AS GOOD AS THE PATHS THAT CALL IT. The review-rule
 *    catalog rendered empty in every environment for months because its INSERT
 *    lived in a migration drizzle-kit never runs, invoked by a script the
 *    deploy pipeline never calls. Nothing in a type system notices when a
 *    build path quietly stops calling a seeder, so the wiring is asserted
 *    directly against the config files.
 *
 * 2. `drizzle-kit push` HANGS A NON-TTY DEPLOY on brand-new tables. With
 *    unmanaged tables present (app_manual_migrations), push prompts
 *    "created or renamed?" — deploy.yml documents this verbatim for the AI
 *    tables. Locally db:fresh drops the schema first, so the failure appears
 *    ONLY in production. The ordering assertions below are the only thing
 *    standing between a reordered workflow and a hung deploy.
 *    See docs/tax/IMPLEMENTATION-PLAN.md blocker B2.
 */
/**
 * Every ADD CONSTRAINT must sit behind a guard, and the guard STYLE differs by
 * constraint kind — for a reason worth stating, because getting it wrong ships
 * duplicates silently.
 *
 * CHECK constraints are guarded BY NAME. Drizzle cannot express them at all, so
 * this migration is their only author and the name is unique to it.
 *
 * FOREIGN KEYS are guarded BY COLUMN. The Drizzle schema mirror declares the
 * same relationships via `.references()`, so `drizzle-kit push` creates its own
 * copy under its own generated name. A name-based guard cannot see it, adds a
 * second constraint on the same column, and the table ends up with two
 * identical FKs — which is exactly what happened before this was fixed.
 */
function assertEveryConstraintGuarded(migration: string): void {
  const adds = [...migration.matchAll(/ADD CONSTRAINT\s+(\w+)\s+(FOREIGN KEY|CHECK)/g)];
  const checkNames = adds.filter((m) => m[2] === "CHECK").map((m) => m[1]);
  const fkCount = adds.filter((m) => m[2] === "FOREIGN KEY").length;

  const guardedByName = [...migration.matchAll(/conname = '(\w+)'/g)].map((m) => m[1]);
  const guardedByColumn = [...migration.matchAll(/c\.contype = 'f' AND c\.conrelid/g)].length;

  expect(adds.length, "migration declares no constraints").toBeGreaterThan(0);
  expect([...checkNames].sort()).toEqual([...guardedByName].sort());
  expect(guardedByColumn, "every foreign key needs a column-based guard").toBe(fkCount);
}

describe("tax reference catalog wiring", () => {
  const FOUNDATION = "scripts/apply-tax-foundation.ts";
  const SEEDER = "scripts/seed-tax-reference.ts";
  const CATALOG = "src/lib/tax/reference-catalog.ts";
  const MIGRATION = "drizzle/0037_tax_reference_core.sql";
  const PAYROLL_MIGRATION = "drizzle/0038_payroll_compliance.sql";
  const CONTRIBUTION_MIGRATION = "drizzle/0039_payroll_contribution_check.sql";
  const PARTY_TAX_MIGRATION = "drizzle/0040_party_tax_profiles.sql";

  describe("package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    it("exposes the foundation, the seeder, and a read-only status entry point", () => {
      expect(pkg.scripts["db:tax:foundation"]).toContain(FOUNDATION);
      expect(pkg.scripts["db:seed:tax-reference"]).toContain(SEEDER);
      expect(pkg.scripts["db:tax-reference:status"]).toContain(SEEDER);
      // Read-only must stay read-only; it is the command reached for against production.
      expect(pkg.scripts["db:tax-reference:status"]).toContain("--status");
      expect(pkg.scripts["db:seed:tax-reference"]).not.toContain("--status");
    });

    it.each(["db:fresh", "db:test:fresh"])(
      "%s installs the constraints and seeds the catalog",
      (script) => {
        expect(pkg.scripts[script]).toContain("db:tax:foundation");
        expect(pkg.scripts[script]).toContain("db:seed:tax-reference");
      },
    );

    it.each([
      ["db:fresh", "db:migrate"],
      ["db:test:fresh", "db:migrate"],
    ])("%s runs the foundation AFTER %s, never before", (script, migrateStep) => {
      // Current main applies schema through the managed lifecycle, then the
      // convergent tax foundation restores CHECK constraints push cannot express.
      const value = pkg.scripts[script];
      expect(value.indexOf(migrateStep)).toBeLessThan(value.indexOf("db:tax:foundation"));
      expect(value.indexOf("db:enterprise:test-sql")).toBeGreaterThan(value.indexOf(migrateStep));
      expect(value.indexOf("db:enterprise:test-sql")).toBeLessThan(
        value.indexOf("db:tax:foundation"),
      );
    });

    it.each(["db:fresh", "db:test:fresh"])("%s seeds only after the tables exist", (script) => {
      const value = pkg.scripts[script];
      expect(value.indexOf("db:tax:foundation")).toBeLessThan(
        value.indexOf("db:seed:tax-reference"),
      );
    });
  });

  describe("application CI", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const PUSH_CMD = "bun x drizzle-kit push --force";
    const integrationJob = workflow.slice(workflow.indexOf("\n  integration-tests:"));

    it("applies the foundation and seeds the catalog on the CI test database", () => {
      // Current main has no in-repo deploy job. The integration job is the
      // path that builds a disposable database, so that is the wiring that
      // must not go silent.
      expect(integrationJob).toContain("db:tax:foundation");
      expect(integrationJob).toContain("db:seed:tax-reference");
    });

    it("runs the foundation AFTER the test-job push, so CHECK constraints exist", () => {
      const push = integrationJob.indexOf(PUSH_CMD);
      const foundation = integrationJob.indexOf("db:tax:foundation");
      const seed = integrationJob.indexOf("db:seed:tax-reference");
      const rls = integrationJob.indexOf("bun run db:rls");
      expect(push).toBeGreaterThan(-1);
      expect(foundation).toBeGreaterThan(push);
      expect(seed).toBeGreaterThan(foundation);
      expect(rls).toBeGreaterThan(seed);
    });
  });

  describe("Makefile", () => {
    const makefile = read("Makefile");

    it("does not expose production tax foundation through migrate", () => {
      // Production mutation is disabled in this application repository.
      expect(makefile).toMatch(
        /^migrate:\n\t@echo .*disabled in this application repository.*\n\t@exit 1$/m,
      );
      expect(makefile).not.toContain(FOUNDATION);
      expect(makefile).not.toContain(SEEDER);
    });
  });

  describe("Dockerfile", () => {
    const dockerfile = read("Dockerfile");

    it("ships the foundation, the seeder, and the module the seeder reads", () => {
      expect(dockerfile).toContain(FOUNDATION);
      expect(dockerfile).toContain(SEEDER);
      expect(dockerfile).toContain(CATALOG);
    });

    it("ships the drizzle directory the foundation reads its SQL from", () => {
      expect(dockerfile).toContain("/app/drizzle ./drizzle");
    });
  });

  describe("RLS", () => {
    const policies = read("drizzle/rls_policies.sql");

    it.each(["org_tax_profiles", "org_tax_branches"])("isolates %s by organization", (table) => {
      // rls_policies.sql is hand-maintained — nothing derives it from the
      // Drizzle schema, so a new org-scoped table silently gets no policy.
      expect(policies).toContain(`org_isolation_${table}`);
      expect(policies).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    });

    it.each(["tax_reference_datasets", "tax_withholding_tables", "tax_de_minimis_ceilings"])(
      "leaves the global catalog table %s without a policy, deliberately",
      (table) => {
        // Statutory rates are not tenant data — the same treatment
        // review_rule_definitions gets. A per-org copy of a national rate is
        // the drift bug blocker B11 describes.
        expect(policies).not.toContain(`org_isolation_${table}`);
      },
    );
  });

  describe("the payroll migration (0038)", () => {
    const migration = read(PAYROLL_MIGRATION);

    it("applies 0037 after the tables it references", () => {
      const runner = read(FOUNDATION);
      expect(runner.indexOf("0040_party_tax_profiles.sql")).toBeGreaterThan(
        runner.indexOf("0039_payroll_contribution_check.sql"),
      );
    });

    it("0037 is convergent and gives party_tax_profiles an RLS policy", () => {
      const migration = read(PARTY_TAX_MIGRATION);
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS party_tax_profiles");
      assertEveryConstraintGuarded(migration);
      // The table holds TINs, birth dates and employment history. rls_policies
      // is hand-maintained and nothing derives it from the schema, so a new
      // table silently gets no policy at all (blocker B5).
      expect(read("drizzle/rls_policies.sql")).toContain("org_isolation_party_tax_profiles");
    });

    it("0037 constrains the TIN to nine digits with no separators", () => {
      // A formatted TIN in a nine-character .DAT field shifts every field
      // after it — wrong amounts against wrong payees.
      expect(read(PARTY_TAX_MIGRATION)).toContain("party_tax_profiles_tin_format");
    });

    it("applies 0036 last, after the tables it alters exist", () => {
      const runner = read(FOUNDATION);
      expect(runner.indexOf("0039_payroll_contribution_check.sql")).toBeGreaterThan(
        runner.indexOf("0038_payroll_compliance.sql"),
      );
    });

    it("0036 adds columns idempotently and guards its constraints", () => {
      const migration = read(CONTRIBUTION_MIGRATION);
      // Additive and convergent: it runs both before and after push like its
      // siblings, and push drops CHECK constraints it cannot express.
      expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
      assertEveryConstraintGuarded(migration);
    });

    it("0036 refuses a checked line with no expectation recorded", () => {
      // A line marked checked but carrying no expected figures would read as a
      // clean comparison that never happened.
      expect(read(CONTRIBUTION_MIGRATION)).toContain("payroll_lines_contribution_check_complete");
    });

    it("is applied by the same runner, after the reference core", () => {
      // One runner for both keeps the pre-push ordering (blocker B2) true for
      // payroll too, without adding a fourth bespoke migration path.
      const runner = read(FOUNDATION);
      const first = runner.indexOf("0037_tax_reference_core.sql");
      const second = runner.indexOf("0038_payroll_compliance.sql");
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
    });

    it("is convergent, like 0034", () => {
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
      assertEveryConstraintGuarded(migration);
    });

    it("guards the parties foreign keys on the table existing", () => {
      // This file runs BEFORE `drizzle-kit push`, and push is what creates
      // `parties`. Unguarded, a first deploy to an empty database dies on
      // "relation parties does not exist"; guarded, the constraints attach on
      // the second call every build path already makes.
      expect(migration).toMatch(/table_name = 'parties'/);
      expect(migration).toMatch(/IF parties_exists THEN/);
    });

    it("creates every table the Drizzle mirror declares", () => {
      for (const table of [
        "payroll_runs",
        "payroll_lines",
        "payroll_employee_year_state",
        "payroll_previous_employer_2316",
      ]) {
        expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      }
    });

    it("gives every payroll table an RLS policy", () => {
      // Payroll holds employee compensation. rls_policies.sql is hand-
      // maintained and nothing derives it from the schema, so a new table
      // silently gets no policy at all (blocker B5).
      const policies = read("drizzle/rls_policies.sql");
      for (const table of [
        "payroll_runs",
        "payroll_lines",
        "payroll_employee_year_state",
        "payroll_previous_employer_2316",
      ]) {
        expect(policies, table).toContain(`org_isolation_${table}`);
      }
    });

    it("refuses to delete an employee who has payroll lines", () => {
      // A filed return must not lose the employee behind it. NIRC Sec. 235
      // requires ten years of retention, so this FK is RESTRICT while the
      // others cascade.
      expect(migration).toMatch(/payroll_lines_employee_fk[\s\S]*?ON DELETE RESTRICT/);
    });

    it("requires a cumulative-average line to record its divisor", () => {
      // The divisor is the value most likely to be questioned and the one that
      // silently broke withholding once already (blocker B4). A filed figure
      // that cannot be re-explained is not defensible.
      expect(migration).toContain("payroll_lines_divisor_recorded");
    });
  });

  describe("the migration itself", () => {
    const migration = read(MIGRATION);

    it("is convergent: bare CREATE TABLE plus separately guarded constraints", () => {
      // CREATE TABLE IF NOT EXISTS silently skips inline constraints when the
      // table already exists — which it does on every path where push ran
      // first. Constraints must therefore be added in guarded ALTER blocks.
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
      expect(migration).toContain("SELECT 1 FROM pg_constraint WHERE conname =");
      expect(migration).toContain("ADD CONSTRAINT");
    });

    it("declares every constraint it guards, and guards every one it declares", () => {
      // An unguarded ADD CONSTRAINT throws on the second run and breaks every
      // subsequent deploy; a guard with no matching ADD is dead code.
      assertEveryConstraintGuarded(migration);
    });

    it("creates the tables the Drizzle mirror declares", () => {
      for (const table of [
        "tax_reference_datasets",
        "tax_withholding_tables",
        "tax_de_minimis_ceilings",
        "org_tax_profiles",
        "org_tax_branches",
      ]) {
        expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      }
    });
  });

  describe("the catalog constant", () => {
    const catalog = read(CATALOG);

    it("never updates an existing row", () => {
      // A rate is behaviour-bearing data. A DO UPDATE would let an edit to a
      // TypeScript constant retune withholding for every tenant at deploy time
      // with no version bump and no audit row.
      expect(catalog).toContain("onConflictDoNothing");
      expect(catalog).not.toContain("onConflictDoUpdate");
    });

    it("ships BOTH withholding annex generations", () => {
      // RR 11-2018's own Illustrations 6-15 — the golden vectors — compute
      // under Annex D. A catalog carrying only Annex E red-builds the vector
      // suite, and the cheapest way to make it green is to corrupt the live
      // 2026 constants. See blocker B3.
      const annexes = new Set(WITHHOLDING_BRACKETS.map((b) => b.annex));
      expect([...annexes].sort()).toEqual(["D", "E"]);
    });

    it("covers all five payroll periods in both annexes", () => {
      const periods = ["daily", "weekly", "semi_monthly", "monthly", "annual"] as const;
      for (const annex of ["D", "E"] as const) {
        for (const period of periods) {
          const rows = WITHHOLDING_BRACKETS.filter(
            (b) => b.annex === annex && b.payrollPeriod === period,
          );
          expect(rows.length, `${annex}/${period}`).toBe(6);
        }
      }
    });

    it("orders brackets by ascending floor with a zero-rate first row", () => {
      const groups = new Map<string, typeof WITHHOLDING_BRACKETS>();
      for (const row of WITHHOLDING_BRACKETS) {
        const key = `${row.annex}/${row.payrollPeriod}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const [key, rows] of groups) {
        const sorted = [...rows].sort((a, b) => a.bracketIndex - b.bracketIndex);
        // The 0% bracket is first and prescribes no tax — including for daily,
        // where the BIR calculator has a genuine bug returning the full
        // compensation as tax below P685. We do not replicate it.
        expect(sorted[0].rateBps, `${key} first bracket rate`).toBe(0);
        expect(Number(sorted[0].prescribedTax), `${key} first bracket tax`).toBe(0);
        for (let i = 1; i < sorted.length; i++) {
          expect(
            Number(sorted[i].floorAmount),
            `${key} bracket ${i} floor ascends`,
          ).toBeGreaterThan(Number(sorted[i - 1].floorAmount));
          expect(sorted[i].rateBps, `${key} bracket ${i} rate ascends`).toBeGreaterThan(
            sorted[i - 1].rateBps,
          );
        }
      }
    });

    it("gives the two annex generations non-overlapping effective ranges", () => {
      const d = WITHHOLDING_BRACKETS.filter((b) => b.annex === "D");
      const e = WITHHOLDING_BRACKETS.filter((b) => b.annex === "E");
      expect(new Set(d.map((r) => r.effectiveTo))).toEqual(new Set(["2022-12-31"]));
      expect(new Set(e.map((r) => r.effectiveFrom))).toEqual(new Set(["2023-01-01"]));
      // Annex E is current, so it must be open-ended.
      expect(new Set(e.map((r) => r.effectiveTo))).toEqual(new Set([null]));
    });

    it("ships eleven de minimis benefits across three generations", () => {
      const types = new Set(DE_MINIMIS_CEILINGS.map((c) => c.benefitType));
      expect(types.size).toBe(11);
      expect(DE_MINIMIS_CEILINGS.length).toBe(33);
    });

    it("pairs uncapped ceilings with a null amount, and capped ones with a value", () => {
      // Mirrors the DB CHECK. An uncapped row carrying an amount, or a capped
      // row missing one, would silently tax an exempt benefit.
      for (const row of DE_MINIMIS_CEILINGS) {
        if (row.limitKind === "uncapped") {
          expect(row.limitAmount, row.benefitType).toBeNull();
        } else {
          expect(row.limitAmount, row.benefitType).not.toBeNull();
        }
      }
    });

    it("carries the RR 4-2025 permitted-form change that an amount-only table cannot express", () => {
      // RR 4-2025 added cash and gift certificates as permitted forms of an
      // employee achievement award while leaving the amount at P10,000 — so
      // the 2025 row differs from the 2018 row in permittedForms ALONE.
      const awards = DE_MINIMIS_CEILINGS.filter(
        (c) => c.benefitType === "employee_achievement_award",
      ).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      expect(awards).toHaveLength(3);
      expect(awards[0].permittedForms).toEqual(["tangible_personal_property"]);
      expect(awards[1].permittedForms).toContain("cash");
      expect(awards[1].permittedForms).toContain("gift_certificate");
      expect(awards[0].limitAmount).toBe(awards[1].limitAmount);
    });

    it("does not claim the annual rows come from an annex", () => {
      // Neither Annex D nor Annex E contains an annual table — both cover
      // exactly four payroll periods. The annual figures are the NIRC
      // Sec. 24(A)(2) schedule from the RR body, used only for year-end and
      // termination annualization. Correct values, and previously a false
      // citation on them.
      const annual = WITHHOLDING_BRACKETS.filter((b) => b.payrollPeriod === "annual");
      expect(annual).toHaveLength(12);
      for (const row of annual) {
        expect(row.citation).toContain("Sec. 24(A)(2)");
        expect(row.citation).not.toMatch(/RR 11-2018 Annex [DE] \(TRAIN/);
      }
    });

    it("keeps the annex citation on the four sub-annual periods", () => {
      const subAnnual = WITHHOLDING_BRACKETS.filter((b) => b.payrollPeriod !== "annual");
      expect(subAnnual).toHaveLength(48);
      for (const row of subAnnual) {
        expect(row.citation).toContain(`Annex ${row.annex}`);
      }
    });

    it("records that the Annex E top daily cell is malformed in the source PDF", () => {
      // The official PDF prints it as "P 6,034.00.30" — a number with two
      // decimal points. 6,034.30 is what the annex's own bracket-chain
      // construction yields, but the reconstruction must stay visible so nobody
      // later "corrects" it toward the exact-division reading of 6,034.25.
      const row = WITHHOLDING_BRACKETS.find(
        (b) => b.annex === "E" && b.payrollPeriod === "daily" && b.bracketIndex === 5,
      )!;
      expect(row.prescribedTax).toBe("6034.30");
      expect(row.citation).toContain("malformed");
    });

    it("states its provenance per data class, not as one flag", () => {
      // The catalog is verified IN PART: the withholding brackets were checked
      // cell-for-cell against the primary annex PDFs, while the de minimis rows
      // rest on regulations nobody has read yet. A single per-dataset boolean
      // cannot say that, so the sourceNote carries the distinction and
      // last_verified_at stays NULL until the weaker half catches up.
      // Amounts on both halves are now primary-verified; what is not is the two
      // de minimis GENERATION BOUNDARIES, since neither 2025 regulation states
      // a publication date. A wrong boundary silently applies the wrong ceiling
      // to a whole payroll period, so it keeps the flag NULL on its own.
      expect(DATASET_V1.sourceNote).toContain("VERIFIED");
      expect(DATASET_V1.sourceNote).toMatch(/boundaries.*secondary sources/s);
      // Only a human who has read the primary annex may set this. The seeder
      // inserting it would forge the audit trail the staleness warning exists
      // to provide.
      expect(Object.keys(DATASET_V1)).not.toContain("lastVerifiedAt");
      const insertValues = catalog.slice(
        catalog.indexOf(".insert(taxReferenceDatasets)"),
        catalog.indexOf(".onConflictDoNothing()", catalog.indexOf(".insert(taxReferenceDatasets)")),
      );
      expect(insertValues).not.toContain("lastVerifiedAt");
    });
  });

  describe("later foundation migrations (0041-0047)", () => {
    const FOUNDATION_FILES = [
      "0037_tax_reference_core.sql",
      "0038_payroll_compliance.sql",
      "0039_payroll_contribution_check.sql",
      "0040_party_tax_profiles.sql",
      "0041_journal_balance_constraint.sql",
      "0042_journal_amendment_lineage.sql",
      "0043_payroll_run_journal_link.sql",
      "0044_payroll_acknowledgement_note.sql",
      "0045_tax_certificates.sql",
      "0046_payroll_filing_state.sql",
      "0047_tax_stage_remainder.sql",
    ];

    it("names 0041-0047 in order in the foundation runner", () => {
      const runner = read(FOUNDATION);
      let previous = -1;
      for (const file of FOUNDATION_FILES) {
        const at = runner.indexOf(file);
        expect(at, file).toBeGreaterThan(previous);
        previous = at;
      }
    });

    it("gives tax_certificates an RLS policy", () => {
      // Same B5 failure mode the payroll tables already guard: a new org-scoped
      // table silently gets no policy because rls_policies.sql is hand-maintained.
      const policies = read("drizzle/rls_policies.sql");
      expect(policies).toContain("org_isolation_tax_certificates");
      expect(policies).toContain("ALTER TABLE tax_certificates ENABLE ROW LEVEL SECURITY");
    });
    it("gives the stage-remainder tables RLS and leaves deadline overrides global", () => {
      const policies = read("drizzle/rls_policies.sql");
      expect(policies).toContain("org_isolation_org_tax_year_elections");
      expect(policies).toContain("org_isolation_tax_withholding_payments");
      expect(policies).toContain("org_isolation_tax_computed_returns");
      expect(policies).not.toContain("org_isolation_filing_deadline_overrides");
    });
  });

  describe("query keys for the payroll filing page", () => {
    it("exports payroll and filing builders", () => {
      const keys = read("src/lib/query-keys.ts");
      expect(keys).toContain("payroll:");
      expect(keys).toContain("filing:");
      expect(keys).toContain('["payroll", runId, "variances"]');
      expect(keys).toContain('["filing", "workspace", runId]');
    });

    it("uses those builders on the payroll filing route", () => {
      const page = read("src/routes/payroll_.$runId.tsx");
      expect(page).toContain('from "../lib/query-keys"');
      expect(page).toContain("keys.payroll.variances");
      expect(page).toContain("keys.filing.workspace");
      expect(page).not.toContain('["payroll-variances"');
      expect(page).not.toContain("REFERENCE_DATASET_VERSION");
    });
  });

  describe("product UI for remaining tax stages", () => {
    it("exports tax query-key builders", () => {
      const keys = read("src/lib/query-keys.ts");
      expect(keys).toContain("tax:");
      expect(keys).toContain('["tax", "certificates"]');
      expect(keys).toContain('["tax", "settings"]');
      expect(keys).toContain('["tax", "deadlines", year]');
    });

    it("wires compute, settings and deadline routes into the generated tree", () => {
      const tree = read("src/routeTree.gen.ts");
      expect(tree).toContain("'/tax/compute'");
      expect(tree).toContain("'/tax/settings'");
      expect(tree).toContain("'/tax/deadlines'");
      expect(tree).toContain("'/tax/ewt'");
      expect(tree).toContain("'/tax/parties'");
    });

    it("points the sidebar at the new tax screens", () => {
      const sidebar = read("src/components/AppSidebar.tsx");
      expect(sidebar).toContain('href: "/tax/compute"');
      expect(sidebar).toContain('href: "/tax/settings"');
      expect(sidebar).toContain('href: "/tax/deadlines"');
      expect(sidebar).toContain('href: "/tax/ewt"');
      expect(sidebar).toContain('href: "/tax/parties"');
    });

    it("uses the live engine signatures on /tax/compute", () => {
      const page = read("src/routes/tax.compute.tsx");
      expect(page).toContain("payeeType");
      expect(page).toContain("paymentType");
      expect(page).toContain("hasCompensationIncome");
      expect(page).toContain("creditableInputVat");
      expect(page).not.toContain("payeeKind");
      expect(page).not.toContain("taxableBase");
    });

    it("keeps issued 2307s out of the received-certificate list", () => {
      const api = read("src/routes/api/-tax-certificates.ts");
      expect(api).toContain('eq(taxCertificates.certificateType, "received_2307")');
    });

    it("refuses a later replacement of an irrevocable year election", () => {
      const api = read("src/routes/api/-tax-settings.ts");
      expect(api).toContain("existing?.irrevocable && existing.regime !== input.regime");
      expect(api).toContain("not to corporations");
    });

    it("stores a 1601-C working return from a payroll run", () => {
      const issuer = read("src/lib/tax/issue-1601c.ts");
      expect(issuer).toContain('formCode: "1601C"');
      expect(issuer).toContain("compensationFromPayrollLine");
    });
  });
});
