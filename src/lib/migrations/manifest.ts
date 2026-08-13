export type MigrationPhase = "pre_schema" | "post_schema";
export type MigrationExecution = "plain" | "strip_outer_transaction";

export interface MigrationManifestEntry<Id extends string = string> {
  readonly id: Id;
  readonly file: `${Id}_${string}.sql`;
  readonly historyAliases: readonly string[];
  readonly phase: MigrationPhase;
  readonly checksum: string;
  readonly execution: MigrationExecution;
}

const MIGRATION_ID_PATTERN = /^\d{4}$/;
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const MIGRATION_PHASES: readonly MigrationPhase[] = ["pre_schema", "post_schema"];
const MIGRATION_EXECUTIONS: readonly MigrationExecution[] = ["plain", "strip_outer_transaction"];

function entry<const Id extends string>(
  id: Id,
  name: string,
  phase: MigrationPhase,
  checksum: string,
  execution: MigrationExecution = "plain",
): MigrationManifestEntry<Id> {
  return {
    id,
    file: `${id}_${name}.sql`,
    historyAliases: [id],
    phase,
    checksum,
    execution,
  };
}

/**
 * Drizzle's journal owns 0000-0002. The SQL files 0003-0017 are legacy,
 * unjournaled evidence and are deliberately not claimed by this manifest.
 *
 * Registration remains numeric so history aliases and checksums are easy to audit.
 * Lifecycle execution is deliberately phase-first instead: 0026 and 0027 run in
 * numeric order before schema synchronization, then every post-schema entry runs
 * in numeric order. The engine owns that phase ordering; array position alone must
 * never be treated as execution order.
 */
export const migrationManifest = [
  entry(
    "0018",
    "integrity_and_server_secrets",
    "post_schema",
    "94f1ca98472feef887b42a519992d86a390194008db52ed216dd663ce4edb566",
    "strip_outer_transaction",
  ),
  entry(
    "0019",
    "inbox_review_foundation",
    "post_schema",
    "0a21530147ec2a6cb74e974db8a4db76bcbf6e8759c746242ef330f914fce8c5",
  ),
  entry(
    "0020",
    "transaction_deduplication",
    "post_schema",
    "f90602324a3d9ba51137130963e9c77cd02df3f925fabbe72908e04114b9eebd",
  ),
  entry(
    "0021",
    "safe_journal_merge",
    "post_schema",
    "5ff948abb8767c732fde180eb5d4485e1e772a275ac5694d18f844ea6fa8f0b4",
  ),
  entry(
    "0022",
    "legacy_match_conversion",
    "post_schema",
    "f3b0d51c1d7af838c5f8792ab7a5a293c6d81a33778e37ef9c14376594f12de2",
  ),
  entry(
    "0023",
    "operation_idempotency",
    "post_schema",
    "dba35eb99add5ccced7e8ece4287cf8079d788701041a01273ece068a99ab562",
  ),
  entry(
    "0024",
    "tenant_lineage_integrity",
    "post_schema",
    "0bafa9e4d338f4fcdebc49b478fb43a08ea86987360369933b3a81c59ecca80a",
  ),
  entry(
    "0025",
    "financial_account_secrets",
    "post_schema",
    "8ac719efe3455ee7f9e54e426020c8454220bf9e7375281fb31bc3e5c9497fd1",
    "strip_outer_transaction",
  ),
  entry(
    "0026",
    "ai_foundation",
    "pre_schema",
    "adcf758cc85f1394c248ba68090c5ba4bf9d244b1d6eb1296614f199cd91f8ad",
  ),
  entry(
    "0027",
    "vendor_aliases",
    "pre_schema",
    "d16f5c2a041f5a4bf5b7e09a63fc10ca6683d5218611abecf6df0f5aa288df51",
  ),
  entry(
    "0028",
    "enterprise_business_groups",
    "post_schema",
    "c5464c315a3a9903bdc520d1c9ae5f71f6e44d96c701d3968c6ab7f6f9c18477",
  ),
  entry(
    "0029",
    "business_group_entity_exclusivity",
    "post_schema",
    "aff14cfc4e3ddaceb7ef2fa5703e6d2ba379e3095b696a3a5b2615d3bb8d5c59",
  ),
  entry(
    "0030",
    "business_group_assignment_probe",
    "post_schema",
    "4fa1006fefb3acad7e5f0b119fabab32559f2b5b0b9cc5835272d2e9e4264697",
  ),
  entry(
    "0031",
    "flat_business_group_entities",
    "post_schema",
    "5bc952061d5fc9cb6b3e410de184752c40a0e420367afd3f96da6b9b7cd98326",
  ),
  entry(
    "0032",
    "reporting_projections",
    "post_schema",
    "e71c9b659c62634ddb941d712fa05d5e229f6e4c17630989ba0b8e43a670f348",
  ),
  entry(
    "0033",
    "projection_reconciliation",
    "post_schema",
    "a35f3d74ed53b92620584345917d33e0a71cd9dc54f9f2ce747a21cdc7f3ce63",
  ),
  entry(
    "0034",
    "business_group_admin_guards",
    "post_schema",
    "4da4f484d0bb6b92e04af94e9b892c6704141ee7d3b29cf18ef374c033dfb3c8",
  ),
  entry(
    "0035",
    "enterprise_stripe_billing",
    "post_schema",
    "18d5b86ac0824aee4aef8c7aff7be96d202810dcb8e96b787550e3793ffb5455",
  ),
  entry(
    "0036",
    "enterprise_checkout",
    "post_schema",
    "d3f86a77e1dc56129f18b1cdbe8d44c27e597432c6d0b2fb088661d8768f836f",
  ),
] as const;

export type MigrationId = (typeof migrationManifest)[number]["id"];

export type ManifestValidationResult = { ok: true } | { ok: false; reason: string };

export function isMigrationChecksum(value: string): boolean {
  return CHECKSUM_PATTERN.test(value);
}

export function validateMigrationManifest(
  manifest: readonly MigrationManifestEntry[],
): ManifestValidationResult {
  const ids = new Set<string>();
  const files = new Set<string>();
  const historyNames = new Set<string>();
  let previousId: string | null = null;

  for (const migration of manifest) {
    if (!MIGRATION_ID_PATTERN.test(migration.id)) {
      return { ok: false, reason: `Invalid migration id ${migration.id}` };
    }
    if (ids.has(migration.id)) {
      return { ok: false, reason: `Duplicate migration id ${migration.id}` };
    }
    if (previousId !== null && migration.id <= previousId) {
      return { ok: false, reason: `Migration ${migration.id} is out of order` };
    }
    if (
      !MIGRATION_FILE_PATTERN.test(migration.file) ||
      !migration.file.startsWith(`${migration.id}_`)
    ) {
      return {
        ok: false,
        reason: `Migration ${migration.id} has a mismatched filename`,
      };
    }
    if (files.has(migration.file)) {
      return {
        ok: false,
        reason: `Duplicate migration file ${migration.file}`,
      };
    }
    if (migration.historyAliases.length !== 1 || migration.historyAliases[0] !== migration.id) {
      return {
        ok: false,
        reason: `Migration ${migration.id} has an invalid history alias`,
      };
    }
    for (const name of [migration.file, ...migration.historyAliases]) {
      if (historyNames.has(name)) {
        return {
          ok: false,
          reason: `Migration ${migration.id} has a duplicate history alias`,
        };
      }
      historyNames.add(name);
    }
    if (!MIGRATION_PHASES.includes(migration.phase)) {
      return {
        ok: false,
        reason: `Migration ${migration.id} has an invalid phase`,
      };
    }
    if (!MIGRATION_EXECUTIONS.includes(migration.execution)) {
      return {
        ok: false,
        reason: `Migration ${migration.id} has an invalid execution mode`,
      };
    }
    if (!isMigrationChecksum(migration.checksum)) {
      return {
        ok: false,
        reason: `Migration ${migration.id} has an invalid SHA-256 checksum`,
      };
    }

    ids.add(migration.id);
    files.add(migration.file);
    previousId = migration.id;
  }

  return { ok: true };
}
