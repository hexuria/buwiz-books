import { describe, expect, it } from "vitest";
import {
  catalogHasAnyFootprint,
  truncatePgIdentifier,
  createEmptyCatalogSnapshot,
  readCatalogSnapshot,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
} from "@/lib/migrations/verifiers/catalog";

function emptySnapshot(): CatalogSnapshot {
  return createEmptyCatalogSnapshot();
}

function expectComplete(snapshot: CatalogSnapshot, expected: CatalogExpectation) {
  expect(verifyCatalog(snapshot, expected)).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "pass" })]),
  );
  expect(verifyCatalog(snapshot, expected).filter((check) => check.status === "fail")).toEqual([]);
}

describe("PostgreSQL catalog verifier", () => {
  it("loads every catalog category from one consistent snapshot query", async () => {
    const unsafe = async (sql: string) => {
      expect(sql).toContain("WITH");
      expect(sql).toContain("pg_attribute");
      expect(sql).toContain("pg_index");
      expect(sql).toContain("pg_constraint");
      expect(sql).toContain("pg_policies");
      expect(sql).toContain("pg_trigger");
      expect(sql).toContain("aclexplode");
      expect(sql).toContain("pg_default_acl");
      expect(sql).toContain("pg_roles");
      return [
        {
          snapshot: {
            schemas: [{ name: "public", owner: "migration_owner" }],
            relations: [
              {
                name: "widgets",
                kind: "table",
                owner: "migration_owner",
                rls: true,
                forceRls: false,
              },
            ],
            columns: [
              {
                table_name: "widgets",
                name: "id",
                position: 1,
                type: "uuid",
                notNull: true,
                defaultExpression: "gen_random_uuid()",
                identity: "none",
                generated: "none",
              },
            ],
            indexes: [],
            constraints: [],
            policies: [],
            functions: [],
            triggers: [],
            extensions: [{ name: "pg_trgm" }],
            enums: [{ name: "journal_source", values: ["manual", "document"] }],
            privileges: [],
            defaultPrivileges: [],
            roles: [],
          },
        },
      ];
    };

    const snapshot = await readCatalogSnapshot({ unsafe } as never);

    expect(snapshot.schemas.get("public")?.owner).toBe("migration_owner");
    expect(snapshot.relations.get("widgets")?.columns).toEqual([
      expect.objectContaining({ name: "id", type: "uuid" }),
    ]);
    expect(snapshot.extensions.has("pg_trgm")).toBe(true);
    expect(snapshot.enums.get("journal_source")).toEqual(["manual", "document"]);
  });

  it("rejects a same-named table whose exact column or RLS shape drifted", () => {
    const snapshot = emptySnapshot();
    snapshot.relations.set("widgets", {
      name: "widgets",
      kind: "table",
      owner: "migration_owner",
      rls: true,
      forceRls: true,
      columns: [
        {
          name: "id",
          position: 1,
          type: "uuid",
          notNull: true,
          defaultExpression: "gen_random_uuid()",
          identity: "none",
          generated: "none",
        },
        {
          name: "amount",
          position: 2,
          type: "numeric(20,8)",
          notNull: true,
          defaultExpression: "0.00000000",
          identity: "none",
          generated: "none",
        },
      ],
    });
    const expected = {
      relations: [
        {
          name: "widgets",
          kind: "table",
          owner: "migration_owner",
          rls: true,
          forceRls: true,
          columns: [
            {
              name: "id",
              type: "uuid",
              notNull: true,
              defaultExpression: "gen_random_uuid()",
              identity: "none",
              generated: "none",
            },
            {
              name: "amount",
              type: "numeric(20,8)",
              notNull: true,
              defaultExpression: "0.00000000",
              identity: "none",
              generated: "none",
            },
          ],
        },
      ],
    } satisfies CatalogExpectation;

    expectComplete(snapshot, expected);

    snapshot.relations.get("widgets")!.columns[1] = {
      ...snapshot.relations.get("widgets")!.columns[1],
      type: "double precision",
    };
    expect(verifyCatalog(snapshot, expected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "column:widgets.amount:type",
          status: "fail",
        }),
      ]),
    );

    snapshot.relations.get("widgets")!.columns[1] = {
      ...snapshot.relations.get("widgets")!.columns[1],
      type: "numeric(20,8)",
    };
    snapshot.relations.get("widgets")!.forceRls = false;
    expect(verifyCatalog(snapshot, expected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "relation:widgets:force-rls",
          status: "fail",
        }),
      ]),
    );
  });

  it("compares index and foreign-key semantics rather than names", () => {
    const snapshot = emptySnapshot();
    snapshot.indexes.set("widgets_org_code_unique", {
      tableName: "widgets",
      name: "widgets_org_code_unique",
      unique: true,
      primary: false,
      valid: true,
      ready: true,
      accessMethod: "btree",
      keyExpressions: ["organization_id", "code DESC"],
      includeExpressions: ["updated_at"],
      predicate: "deleted_at IS NULL",
      definition:
        "CREATE UNIQUE INDEX widgets_org_code_unique ON public.widgets USING btree (organization_id, code DESC) INCLUDE (updated_at) WHERE (deleted_at IS NULL)",
    });
    snapshot.constraints.set("widgets.widgets_organization_id_fk", {
      tableName: "widgets",
      name: "widgets_organization_id_fk",
      type: "foreign_key",
      columns: ["organization_id"],
      referencedSchema: "public",
      referencedTable: "auth_organizations",
      referencedColumns: ["id"],
      matchType: "simple",
      onUpdate: "no_action",
      onDelete: "cascade",
      deferrable: true,
      initiallyDeferred: true,
      validated: true,
      definition:
        "FOREIGN KEY (organization_id) REFERENCES auth_organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED",
    });
    const expected = {
      indexes: [
        {
          name: "widgets_org_code_unique",
          tableName: "widgets",
          unique: true,
          primary: false,
          valid: true,
          ready: true,
          accessMethod: "btree",
          keyExpressions: ["organization_id", "code DESC"],
          includeExpressions: ["updated_at"],
          predicate: "deleted_at IS NULL",
        },
      ],
      constraints: [
        {
          tableName: "widgets",
          name: "widgets_organization_id_fk",
          type: "foreign_key",
          columns: ["organization_id"],
          referencedSchema: "public",
          referencedTable: "auth_organizations",
          referencedColumns: ["id"],
          matchType: "simple",
          onUpdate: "no_action",
          onDelete: "cascade",
          deferrable: true,
          initiallyDeferred: true,
          validated: true,
        },
      ],
    } satisfies CatalogExpectation;

    expectComplete(snapshot, expected);
    snapshot.indexes.get("widgets_org_code_unique")!.unique = false;
    snapshot.constraints.get("widgets.widgets_organization_id_fk")!.onDelete = "restrict";
    expect(verifyCatalog(snapshot, expected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "index:widgets_org_code_unique:unique",
          status: "fail",
        }),
        expect.objectContaining({
          key: "constraint:widgets.widgets_organization_id_fk:on-delete",
          status: "fail",
        }),
      ]),
    );
  });

  it("compares index opclasses embedded in key expressions", () => {
    const snapshot = emptySnapshot();
    snapshot.indexes.set("vendor_aliases_descriptor_trgm_idx", {
      tableName: "vendor_aliases",
      name: "vendor_aliases_descriptor_trgm_idx",
      unique: false,
      primary: false,
      valid: true,
      ready: true,
      accessMethod: "gin",
      keyExpressions: ["normalized_descriptor gin_trgm_ops"],
      includeExpressions: [],
      predicate: null,
      definition:
        "CREATE INDEX vendor_aliases_descriptor_trgm_idx ON public.vendor_aliases USING gin (normalized_descriptor gin_trgm_ops)",
    });
    const expected = {
      indexes: [
        {
          name: "vendor_aliases_descriptor_trgm_idx",
          tableName: "vendor_aliases",
          unique: false,
          accessMethod: "gin",
          keyExpressions: ["normalized_descriptor gin_trgm_ops"],
          includeExpressions: [],
          predicate: null,
        },
      ],
    } satisfies CatalogExpectation;

    expectComplete(snapshot, expected);
    snapshot.indexes.get("vendor_aliases_descriptor_trgm_idx")!.keyExpressions = [
      "normalized_descriptor text_ops",
    ];
    expect(verifyCatalog(snapshot, expected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "index:vendor_aliases_descriptor_trgm_idx:keys",
          status: "fail",
        }),
      ]),
    );
  });

  it("supports exact and additive enum value contracts", () => {
    const snapshot = emptySnapshot();
    snapshot.enums.set("journal_source", ["manual", "document", "email"]);

    expectComplete(snapshot, {
      enums: [{ name: "journal_source", values: ["document", "email"] }],
    });
    expect(
      verifyCatalog(snapshot, {
        enums: [
          {
            name: "journal_source",
            values: ["manual", "document", "email"],
            exact: true,
          },
        ],
      }).filter((check) => check.status === "fail"),
    ).toEqual([]);
    expect(
      verifyCatalog(snapshot, {
        enums: [{ name: "journal_source", values: ["payment"] }],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "enum:journal_source:values",
          status: "fail",
        }),
      ]),
    );
  });

  it("compares policy, function, and trigger definitions exactly", () => {
    const snapshot = emptySnapshot();
    snapshot.policies.set("widgets.org_isolation_widgets", {
      tableName: "widgets",
      name: "org_isolation_widgets",
      permissive: true,
      roles: ["app_runtime"],
      command: "all",
      using: "organization_id = current_organization_id()",
      withCheck: "organization_id = current_organization_id()",
    });
    snapshot.functions.set("current_organization_id()", {
      identity: "current_organization_id()",
      resultType: "text",
      language: "sql",
      volatility: "stable",
      strict: false,
      securityDefiner: true,
      parallel: "unsafe",
      body: "SELECT current_setting('app.current_organization_id', true)",
      definition: "CREATE FUNCTION current_organization_id() RETURNS text ...",
      config: ["search_path=pg_catalog, public, pg_temp"],
      owner: "migration_owner",
    });
    snapshot.triggers.set("widgets.widgets_audit", {
      identity: "widgets.widgets_audit",
      tableName: "widgets",
      name: "widgets_audit",
      enabled: "origin",
      level: "row",
      timing: "after",
      events: ["insert", "update"],
      functionSchema: "public",
      functionIdentity: "record_widget_audit()",
      when: "new.deleted_at IS NULL",
      oldTable: null,
      newTable: null,
      constraint: false,
      deferrable: false,
      initiallyDeferred: false,
      definition:
        "CREATE TRIGGER widgets_audit AFTER INSERT OR UPDATE ON widgets FOR EACH ROW WHEN ((new.deleted_at IS NULL)) EXECUTE FUNCTION record_widget_audit()",
    });
    const expected = {
      policies: [
        {
          tableName: "widgets",
          name: "org_isolation_widgets",
          permissive: true,
          roles: ["app_runtime"],
          command: "all",
          using: "organization_id = current_organization_id()",
          withCheck: "organization_id = current_organization_id()",
        },
      ],
      functions: [
        {
          identity: "current_organization_id()",
          resultType: "text",
          language: "sql",
          volatility: "stable",
          strict: false,
          securityDefiner: true,
          parallel: "unsafe",
          body: "SELECT current_setting('app.current_organization_id', true)",
          searchPath: ["pg_catalog", "public", "pg_temp"],
          owner: "migration_owner",
        },
      ],
      triggers: [
        {
          tableName: "widgets",
          name: "widgets_audit",
          enabled: "origin",
          level: "row",
          timing: "after",
          events: ["insert", "update"],
          functionSchema: "public",
          functionIdentity: "record_widget_audit()",
          when: "new.deleted_at IS NULL",
          constraint: false,
          deferrable: false,
          initiallyDeferred: false,
        },
      ],
    } satisfies CatalogExpectation;

    expectComplete(snapshot, expected);
    snapshot.policies.get("widgets.org_isolation_widgets")!.command = "select";
    snapshot.functions.get("current_organization_id()")!.volatility = "volatile";
    snapshot.triggers.get("widgets.widgets_audit")!.functionSchema = "shadow";
    snapshot.triggers.get("widgets.widgets_audit")!.timing = "before";
    expect(verifyCatalog(snapshot, expected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "policy:widgets.org_isolation_widgets:command",
          status: "fail",
        }),
        expect.objectContaining({
          key: "function:current_organization_id():volatility",
          status: "fail",
        }),
        expect.objectContaining({
          key: "trigger:widgets.widgets_audit:function-schema",
          status: "fail",
        }),
        expect.objectContaining({
          key: "trigger:widgets.widgets_audit:timing",
          status: "fail",
        }),
      ]),
    );
  });

  it("normalizes SQL formatting without changing quoted literal contents", () => {
    const snapshot = emptySnapshot();
    snapshot.functions.set("literal_contract()", {
      identity: "literal_contract()",
      resultType: "text",
      language: "sql",
      volatility: "immutable",
      strict: false,
      securityDefiner: false,
      parallel: "safe",
      body: "SELECT  'two  spaces'",
      definition: "CREATE FUNCTION literal_contract() RETURNS text",
      config: null,
      owner: "migration_owner",
    });
    const expected = {
      functions: [
        {
          identity: "literal_contract()",
          body: "SELECT 'two  spaces'",
        },
      ],
    } satisfies CatalogExpectation;

    expectComplete(snapshot, expected);
    snapshot.functions.get("literal_contract()")!.body = "SELECT 'two spaces'";
    expect(verifyCatalog(snapshot, expected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "function:literal_contract():body",
          status: "fail",
        }),
      ]),
    );
  });

  it("verifies object ACLs, default ACLs, schema ownership, and role attributes", () => {
    const snapshot = emptySnapshot();
    snapshot.schemas.set("public", {
      name: "public",
      owner: "migration_owner",
    });
    snapshot.privileges.push({
      objectType: "table",
      objectIdentity: "widgets",
      grantor: "migration_owner",
      grantee: "app_runtime",
      privilege: "SELECT",
      grantable: false,
    });
    snapshot.defaultPrivileges.push({
      owner: "migration_owner",
      schema: "public",
      objectType: "table",
      grantor: "migration_owner",
      grantee: "app_runtime",
      privilege: "SELECT",
      grantable: false,
    });
    snapshot.roles.set("app_runtime", {
      name: "app_runtime",
      superuser: false,
      inherit: true,
      createRole: false,
      createDb: false,
      canLogin: true,
      replication: false,
      bypassRls: false,
    });
    const expected = {
      schemas: [{ name: "public", owner: "migration_owner" }],
      privileges: [
        {
          objectType: "table",
          objectIdentity: "widgets",
          grantee: "app_runtime",
          privilege: "SELECT",
          grantable: false,
        },
        {
          objectType: "table",
          objectIdentity: "widgets",
          grantee: "PUBLIC",
          privilege: "INSERT",
          present: false,
        },
      ],
      defaultPrivileges: [
        {
          owner: "migration_owner",
          schema: "public",
          objectType: "table",
          grantee: "app_runtime",
          privilege: "SELECT",
          grantable: false,
        },
      ],
      roles: [
        {
          name: "app_runtime",
          superuser: false,
          inherit: true,
          createRole: false,
          createDb: false,
          canLogin: true,
          replication: false,
          bypassRls: false,
        },
      ],
    } satisfies CatalogExpectation;

    expectComplete(snapshot, expected);
    snapshot.roles.get("app_runtime")!.bypassRls = true;
    snapshot.privileges[0] = { ...snapshot.privileges[0], grantable: true };
    expect(verifyCatalog(snapshot, expected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "role:app_runtime:bypass-rls",
          status: "fail",
        }),
        expect.objectContaining({
          key: "privilege:table:widgets:app_runtime:SELECT:grantable",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects a grantable duplicate behind each required non-grantable ACL", () => {
    const snapshot = emptySnapshot();
    snapshot.privileges.push(
      {
        objectType: "table",
        objectIdentity: "widgets",
        grantor: "migration_owner",
        grantee: "app_runtime",
        privilege: "SELECT",
        grantable: false,
      },
      {
        objectType: "table",
        objectIdentity: "widgets",
        grantor: "migration_owner",
        grantee: "app_runtime",
        privilege: "SELECT",
        grantable: true,
      },
    );
    snapshot.defaultPrivileges.push(
      {
        owner: "migration_owner",
        schema: "public",
        objectType: "table",
        grantor: "migration_owner",
        grantee: "app_runtime",
        privilege: "SELECT",
        grantable: false,
      },
      {
        owner: "migration_owner",
        schema: "public",
        objectType: "table",
        grantor: "migration_owner",
        grantee: "app_runtime",
        privilege: "SELECT",
        grantable: true,
      },
    );

    const checks = verifyCatalog(snapshot, {
      privileges: [
        {
          objectType: "table",
          objectIdentity: "widgets",
          grantee: "app_runtime",
          privilege: "SELECT",
          grantable: false,
        },
      ],
      defaultPrivileges: [
        {
          owner: "migration_owner",
          schema: "public",
          objectType: "table",
          grantee: "app_runtime",
          privilege: "SELECT",
          grantable: false,
        },
      ],
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "privilege:table:widgets:app_runtime:SELECT:grantable",
          status: "fail",
        }),
        expect.objectContaining({
          key: "default-privilege:migration_owner:public:table:app_runtime:SELECT:grantable",
          status: "fail",
        }),
      ]),
    );
  });

  it("detects an object ACL-only footprint by exact identity", () => {
    const snapshot = emptySnapshot();
    snapshot.privileges.push({
      objectType: "table",
      objectIdentity: "widgets",
      grantor: "migration_owner",
      grantee: "PUBLIC",
      privilege: "SELECT",
      grantable: false,
    });

    expect({
      matchingForbiddenGrant: catalogHasAnyFootprint(snapshot, {
        privileges: [
          {
            objectType: "table",
            objectIdentity: "widgets",
            grantor: "migration_owner",
            grantee: "PUBLIC",
            privilege: "SELECT",
            grantable: true,
            present: false,
          },
        ],
      }),
      wrongGrantor: catalogHasAnyFootprint(snapshot, {
        privileges: [
          {
            objectType: "table",
            objectIdentity: "widgets",
            grantor: "other_owner",
            grantee: "PUBLIC",
            privilege: "SELECT",
          },
        ],
      }),
    }).toEqual({ matchingForbiddenGrant: true, wrongGrantor: false });
  });

  it("detects a default ACL-only footprint by exact identity", () => {
    const snapshot = emptySnapshot();
    snapshot.defaultPrivileges.push({
      owner: "migration_owner",
      schema: "public",
      objectType: "table",
      grantor: "migration_owner",
      grantee: "app_runtime",
      privilege: "SELECT",
      grantable: false,
    });

    expect({
      matchingForbiddenGrant: catalogHasAnyFootprint(snapshot, {
        defaultPrivileges: [
          {
            owner: "migration_owner",
            schema: "public",
            objectType: "table",
            grantor: "migration_owner",
            grantee: "app_runtime",
            privilege: "SELECT",
            grantable: true,
            present: false,
          },
        ],
      }),
      wrongSchema: catalogHasAnyFootprint(snapshot, {
        defaultPrivileges: [
          {
            owner: "migration_owner",
            schema: null,
            objectType: "table",
            grantee: "app_runtime",
            privilege: "SELECT",
          },
        ],
      }),
    }).toEqual({ matchingForbiddenGrant: true, wrongSchema: false });
  });

  it("detects an existing forbidden role as a role-only footprint", () => {
    const snapshot = emptySnapshot();
    snapshot.roles.set("app_worker", {
      name: "app_worker",
      superuser: false,
      inherit: true,
      createRole: false,
      createDb: false,
      canLogin: true,
      replication: false,
      bypassRls: false,
    });

    const forbiddenRole = {
      superuser: true,
      inherit: false,
      createRole: true,
      createDb: true,
      canLogin: false,
      replication: true,
      bypassRls: true,
      present: false,
    } as const;

    expect({
      matchingForbiddenRole: catalogHasAnyFootprint(snapshot, {
        roles: [{ name: "app_worker", ...forbiddenRole }],
      }),
      wrongName: catalogHasAnyFootprint(snapshot, {
        roles: [{ name: "other_worker", ...forbiddenRole }],
      }),
    }).toEqual({ matchingForbiddenRole: true, wrongName: false });
  });
});

describe("identifiers PostgreSQL cannot store verbatim", () => {
  const LONG_FK = "enterprise_account_members_enterprise_account_id_enterprise_accounts_id_fk";

  it("truncates to 63 bytes the way NAMEDATALEN does", () => {
    expect(LONG_FK.length).toBe(74);
    expect(truncatePgIdentifier(LONG_FK)).toHaveLength(63);
    expect(truncatePgIdentifier("short_name")).toBe("short_name");
    // Byte-counted, not character-counted, and never split into invalid UTF-8.
    const multibyte = "é".repeat(40);
    expect(Buffer.from(truncatePgIdentifier(multibyte), "utf8").length).toBeLessThanOrEqual(63);
  });

  it("finds a constraint the catalog stored under its truncated name", () => {
    const snapshot = createEmptyCatalogSnapshot();
    const truncated = truncatePgIdentifier(LONG_FK);
    snapshot.constraints.set(`enterprise_account_members.${truncated}`, {
      name: truncated,
      tableName: "enterprise_account_members",
      type: "foreign_key",
      columns: ["enterprise_account_id"],
      referencedSchema: "public",
      referencedTable: "enterprise_accounts",
      referencedColumns: ["id"],
      matchType: "simple",
      onUpdate: "no_action",
      onDelete: "cascade",
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      definition: "FOREIGN KEY (enterprise_account_id) REFERENCES enterprise_accounts(id)",
    });

    // The expectation carries the full 74-character name, as every verifier does.
    const checks = verifyCatalog(snapshot, {
      constraints: [
        {
          tableName: "enterprise_account_members",
          name: LONG_FK,
          type: "foreign_key",
        },
      ],
    });

    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("still reports a genuinely absent constraint as absent", () => {
    const checks = verifyCatalog(createEmptyCatalogSnapshot(), {
      constraints: [
        { tableName: "enterprise_account_members", name: LONG_FK, type: "foreign_key" },
      ],
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `constraint:enterprise_account_members.${LONG_FK}`,
          status: "fail",
        }),
      ]),
    );
  });
});

describe("primary keys resolved by table rather than name", () => {
  function tableWithPrimaryKey(constraintName: string): CatalogSnapshot {
    const snapshot = createEmptyCatalogSnapshot();
    snapshot.constraints.set(`organization_daily_account_activity.${constraintName}`, {
      name: constraintName,
      tableName: "organization_daily_account_activity",
      type: "primary_key",
      columns: ["organization_id", "activity_date", "account_id"],
      referencedSchema: null,
      referencedTable: null,
      referencedColumns: [],
      matchType: null,
      onUpdate: null,
      onDelete: null,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      definition: "PRIMARY KEY (organization_id, activity_date, account_id)",
    });
    return snapshot;
  }

  const expectation: CatalogExpectation = {
    constraints: [
      {
        tableName: "organization_daily_account_activity",
        name: "organization_daily_account_activity_pkey",
        type: "primary_key",
        columns: ["organization_id", "activity_date", "account_id"],
      },
    ],
  };

  it.each([
    ["the name the immutable SQL produces", "organization_daily_account_activity_pkey"],
    [
      "the name a Drizzle primaryKey({ columns }) produces",
      "organization_daily_account_activity_organization_id_activity_date_account_id_pk",
    ],
  ])("accepts %s", (_label, storedName) => {
    const checks = verifyCatalog(tableWithPrimaryKey(storedName), expectation);
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("still reports a table with no primary key at all", () => {
    const checks = verifyCatalog(createEmptyCatalogSnapshot(), expectation);
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: "fail" })]));
  });

  it("does not let the fallback rescue a non-primary-key constraint", () => {
    // The fallback is scoped to primary keys, where a table has at most one.
    const checks = verifyCatalog(tableWithPrimaryKey("some_other_pkey"), {
      constraints: [
        {
          tableName: "organization_daily_account_activity",
          name: "organization_daily_account_activity_org_fk",
          type: "foreign_key",
        },
      ],
    });
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: "fail" })]));
  });
});
