import { describe, expect, it } from "vitest";
import { verifier0029 } from "@/lib/migrations/verifiers/0029";
import { verifier0030 } from "@/lib/migrations/verifiers/0030";
import { verifier0031 } from "@/lib/migrations/verifiers/0031";
import { verifier0032 } from "@/lib/migrations/verifiers/0032";
import { verifier0034 } from "@/lib/migrations/verifiers/0034";
import {
  addFunction,
  context,
  createEmptyCatalogSnapshot,
  migrationFunctionBody,
  migrationSql,
  queryFor,
} from "./support";
import {
  addComplete0028,
  assignmentFunction3Body,
  assignmentFunction4Body,
} from "./fixtures/0028-0031";

describe("Late migration predecessors", () => {
  it("classifies exact predecessor states as absent for the next late migration", async () => {
    const through0028 = createEmptyCatalogSnapshot();
    addComplete0028(through0028, "0028");
    const pending0029 = await verifier0029.verify(queryFor(through0028).query, context("0036"));
    expect(
      pending0029.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected} != ${item.observed}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(pending0029).toMatchObject({
      state: "absent",
      shape: "predecessor-compatible",
    });

    const through0029 = createEmptyCatalogSnapshot();
    addComplete0028(through0029, "0029");
    addFunction(
      through0029,
      "is_organization_assigned_to_business_group(uuid, text, uuid)",
      assignmentFunction3Body,
    );
    await expect(
      verifier0030.verify(queryFor(through0029).query, context("0036")),
    ).resolves.toMatchObject({
      state: "absent",
      shape: "predecessor-compatible",
    });

    const through0030 = createEmptyCatalogSnapshot();
    addComplete0028(through0030, "0030");
    addFunction(
      through0030,
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      assignmentFunction4Body,
    );
    const pending0031 = await verifier0031.verify(queryFor(through0030).query, context("0036"));
    expect(
      pending0031.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected} != ${item.observed}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(pending0031).toMatchObject({
      state: "absent",
      shape: "predecessor-compatible",
    });

    const through0033 = createEmptyCatalogSnapshot();
    addComplete0028(through0033, "0033");
    await expect(
      verifier0034.verify(queryFor(through0033).query, context("0036")),
    ).resolves.toMatchObject({ state: "absent" });
  });

  it("does not count the inherited organization context function as 0032 footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addFunction(
      snapshot,
      "current_organization_id()",
      migrationFunctionBody(
        migrationSql("0032_reporting_projections.sql"),
        "current_organization_id",
      ),
      { resultType: "text", securityDefiner: false, config: null },
    );

    await expect(
      verifier0032.verify(queryFor(snapshot).query, context("0032")),
    ).resolves.toMatchObject({ state: "absent", shape: "absent" });
  });
});
