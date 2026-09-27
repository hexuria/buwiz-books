import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_LABELS, EXPORTABLE_ENTITIES, EXPORT_VERSION } from "../../src/lib/export-versions";
import { V5_INBOX_CONFIG_ENTITIES } from "../../src/lib/export-migrations";
import {
  IMPORTED_SNAPSHOT_LABEL_MAX_LENGTH,
  INBOX_CONFIG_ENTITY_KEYS,
} from "../../src/lib/export-inbox-rows";
import { RULE_SNAPSHOT_LABEL_MAX_LENGTH } from "../../src/lib/inbox/rule-snapshots";

const REPO_ROOT = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

/**
 * Inbox v2 step 12 — export v5 (.agent/rules/schema-export-import.md, category C). Every layer of
 * the protocol names the three Inbox-configuration entities, and the one table that must never
 * leave the database — routine_secrets — is not reachable from the export code at all.
 */
describe("export v5 wiring", () => {
  it("registers the entities at v5, in import order, with labels", () => {
    expect(EXPORT_VERSION).toBe(5);
    expect(INBOX_CONFIG_ENTITY_KEYS).toEqual([
      "ruleSnapshots",
      "routines",
      "classificationMemories",
    ]);
    const order = EXPORTABLE_ENTITIES as readonly string[];
    for (const key of INBOX_CONFIG_ENTITY_KEYS) {
      expect(order, `${key} missing from EXPORTABLE_ENTITIES`).toContain(key);
      expect(ENTITY_LABELS[key]).toBeTruthy();
    }
    expect(order.indexOf("ruleSnapshots")).toBeLessThan(order.indexOf("routines"));
    for (const dependency of ["vendors", "customers", "categories"]) {
      expect(order.indexOf("classificationMemories")).toBeGreaterThan(order.indexOf(dependency));
    }
  });

  it("the v4 → v5 migration fills exactly these entities", () => {
    expect([...V5_INBOX_CONFIG_ENTITIES]).toEqual([...INBOX_CONFIG_ENTITY_KEYS]);
  });

  it("imports snapshot labels under the same limit the app creates them with", () => {
    expect(IMPORTED_SNAPSHOT_LABEL_MAX_LENGTH).toBe(RULE_SNAPSHOT_LABEL_MAX_LENGTH);
  });

  it("the route validates, exports, imports and lists every entity through export-inbox", () => {
    const route = read("src/routes/api/-export-import.ts");
    const enumBlock = route.slice(route.indexOf("const ENTITY_ENUM"), route.indexOf("] as const;"));
    for (const key of INBOX_CONFIG_ENTITY_KEYS) {
      expect(enumBlock, `ENTITY_ENUM missing ${key}`).toContain(`"${key}"`);
    }
    expect(route).toContain("await exportInboxConfigEntity(db, orgId, entity, {");
    expect(route).toContain("if (isInboxConfigEntity(entityType)) return inboxConfigRowSchema(");
    expect(route).toContain(
      "await importInboxConfigEntity({ db, orgId, userId, role }, entityType, rows)",
    );
    expect(route).toContain("await listInboxConfigRecords(db, orgId, entityType)");
  });

  it("never reads routine secrets on the way out", () => {
    for (const path of ["src/lib/export-inbox.ts", "src/lib/export-inbox-rows.ts"]) {
      const source = read(path);
      expect(source, `${path} imports routine_secrets`).not.toMatch(/\broutineSecrets\b/);
      expect(source).not.toMatch(/secretEnc|secret_enc|loadRoutineWebhookSecret/);
    }
    // The only secret-shaped key a routine row carries is removed before it leaves.
    expect(read("src/lib/export-inbox.ts")).toContain(
      "triggerConfig: exportTriggerConfig(row.triggerConfig)",
    );
  });

  it("Settings lists the entities for export and for import", () => {
    const exportPanel = read("src/components/settings/ExportPanel.tsx");
    const cherry = exportPanel.slice(
      exportPanel.indexOf("const CHERRY_PICKABLE"),
      exportPanel.indexOf("const PH_ICON"),
    );
    const importPanel = read("src/components/settings/ImportPanel.tsx");
    for (const key of INBOX_CONFIG_ENTITY_KEYS) {
      expect(cherry, `ExportPanel missing ${key}`).toContain(`"${key}"`);
      expect(importPanel, `ImportPanel missing ${key}`).toContain(`value: "${key}"`);
    }
  });
});
