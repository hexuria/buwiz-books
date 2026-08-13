import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

/**
 * Guards the bug class that made /review-agents render empty for as long as it did.
 *
 * The 14 rule definitions existed. The INSERT that creates them existed. What did not exist was
 * a link between that INSERT and any path that actually builds a database: it lived only in
 * drizzle/0019_inbox_review_foundation.sql, a file absent from drizzle/meta/_journal.json and
 * therefore never run by drizzle-kit, invoked by exactly one script that the deploy pipeline
 * does not call. Every environment created the table from the Drizzle schema and left it empty,
 * and the failure was invisible: no error, no warning, just a page saying "No review agents are
 * configured." on a database that was otherwise completely healthy.
 *
 * A seeding step is only as good as the paths that call it, and nothing in a type system or a
 * test run notices when one of those paths quietly stops calling it. So the wiring is asserted
 * directly, against the config files themselves.
 */
describe("review-rule catalog wiring", () => {
  const SEEDER = "scripts/seed-review-rules.ts";

  describe("package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    it("exposes both a write and a read-only entry point", () => {
      expect(pkg.scripts["db:seed:review-rules"]).toContain(SEEDER);
      expect(pkg.scripts["db:review-rules:status"]).toContain(SEEDER);
      // Read-only must stay read-only; it is the command reached for against production.
      expect(pkg.scripts["db:review-rules:status"]).toContain("--status");
      expect(pkg.scripts["db:seed:review-rules"]).not.toContain("--status");
    });

    it.each(["db:fresh", "db:test:fresh"])(
      "%s seeds the catalog, so a rebuilt database is never left blank",
      (script) => {
        expect(pkg.scripts[script]).toContain("db:seed:review-rules");
      },
    );

    it("seeds after the schema exists", () => {
      // The table is created by the reset/push step; seeding before it would fail loudly, but
      // ordering it explicitly keeps the intent readable.
      const fresh = pkg.scripts["db:fresh"];
      expect(fresh.indexOf("db:reset")).toBeLessThan(fresh.indexOf("db:seed:review-rules"));
    });
  });

  describe("application CI", () => {
    const workflow = read(".github/workflows/deploy.yml");

    it("does not carry the production seeding path", () => {
      expect(workflow).not.toContain(SEEDER);
    });
  });

  describe("Dockerfile", () => {
    const dockerfile = read("Dockerfile");

    it("ships the seeder and the module it reads", () => {
      // The runtime image copies scripts individually and only `src/db` from `src/`. Omitting
      // either of these makes the deploy step fail at module resolution — loudly, but a deploy
      // is a bad place to discover it.
      expect(dockerfile).toContain(SEEDER);
      expect(dockerfile).toContain("src/lib/inbox/review-rule-catalog.ts");
    });
  });

  describe("application Makefile", () => {
    const makefile = read("Makefile");

    it("does not expose production catalog seeding through migration", () => {
      expect(makefile).not.toContain(SEEDER);
      expect(makefile).toMatch(
        /^migrate:\n\t@echo .*disabled in this application repository.*\n\t@exit 1$/m,
      );
    });
  });

  describe("the seeder itself", () => {
    const source = read(SEEDER);

    it("reports the target database before doing anything", () => {
      // An unset DATABASE_URL makes psql fall back to the database named after the OS user and
      // report "relation does not exist" for a table that is present elsewhere. Naming the
      // connection first is what turns that from a mystery into a one-line diagnosis.
      expect(source).toContain("current_database()");
      const reportsTarget = source.indexOf("await reportTarget()");
      const seeds = source.indexOf("await seedReviewRuleDefinitions");
      expect(reportsTarget).toBeGreaterThan(-1);
      expect(reportsTarget).toBeLessThan(seeds);
    });

    it("never updates an existing definition", () => {
      // 0020 already changed possible_duplicate's defaults. Re-asserting a TypeScript constant
      // over a reviewed migration would retune duplicate blocking for every tenant.
      const catalog = read("src/lib/inbox/review-rule-catalog.ts");
      expect(catalog).toContain("onConflictDoNothing");
      expect(catalog).not.toContain("onConflictDoUpdate");
    });
  });
});
