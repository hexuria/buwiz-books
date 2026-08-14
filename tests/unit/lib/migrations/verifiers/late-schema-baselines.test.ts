import { describe, expect, it } from "vitest";
import { verifier0028 } from "@/lib/migrations/verifiers/0028";
import { verifier0032 } from "@/lib/migrations/verifiers/0032";
import { verifier0033 } from "@/lib/migrations/verifiers/0033";
import { verifier0035 } from "@/lib/migrations/verifiers/0035";
import { verifier0036 } from "@/lib/migrations/verifiers/0036";
import { context, createEmptyCatalogSnapshot, queryFor } from "./support";
import { addSchema0028 } from "./fixtures/0028-0031";
import { addSchema0032 } from "./fixtures/0032";
import { addSchema0033 } from "./fixtures/0033";
import { addSchema0035 } from "./fixtures/0035";
import { addSchema0036 } from "./fixtures/0036";

describe("Late migration schema baselines", () => {
  it("treats an empty catalog as discovery-absent but requires schema sync before execution", async () => {
    await expect(
      verifier0028.verify(queryFor().query, context("0028", "discovery")),
    ).resolves.toMatchObject({ state: "absent", shape: "absent" });

    await expect(
      verifier0028.verify(queryFor().query, context("0028", "pre_execution")),
    ).resolves.toMatchObject({ state: "partial", shape: "schema-sync-drift" });

    const synchronized = createEmptyCatalogSnapshot();
    addSchema0028(synchronized);
    await expect(
      verifier0028.verify(queryFor(synchronized).query, context("0028", "pre_execution")),
    ).resolves.toMatchObject({
      state: "absent",
      shape: "schema-sync-compatible",
    });

    synchronized.relations.get("enterprise_accounts")!.columns.pop();
    await expect(
      verifier0028.verify(queryFor(synchronized).query, context("0028", "pre_execution")),
    ).resolves.toMatchObject({ state: "partial", shape: "schema-sync-drift" });
  });

  it("distinguishes discovery-empty and exact pre-execution state for every schema-modeled late migration", async () => {
    const cases = [
      [verifier0028, "0028", addSchema0028],
      [verifier0032, "0032", addSchema0032],
      [verifier0033, "0033", addSchema0033],
      [verifier0035, "0035", addSchema0035],
      [verifier0036, "0036", addSchema0036],
    ] as const;

    for (const [verifier, through, addSchema] of cases) {
      await expect(
        verifier.verify(queryFor().query, context(through, "discovery")),
        `empty discovery migration ${through}`,
      ).resolves.toMatchObject({ state: "absent", shape: "absent" });

      await expect(
        verifier.verify(queryFor().query, context(through, "pre_execution")),
        `empty pre-execution migration ${through}`,
      ).resolves.toMatchObject({
        state: "partial",
        shape: "schema-sync-drift",
      });

      const { snapshot, query } = queryFor();
      addSchema(snapshot);
      await expect(
        verifier.verify(query, context(through, "pre_execution")),
        `exact pre-execution migration ${through}`,
      ).resolves.toMatchObject({
        state: "absent",
        shape: "schema-sync-compatible",
      });
    }
  });
});
