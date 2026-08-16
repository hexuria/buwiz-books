import { describe, expect, it } from "vitest";
import { migrationManifest } from "@/lib/migrations/manifest";
import {
  migrationVerifierRegistry,
  validateVerifierRegistry,
} from "@/lib/migrations/verifiers/registry";

describe("migration verifier registry", () => {
  it("has exactly one matching verifier for every managed migration", () => {
    expect(() => validateVerifierRegistry()).not.toThrow();
    expect(Object.keys(migrationVerifierRegistry)).toEqual(
      migrationManifest.map((migration) => migration.id),
    );
    for (const migration of migrationManifest) {
      expect(migrationVerifierRegistry[migration.id].id).toBe(migration.id);
    }
  });
});
