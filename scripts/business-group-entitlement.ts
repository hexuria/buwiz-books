import postgres, { type Row } from "postgres";

type Command = "status" | "provision" | "update";
type EntitlementStatus = "pending" | "active" | "grace" | "locked" | "cancelled";

interface CliOptions {
  command: Command;
  apply: boolean;
  allowStripeManaged: boolean;
  values: Map<string, string>;
}

const STATUS_VALUES = new Set<EntitlementStatus>([
  "pending",
  "active",
  "grace",
  "locked",
  "cancelled",
]);

function usage(): string {
  return `Enterprise Business Groups entitlement operations

Usage:
  bun run business-groups:entitlement status [--enterprise-account-id=<uuid>]

  bun run business-groups:entitlement provision \\
    --name=<holding-company> --owner-email=<email> --limit=<count> \\
    --starts-at=<ISO date> [--ends-at=<ISO date>] --reason=<text> [options] [--apply]

  bun run business-groups:entitlement update \\
    --enterprise-account-id=<uuid> --expected-version=<n> \\
    --status=<status> --limit=<count> --starts-at=<ISO date> \\
    --ends-at=<ISO date|none> --reason=<text> [options] [--apply]

Provision options:
  --billing-contact-email=<email>
  --external-customer-id=<id>

Write options:
  --actor-email=<email>       Audit actor; defaults to ADMIN_EMAIL.
  --apply                     Execute the transaction. Without it, writes are previews only.
  --allow-stripe-managed      Break-glass reconciliation of a Stripe-managed entitlement.

Statuses: pending, active, grace, locked, cancelled.

DATABASE_URL_ADMIN is required. The command prints the exact database target
before reading or writing. Provisioning requires existing owner and actor users.
`;
}

function parseOptions(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const command = argv[0] as Command | undefined;
  if (!command || !["status", "provision", "update"].includes(command)) {
    throw new Error("Choose one command: status, provision, or update. Use --help for examples.");
  }

  const values = new Map<string, string>();
  let apply = false;
  let allowStripeManaged = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--allow-stripe-managed") {
      allowStripeManaged = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const equalsAt = argument.indexOf("=");
    const key = argument.slice(2, equalsAt === -1 ? undefined : equalsAt);
    let value = equalsAt === -1 ? argv[index + 1] : argument.slice(equalsAt + 1);
    if (equalsAt === -1) index += 1;
    value = value?.trim();
    if (!key || !value || value.startsWith("--")) throw new Error(`--${key} requires a value.`);
    if (values.has(key)) throw new Error(`--${key} may be specified only once.`);
    values.set(key, value);
  }
  if (command === "status" && (apply || allowStripeManaged)) {
    throw new Error("status is read-only and does not accept write options.");
  }
  if (command === "provision" && allowStripeManaged) {
    throw new Error("--allow-stripe-managed is valid only for update reconciliation.");
  }
  return { command, apply, allowStripeManaged, values };
}

function rejectUnknown(options: CliOptions, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of options.values.keys()) {
    if (!allowedSet.has(key)) throw new Error(`Unknown ${options.command} option: --${key}`);
  }
}

function required(options: CliOptions, key: string): string {
  const value = options.values.get(key);
  if (!value) throw new Error(`--${key} is required for ${options.command}.`);
  return value;
}

function optional(options: CliOptions, key: string): string | null {
  return options.values.get(key) ?? null;
}

function positiveInteger(value: string, label: string, maximum = 100_000): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function isoDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid ISO date.`);
  return parsed;
}

function nullableIsoDate(value: string | null, label: string): Date | null {
  if (value === null || value.toLowerCase() === "none") return null;
  return isoDate(value, label);
}

function actorEmail(options: CliOptions): string {
  const value = optional(options, "actor-email") ?? process.env.ADMIN_EMAIL?.trim() ?? "";
  if (!value) throw new Error("--actor-email or ADMIN_EMAIL is required for entitlement writes.");
  return value.toLowerCase();
}

function graceEnd(endsAt: Date | null): Date | null {
  return endsAt ? new Date(endsAt.getTime() + 30 * 24 * 60 * 60 * 1000) : null;
}

async function databaseTarget(client: postgres.Sql): Promise<Row> {
  const [target] = await client`
    SELECT
      current_database() AS database,
      current_user AS username,
      coalesce(inet_server_addr()::text, 'local socket') AS host
  `;
  return target;
}

async function requireUser(client: postgres.Sql, email: string, label: string): Promise<Row> {
  const [record] = await client`
    SELECT id, email
    FROM auth_users
    WHERE lower(email) = lower(${email})
    LIMIT 1
  `;
  if (!record) throw new Error(`${label} ${email} does not have an existing user account.`);
  return record;
}

async function printStatus(
  client: postgres.Sql,
  enterpriseAccountId: string | null,
): Promise<void> {
  const rows = await client`
    SELECT
      account.id AS enterprise_account_id,
      account.name,
      account.status AS account_status,
      entitlement.status AS entitlement_status,
      entitlement.included_entity_limit,
      entitlement.starts_at,
      entitlement.ends_at,
      entitlement.grace_ends_at,
      entitlement.version,
      count(DISTINCT entity.organization_id) FILTER (WHERE entity.status = 'enabled')::integer
        AS linked_businesses
    FROM enterprise_accounts account
    LEFT JOIN account_entitlements entitlement
      ON entitlement.enterprise_account_id = account.id
     AND entitlement.feature_key = 'business_groups'
    LEFT JOIN organization_groups group_record
      ON group_record.enterprise_account_id = account.id
     AND group_record.status = 'active'
    LEFT JOIN organization_group_entities entity
      ON entity.group_id = group_record.id
    WHERE (${enterpriseAccountId}::uuid IS NULL OR account.id = ${enterpriseAccountId})
    GROUP BY account.id, entitlement.id
    ORDER BY account.name, account.id
  `;
  console.log(`Enterprise accounts: ${rows.length}`);
  console.table(
    rows.map((row) => ({
      accountId: row.enterprise_account_id,
      name: row.name,
      account: row.account_status,
      entitlement: row.entitlement_status ?? "missing",
      usage: `${row.linked_businesses ?? 0}/${row.included_entity_limit ?? 0}`,
      version: row.version ?? "—",
      startsAt: row.starts_at ?? "—",
      endsAt: row.ends_at ?? "—",
      graceEndsAt: row.grace_ends_at ?? "—",
    })),
  );
}

async function provision(client: postgres.Sql, options: CliOptions): Promise<void> {
  rejectUnknown(options, [
    "name",
    "owner-email",
    "billing-contact-email",
    "external-customer-id",
    "limit",
    "starts-at",
    "ends-at",
    "reason",
    "actor-email",
  ]);
  const name = required(options, "name");
  const ownerEmail = required(options, "owner-email").toLowerCase();
  const billingContactEmail =
    optional(options, "billing-contact-email")?.toLowerCase() ?? ownerEmail;
  const externalCustomerId = optional(options, "external-customer-id");
  const includedEntityLimit = positiveInteger(required(options, "limit"), "--limit");
  const startsAt = isoDate(required(options, "starts-at"), "--starts-at");
  const endsAt = nullableIsoDate(optional(options, "ends-at"), "--ends-at");
  const reason = required(options, "reason");
  const auditActorEmail = actorEmail(options);
  if (endsAt && endsAt <= startsAt) throw new Error("--ends-at must be after --starts-at.");

  const owner = await requireUser(client, ownerEmail, "Owner");
  const actor = await requireUser(client, auditActorEmail, "Audit actor");
  const storedStatus: EntitlementStatus = startsAt > new Date() ? "pending" : "active";
  const nextState = {
    status: storedStatus,
    includedEntityLimit,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt?.toISOString() ?? null,
    graceEndsAt: graceEnd(endsAt)?.toISOString() ?? null,
    version: 1,
  };
  console.table([{ name, owner: owner.email, actor: actor.email, ...nextState }]);
  if (!options.apply) {
    console.log("No data was changed. Re-run with --apply after reviewing this contract.");
    return;
  }

  const result = await client.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended('buwiz:enterprise-entitlement-provision', 0))
    `;
    const [account] = await transaction`
      INSERT INTO enterprise_accounts (
        name, billing_contact_email, external_customer_id, created_by
      ) VALUES (${name}, ${billingContactEmail}, ${externalCustomerId}, ${actor.id})
      RETURNING id
    `;
    await transaction`
      INSERT INTO enterprise_account_members (enterprise_account_id, user_id, role)
      VALUES (${account.id}, ${owner.id}, 'owner')
    `;
    const [entitlement] = await transaction`
      INSERT INTO account_entitlements (
        enterprise_account_id, feature_key, status, included_entity_limit,
        provisioning_source, starts_at, ends_at, grace_ends_at
      ) VALUES (
        ${account.id}, 'business_groups', ${storedStatus}, ${includedEntityLimit},
        'contract', ${startsAt}, ${endsAt}, ${graceEnd(endsAt)}
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO entitlement_events (
        enterprise_account_id, entitlement_id, actor_user_id, event_type,
        reason, previous_state, next_state
      ) VALUES (
        ${account.id}, ${entitlement.id}, ${actor.id}, 'entitlement.provisioned',
        ${reason}, NULL, ${JSON.stringify(nextState)}::jsonb
      )
    `;
    return { enterpriseAccountId: account.id, entitlementId: entitlement.id };
  });
  console.log(`Provisioned Enterprise account ${result.enterpriseAccountId}.`);
}

async function update(client: postgres.Sql, options: CliOptions): Promise<void> {
  rejectUnknown(options, [
    "enterprise-account-id",
    "expected-version",
    "status",
    "limit",
    "starts-at",
    "ends-at",
    "reason",
    "actor-email",
  ]);
  const enterpriseAccountId = required(options, "enterprise-account-id");
  const expectedVersion = positiveInteger(
    required(options, "expected-version"),
    "--expected-version",
  );
  const requestedStatus = required(options, "status") as EntitlementStatus;
  if (!STATUS_VALUES.has(requestedStatus))
    throw new Error(`Unsupported status: ${requestedStatus}.`);
  const includedEntityLimit = positiveInteger(required(options, "limit"), "--limit");
  const startsAt = isoDate(required(options, "starts-at"), "--starts-at");
  const endsAt = nullableIsoDate(required(options, "ends-at"), "--ends-at");
  const reason = required(options, "reason");
  const auditActorEmail = actorEmail(options);
  if (endsAt && endsAt <= startsAt) throw new Error("--ends-at must be after --starts-at.");

  const actor = await requireUser(client, auditActorEmail, "Audit actor");
  const [previous] = await client`
    SELECT entitlement.*, account.name AS account_name
    FROM account_entitlements entitlement
    JOIN enterprise_accounts account ON account.id = entitlement.enterprise_account_id
    WHERE entitlement.enterprise_account_id = ${enterpriseAccountId}
      AND entitlement.feature_key = 'business_groups'
    LIMIT 1
  `;
  if (!previous) throw new Error("Enterprise Business Groups entitlement was not found.");
  if (previous.provisioning_source === "stripe" && !options.allowStripeManaged) {
    throw new Error(
      "This entitlement is Stripe-managed. Use --allow-stripe-managed only for an audited break-glass reconciliation.",
    );
  }
  if (Number(previous.version) !== expectedVersion) {
    throw new Error(
      `Expected version ${expectedVersion}, but the database is at ${previous.version}.`,
    );
  }
  const nextState = {
    status: requestedStatus,
    includedEntityLimit,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt?.toISOString() ?? null,
    graceEndsAt: graceEnd(endsAt)?.toISOString() ?? null,
    version: expectedVersion + 1,
    provisioningSource: previous.provisioning_source,
    stripeManagedOverride: previous.provisioning_source === "stripe" && options.allowStripeManaged,
    overrideSource:
      previous.provisioning_source === "stripe" && options.allowStripeManaged ? "manual_cli" : null,
  };
  console.table([
    {
      accountId: enterpriseAccountId,
      account: previous.account_name,
      actor: actor.email,
      fromStatus: previous.status,
      fromLimit: previous.included_entity_limit,
      fromVersion: previous.version,
      toStatus: nextState.status,
      toLimit: nextState.includedEntityLimit,
      toVersion: nextState.version,
    },
  ]);
  if (!options.apply) {
    console.log("No data was changed. Re-run with --apply after reviewing this contract change.");
    return;
  }

  await client.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${`buwiz:enterprise-entitlement:${enterpriseAccountId}`}, 0))
    `;
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${`business-groups:${enterpriseAccountId}`}, 0))
    `;
    const [locked] = await transaction`
      SELECT * FROM account_entitlements
      WHERE id = ${previous.id}
      FOR UPDATE
    `;
    if (!locked || Number(locked.version) !== expectedVersion) {
      throw new Error("Enterprise entitlement changed after preview; reload status and retry.");
    }
    if (locked.provisioning_source === "stripe" && !options.allowStripeManaged) {
      throw new Error(
        "This entitlement became Stripe-managed after preview. Reload status; break-glass reconciliation requires --allow-stripe-managed.",
      );
    }
    const stripeManagedOverride =
      locked.provisioning_source === "stripe" && options.allowStripeManaged;
    const overrideSource = stripeManagedOverride ? "manual_cli" : null;
    const previousState = {
      status: locked.status,
      includedEntityLimit: locked.included_entity_limit,
      startsAt: new Date(locked.starts_at).toISOString(),
      endsAt: locked.ends_at ? new Date(locked.ends_at).toISOString() : null,
      graceEndsAt: locked.grace_ends_at ? new Date(locked.grace_ends_at).toISOString() : null,
      version: Number(locked.version),
      provisioningSource: locked.provisioning_source,
      stripeManagedOverride,
      overrideSource,
    };
    const auditedNextState = {
      ...nextState,
      provisioningSource: locked.provisioning_source,
      stripeManagedOverride,
      overrideSource,
    };
    const [changed] = await transaction`
      UPDATE account_entitlements
      SET status = ${requestedStatus},
          included_entity_limit = ${includedEntityLimit},
          starts_at = ${startsAt},
          ends_at = ${endsAt},
          grace_ends_at = ${graceEnd(endsAt)},
          version = version + 1,
          updated_at = now()
      WHERE id = ${locked.id} AND version = ${expectedVersion}
      RETURNING id, version
    `;
    if (!changed) throw new Error("Enterprise entitlement update conflicted; reload and retry.");
    await transaction`
      INSERT INTO entitlement_events (
        enterprise_account_id, entitlement_id, actor_user_id, event_type,
        reason, previous_state, next_state
      ) VALUES (
        ${enterpriseAccountId}, ${locked.id}, ${actor.id}, ${
          stripeManagedOverride
            ? "entitlement.stripe_break_glass_reconciled"
            : "entitlement.updated"
        },
        ${reason}, ${JSON.stringify(previousState)}::jsonb, ${JSON.stringify(auditedNextState)}::jsonb
      )
    `;
  });
  console.log(
    `Updated Enterprise account ${enterpriseAccountId} to entitlement version ${nextState.version}.`,
  );
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL_ADMIN;
  if (!connectionString)
    throw new Error("DATABASE_URL_ADMIN is required for entitlement operations.");

  const client = postgres(connectionString, { max: 1, prepare: false });
  try {
    const target = await databaseTarget(client);
    console.log(`Target: ${target.database} as ${target.username} (${target.host})`);
    console.log(`Mode: ${options.apply ? "APPLY" : "READ ONLY / PREVIEW"}\n`);
    if (options.command === "status") {
      rejectUnknown(options, ["enterprise-account-id"]);
      await printStatus(client, optional(options, "enterprise-account-id"));
    } else if (options.command === "provision") {
      await provision(client, options);
    } else {
      await update(client, options);
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
