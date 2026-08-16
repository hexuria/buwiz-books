---
trigger: file_change
description: Mandatory protocol when database schema changes affect exported/imported entities
globs:
  - src/db/schema/**
  - src/lib/export-versions.ts
  - src/lib/export-migrations.ts
  - src/routes/api/-export-import.ts
---

# Schema Change → Export/Import Update Protocol

Whenever a database schema file in `src/db/schema/` is modified in a way that **adds, removes, or renames columns** on a table that is part of the export/import system, you MUST follow this protocol. Failure to do so will cause silent data loss during import or produce export files that cannot be re-imported.

---

## 🗺 Architecture Overview

The export/import system has four layers. Understand them before touching anything:

```
┌─────────────────────────────────────────────────────────────┐
│  1. Schema (src/db/schema/*.ts)                             │
│     The Drizzle ORM table definitions — source of truth     │
├─────────────────────────────────────────────────────────────┤
│  2. Version Registry (src/lib/export-versions.ts)           │
│     EXPORT_VERSION constant, EXPORTABLE_ENTITIES list,      │
│     ENTITY_LABELS, ExportMeta interface                     │
├─────────────────────────────────────────────────────────────┤
│  3. Migration Engine (src/lib/export-migrations.ts)         │
│     migrateToLatest() + per-version migration functions     │
│     (e.g. migrateV1toV2, migrateV2toV3)                    │
├─────────────────────────────────────────────────────────────┤
│  4. API Handlers (src/routes/api/-export-import.ts)         │
│     exportData — SELECT queries that build export rows      │
│     validateImport — Zod schemas that validate import rows  │
│     executeImport — INSERT/UPDATE logic per entity type     │
│     listExportableRecords — cherry-pick listing queries     │
└─────────────────────────────────────────────────────────────┘
```

**Data flows:**

- **Export:** Schema → API `exportData` switch-case → JSON file with `meta.version`
- **Import:** JSON file → `migrateToLatest()` → `validateImport` Zod schema → `executeImport` switch-case → Schema

---

## 📋 Decision Flowchart

Before making changes, determine which category your schema change falls into:

### Category A: Adding a new column to an existing exported entity

> Example: Adding `taxId` column to the `parties` table

**Steps:**

1. Add the column to the Drizzle schema (`src/db/schema/parties.ts`)
2. Run `bun drizzle-kit generate` for the migration
3. Update the `exportData` SELECT query for that entity to include the new field
4. Update the `validateImport` Zod schema to accept the new field (use `.optional().nullable()` for backward compatibility)
5. Update the `executeImport` INSERT to map the new field
6. **DO NOT bump EXPORT_VERSION** — the new field is optional, so old exports still import fine
7. Update unit tests in `tests/unit/lib/export-import-schemas.test.ts`
8. Run `bun test tests/unit/lib/` to verify

### Category B: Removing or renaming a column on an exported entity

> Example: Renaming `is1099Vendor` → `requiresForm1099` on vendors

**Steps:**

1. Apply the schema change
2. **BUMP `EXPORT_VERSION`** in `src/lib/export-versions.ts` (e.g. 2 → 3)
3. Write a migration function `migrateV2toV3` in `src/lib/export-migrations.ts`
4. Register it in the `migrations` record: `2: migrateV2toV3`
5. The migration must transform the old field name to the new one in the data block
6. Update all four API sections (export SELECT, Zod schema, executeImport, listExportableRecords)
7. Update the unit test fixtures (`tests/fixtures/export-v2-sample.json`) and add a v3 fixture
8. Add migration unit tests in `tests/unit/lib/export-migrations.test.ts`
9. Run full test suite

### Category C: Adding a brand-new exportable entity

> Example: Adding "Tax Rates" as a new entity type

**Steps:**

1. Create the schema in `src/db/schema/`
2. **BUMP `EXPORT_VERSION`**
3. Add the entity key to `EXPORTABLE_ENTITIES` in `src/lib/export-versions.ts`
4. Add the label to `ENTITY_LABELS`
5. Add the type to `EntityType` union and `ENTITY_TYPES` array in `-export-import.ts`
6. Add the entity to `ENTITY_ENUM` (for the Zod schema)
7. Write the `exportData` switch-case
8. Write the `validateImport` Zod schema
9. Write the `executeImport` switch-case
10. Write the `listExportableRecords` switch-case (for cherry-pick UI)
11. Write a migration function that adds an empty array for the new entity to old exports
12. Update `ExportPanel.tsx` (icon + checkbox row) and `ImportPanel.tsx` (ENTITY_OPTIONS + query invalidation)
13. Add the entity to E2E test assertions (`tests/e2e/settings/export-import.spec.ts`)
14. Add Zod schema tests in `tests/unit/lib/export-import-schemas.test.ts`

### Category D: Removing an exportable entity

> Example: Removing "Number Sequences" from export

**Steps:**

1. **BUMP `EXPORT_VERSION`**
2. Remove from `EXPORTABLE_ENTITIES`, `ENTITY_LABELS`, `EntityType`, `ENTITY_TYPES`, `ENTITY_ENUM`
3. Remove the switch-cases from all four API functions
4. Write a migration that strips the removed entity from the data block (so old exports don't cause errors)
5. Update UI components and tests

---

## 🔧 Step-by-Step: Writing a Migration Function

When you bump `EXPORT_VERSION` (e.g. from 2 to 3), you MUST write a corresponding migration:

```typescript
// In src/lib/export-migrations.ts

// 1. Add to the migrations registry
const migrations: Record<number, MigrationFn> = {
  1: migrateV1toV2,
  2: migrateV2toV3, // ← ADD THIS
};

// 2. Write the migration function
function migrateV2toV3(input: Record<string, unknown>): VersionedExportFile {
  const prev = input as VersionedExportFile;
  const data = { ...prev.data } as Record<string, unknown>;

  // Example: Rename a field across all vendor rows
  if (Array.isArray(data.vendors)) {
    data.vendors = (data.vendors as Record<string, unknown>[]).map((v) => {
      const { is1099Vendor, ...rest } = v;
      return { ...rest, requiresForm1099: is1099Vendor ?? false };
    });
  }

  // Example: Add empty array for new entity
  if (!data.taxRates) {
    data.taxRates = [];
  }

  return {
    meta: {
      ...prev.meta,
      version: 3,
    },
    data,
  };
}
```

### Migration Rules

- **Always set `meta.version`** to the target version in the return value
- **Never mutate the input** — spread/copy before transforming
- **Handle missing fields gracefully** — old exports may not have newer fields
- **Preserve all unrecognized keys** — don't strip data you don't know about
- **Each migration only goes N → N+1** — the engine chains them automatically

---

## 🧪 Testing Checklist

After any export/import change, you MUST verify:

### Unit Tests (fast, no DB required)

```bash
# Run all export/import unit tests
bun test tests/unit/lib/export-versions.test.ts
bun test tests/unit/lib/export-migrations.test.ts
bun test tests/unit/lib/export-import-schemas.test.ts
```

**What to add/update:**

| Change Type               | Test File to Update                            |
| ------------------------- | ---------------------------------------------- |
| New/changed Zod schema    | `tests/unit/lib/export-import-schemas.test.ts` |
| New migration function    | `tests/unit/lib/export-migrations.test.ts`     |
| Changed version detection | `tests/unit/lib/export-versions.test.ts`       |
| New fixture needed        | `tests/fixtures/export-v{N}-sample.json`       |

### E2E Tests (requires test server)

```bash
# Kill any running dev server first, then:
npx playwright test tests/e2e/settings/export-import.spec.ts --project chromium
```

**What to update:**

- If you added a new entity: add it to the `expectedLabels` array in the "should display all entity types" test
- If you added a new importable entity: add it to the `expectedOptions` array in the "should display all importable entity types" test
- If you changed the format selector: update the format test

---

## 🐛 Debugging Guide

### Problem: "Unrecognized export file format"

**Cause:** `getExportVersion()` returns 0 — the JSON has neither `{ exportedAt, entities }` (v1) nor `{ meta: { version }, data }` (v2+).

**Fix:**

1. Open the export file in a text editor
2. Check if it has a `meta` block with a `version` number
3. If it's a legacy file, check for `exportedAt` and `entities` keys
4. If neither, the file is corrupted or not a Buwiz Books export

### Problem: "Export file is from a newer version"

**Cause:** The file's `meta.version` is higher than the app's `EXPORT_VERSION`.

**Fix:** Update the app. If you're the developer, you forgot to bump `EXPORT_VERSION`.

### Problem: "Missing migration from vN to vN+1"

**Cause:** `EXPORT_VERSION` was bumped but no migration function was registered for the gap.

**Fix:**

1. Check `src/lib/export-migrations.ts` → `migrations` record
2. Ensure there's a function for every version from 1 to `EXPORT_VERSION - 1`
3. Write the missing migration function

### Problem: Import succeeds but data is wrong/missing fields

**Cause:** The Zod schema in `validateImport` accepts the row, but `executeImport` doesn't map all fields to the INSERT.

**Debug steps:**

1. Export a record via the UI
2. Open the JSON and inspect the entity's row shape
3. Compare it to the `executeImport` switch-case INSERT values
4. Check if any new schema columns are missing from the INSERT

### Problem: Export produces empty arrays for an entity

**Cause:** The `exportData` SELECT query doesn't match the current schema, or the org filter is wrong.

**Debug steps:**

1. Check the switch-case in `exportData` for the entity
2. Verify the `orgId` filter is using the correct column
3. Run the raw SQL in `psql` to check if data exists:
   ```sql
   SELECT count(*) FROM parties WHERE organization_id = 'your-org-id';
   ```

### Problem: "duplicate key" errors during import

**Cause:** The import tried to insert a record that already exists. The dedup logic (match by name) missed it.

**Fix:**

1. Check the `executeImport` switch-case for the entity
2. Verify it queries for existing records before inserting
3. Add a pre-check: `SELECT id FROM {table} WHERE name = $1 AND organization_id = $2`

### Problem: TypeScript error on `partyType` enum mismatch

**Cause:** The entity key is plural (`employees`) but the DB enum is singular (`employee`).

**Fix:** Use the `PARTY_TYPE_MAP` lookup in `-export-import.ts`:

```typescript
const PARTY_TYPE_MAP: Record<string, string> = {
  employees: "employee",
  shareholders: "shareholder",
  lenders: "lender",
  government: "government",
};
```

### Problem: E2E export test downloads empty file

**Cause:** The test deselected all entities but didn't re-select them properly. The checkbox locator is wrong.

**Debug steps:**

1. Run with `--headed` to see the browser: `npx playwright test --headed --project chromium`
2. Check if the checkboxes are actually being checked
3. Verify the entity list locator: `page.getByRole("main").locator(".divide-y")`

### Problem: E2E auth setup fails with "Failed to retrieve OTP"

**Cause:** The Playwright `webServer` isn't running, or there's a stale dev server using the wrong `.env`.

**Fix:**

1. Kill any process on port 3000: `kill -9 $(lsof -t -i:3000)`
2. Run `npx playwright test` (NOT `--no-deps`) so the `dev:test` server starts fresh
3. The `dev:test` script uses `.env.test` which has the correct `DATABASE_URL` and `BETTER_AUTH_SECRET`

---

## 📁 File Reference

| File                                           | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `src/lib/export-versions.ts`                   | Version constant, entity registry, type definitions         |
| `src/lib/export-migrations.ts`                 | Migration engine + per-version transform functions          |
| `src/routes/api/-export-import.ts`             | Server functions: export, validate, execute, list           |
| `src/components/settings/ExportPanel.tsx`      | Export UI: entity checklist, format toggle, cherry-pick     |
| `src/components/settings/ImportPanel.tsx`      | Import UI: entity selector, file upload, validation preview |
| `tests/unit/lib/export-versions.test.ts`       | Unit tests for version detection                            |
| `tests/unit/lib/export-migrations.test.ts`     | Unit tests for migration chain                              |
| `tests/unit/lib/export-import-schemas.test.ts` | Unit tests for Zod validation schemas                       |
| `tests/e2e/settings/export-import.spec.ts`     | E2E tests for full export/import UI flow                    |
| `tests/fixtures/export-v1-sample.json`         | Legacy v1 format fixture                                    |
| `tests/fixtures/export-v2-sample.json`         | Current v2 format fixture                                   |

---

## ⚠️ Common Mistakes

1. **Bumping EXPORT_VERSION without a migration** — This breaks import for ALL existing export files. Always pair a version bump with a migration function.

2. **Adding a required field to a Zod schema** — Old exports won't have this field. Always use `.optional().nullable()` for new fields, or set a `.default()`.

3. **Forgetting to update `executeImport`** — The Zod schema accepts the field, but the INSERT ignores it. Data silently vanishes.

4. **Not updating `listExportableRecords`** — The cherry-pick UI shows "0 records" for the entity.

5. **Editing the export without updating tests** — The next agent will break it. Run `bun test tests/unit/lib/` after every change.

6. **Running E2E tests with `bun dev` instead of `dev:test`** — The auth session uses a different DB. Always let Playwright start its own server, or use `bun run dev:test`.
