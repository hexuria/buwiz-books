/**
 * Export Migration Engine
 * Transforms export files from older schema versions to the current version.
 * Each migration function transforms data from version N to version N+1.
 */
import { brand } from "@/config/brand";
import { EXPORT_VERSION, getExportVersion } from "./export-versions";
import type { VersionedExportFile, ExportMeta } from "./export-versions";

// ============================================================================
// Migration Registry
// ============================================================================

type MigrationFn = (data: Record<string, unknown>) => VersionedExportFile;

/**
 * Registry of migration functions keyed by source version.
 * migration[1] transforms v1 → v2, migration[2] would transform v2 → v3, etc.
 */
const migrations: Record<number, MigrationFn> = {
  1: migrateV1toV2,
  2: migrateV2toV3,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Migrate an export file to the latest version.
 * Runs the full migration chain: v1 → v2 → ... → current.
 *
 * @param parsed - Raw parsed JSON from an export file
 * @returns A VersionedExportFile at the current version
 * @throws Error if the format is unrecognized or a migration is missing
 */
export function migrateToLatest(parsed: unknown): VersionedExportFile {
  let version = getExportVersion(parsed);

  if (version === 0) {
    throw new Error(
      `Unrecognized export file format. Expected a ${brand.appName} export file (JSON).`,
    );
  }

  if (version > EXPORT_VERSION) {
    throw new Error(
      `Export file is from a newer version (v${version}). ` +
        `Please update the app to import this file. Current version: v${EXPORT_VERSION}.`,
    );
  }

  // Already current
  if (version === EXPORT_VERSION) {
    return parsed as VersionedExportFile;
  }

  // Run migration chain
  let data = parsed as Record<string, unknown>;
  while (version < EXPORT_VERSION) {
    const migrateFn = migrations[version];
    if (!migrateFn) {
      throw new Error(
        `Missing migration from v${version} to v${version + 1}. ` +
          `Cannot import this export file.`,
      );
    }
    const migrated = migrateFn(data);
    data = migrated as unknown as Record<string, unknown>;
    version++;
  }

  return data as unknown as VersionedExportFile;
}

// ============================================================================
// v1 → v2 Migration
// ============================================================================

/**
 * Migrate legacy format (v1) to versioned format (v2).
 *
 * v1 shape: { exportedAt: string, entities: { banks: [...], vendors: [...], ... } }
 * v2 shape: { meta: { version, exportedAt, ... }, data: { banks: [...], ... } }
 */
function migrateV1toV2(legacy: Record<string, unknown>): VersionedExportFile {
  const exportedAt =
    typeof legacy.exportedAt === "string" ? legacy.exportedAt : new Date().toISOString();

  const entities =
    typeof legacy.entities === "object" && legacy.entities !== null
      ? (legacy.entities as Record<string, unknown>)
      : {};

  const entityKeys = Object.keys(entities);

  const meta: ExportMeta = {
    version: 2,
    exportedAt,
    organizationName: "Unknown (migrated from v1)",
    organizationSlug: "unknown",
    entities: entityKeys,
  };

  return {
    meta,
    data: entities,
  };
}

// ============================================================================
// v2 → v3 Migration
// ============================================================================

/**
 * v3 adds the Philippine tax entities. A v2 file simply has none of them —
 * the data passes through unchanged and only the meta version advances, so
 * every v2 file remains importable forever (rules doc Mistake #1).
 */
function migrateV2toV3(data: Record<string, unknown>): VersionedExportFile {
  const file = data as unknown as VersionedExportFile;
  const meta: ExportMeta = { ...file.meta, version: 3 };
  return { meta, data: file.data };
}
