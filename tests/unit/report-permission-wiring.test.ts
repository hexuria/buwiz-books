// Ratchet: every org-scoped report read carries the explicit report:view
// permission statement. withSessionOrgContext only authenticates — it grants
// any member every report; the audit required the real permission gate, and
// this pins it so a new handler can't quietly regress to the weaker wrapper.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("src/routes/api/-reports.ts", "utf8");

describe("report permission wiring", () => {
  it("-reports.ts has no session-only org reads", () => {
    expect(SOURCE.includes("withSessionOrgContext")).toBe(false);
  });

  it("every org-scoped handler is gated on report:view", () => {
    const gated = SOURCE.match(/withPermissionOrgContext\("report", "view"/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(6);
  });
});
