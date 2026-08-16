import { describe, expect, it } from "vitest";
import { verifier0030 } from "@/lib/migrations/verifiers/0030";
import {
  addFunction,
  addPrivilege,
  addRole,
  context,
  createEmptyCatalogSnapshot,
  queryFor,
} from "./support";
import {
  addAssignmentSchema,
  assignmentFunction3Body,
  assignmentFunction4Body,
} from "./fixtures/0028-0031";

describe("Migration 0030 verifier", () => {
  it("requires the exact four-argument 0030 probe and rejects unsafe or ambiguous overloads", async () => {
    const { snapshot, query } = queryFor();
    addAssignmentSchema(snapshot, false);
    addFunction(
      snapshot,
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      assignmentFunction4Body,
    );

    const complete0030 = await verifier0030.verify(query, context("0030"));
    expect(
      complete0030.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected} != ${item.observed}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(complete0030).toMatchObject({ state: "complete" });

    snapshot.functions.get(
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
    )!.config = ["search_path=public, pg_temp"];
    await expect(
      verifier0030.verify(queryFor(snapshot).query, context("0030")),
    ).resolves.toMatchObject({
      state: "partial",
    });

    snapshot.functions.get(
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
    )!.config = ["search_path=public"];
    addFunction(
      snapshot,
      "is_organization_assigned_to_business_group(uuid, text, uuid)",
      assignmentFunction3Body,
    );
    await expect(
      verifier0030.verify(queryFor(snapshot).query, context("0030")),
    ).resolves.toMatchObject({
      state: "partial",
    });
  });

  it("requires 0030 PUBLIC revoke and existing-runtime-role execute grants", async () => {
    const withoutRoles = createEmptyCatalogSnapshot();
    addAssignmentSchema(withoutRoles, false);
    addFunction(
      withoutRoles,
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      assignmentFunction4Body,
    );
    await expect(
      verifier0030.verify(queryFor(withoutRoles).query, context("0030")),
    ).resolves.toMatchObject({ state: "complete" });

    const publicExecute = createEmptyCatalogSnapshot();
    addAssignmentSchema(publicExecute, false);
    addFunction(
      publicExecute,
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      assignmentFunction4Body,
    );
    addPrivilege(
      publicExecute,
      "function",
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      "PUBLIC",
      "EXECUTE",
    );
    await expect(
      verifier0030.verify(queryFor(publicExecute).query, context("0030")),
    ).resolves.toMatchObject({ state: "partial" });

    const missingRuntimeGrant = createEmptyCatalogSnapshot();
    addAssignmentSchema(missingRuntimeGrant, false);
    addFunction(
      missingRuntimeGrant,
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      assignmentFunction4Body,
    );
    addRole(missingRuntimeGrant, "buwiz_app");
    await expect(
      verifier0030.verify(queryFor(missingRuntimeGrant).query, context("0030")),
    ).resolves.toMatchObject({ state: "partial" });

    addPrivilege(
      missingRuntimeGrant,
      "function",
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      "buwiz_app",
      "EXECUTE",
    );
    await expect(
      verifier0030.verify(queryFor(missingRuntimeGrant).query, context("0030")),
    ).resolves.toMatchObject({ state: "complete" });
  });
});
