import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Guards the bug that kept `src/lib/coa/` out of git entirely.
 *
 * `.gitignore` carried `COA/` for the reference material at the repo root. A
 * gitignore pattern without a leading slash matches at ANY depth, and with
 * `core.ignorecase=true` (the default on macOS) `COA/` also matches `coa/` — so
 * 18 source files and 6 test files were silently excluded. Everything passed
 * locally because the files were on disk; a fresh clone would not have
 * typechecked, since dozens of committed modules import from that path.
 *
 * Root-level project directories must therefore be written `/name/`, not
 * `name/`. This is cheap insurance against a failure that is invisible until
 * someone clones the repo.
 */
describe(".gitignore anchoring", () => {
  const lines = readFileSync(resolve(REPO_ROOT, ".gitignore"), "utf8").split("\n");

  it("anchors every directory pattern to the repo root", () => {
    const unanchored = lines
      .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
      .filter(({ line }) => line.endsWith("/") && !line.startsWith("#") && !line.startsWith("!"))
      .filter(({ line }) => !line.startsWith("/"))
      // A pattern containing a slash mid-string (e.g. `foo/bar/`) is already
      // path-anchored by git's own rules.
      .filter(({ line }) => !line.slice(0, -1).includes("/"));

    expect(
      unanchored.map((u) => `.gitignore:${u.lineNo} "${u.line}" — write "/${u.line}"`),
    ).toEqual([]);
  });

  it("keeps the COA module and its tests tracked", () => {
    // The specific files that went missing. `git check-ignore` exits 1 when a
    // path is NOT ignored, which is what we want here.
    for (const path of ["src/lib/coa/validate-draft.ts", "tests/unit/lib/coa/presets.test.ts"]) {
      let ignored = true;
      try {
        execFileSync("git", ["check-ignore", "-q", path], { cwd: REPO_ROOT });
      } catch {
        ignored = false;
      }
      expect(ignored, `${path} is excluded by .gitignore`).toBe(false);
    }
  });

  it("has every src/lib/coa file committed, not merely present on disk", () => {
    const tracked = execFileSync("git", ["ls-files", "src/lib/coa"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    // Sanity floor: the module is substantially larger than this, so any
    // wholesale exclusion trips the assertion.
    expect(tracked.length).toBeGreaterThan(10);
    expect(tracked).toContain("src/lib/coa/validate-draft.ts");
  });
});
