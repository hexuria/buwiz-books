import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  createDestructiveE2EDatabaseTarget,
  createIntegrationDatabaseTarget,
  createLiveEvalDatabaseTarget,
  createMigrationDatabaseTarget,
  createRuntimeDatabaseTarget,
  createWorkerDatabaseTarget,
} from "@/lib/database-target";
import {
  getDisposableResetPostgresOptions,
  getPostgresOptionsForDatabaseTarget,
} from "@/lib/database-target-internal";

describe("database target contract", () => {
  it("keeps credentials private while producing explicit postgres options", () => {
    const target = createRuntimeDatabaseTarget(
      "postgresql://CaseUser:p%40ssword@DB.Example.com:5432/Books?sslmode=verify-full",
    );

    expect(target).toEqual({
      purpose: "runtime",
      databaseName: "Books",
      redactedIdentity: expect.stringContaining("runtime:Books"),
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect("password" in target).toBe(false);
    expect("username" in target).toBe(false);
    expect("host" in target).toBe(false);
    expect(target.redactedIdentity).not.toContain("ssword");

    const options = getPostgresOptionsForDatabaseTarget(target, "runtime");

    expect(options).toMatchObject({
      host: "db.example.com",
      port: 5432,
      database: "Books",
      username: "CaseUser",
      ssl: "verify-full",
      connection: { application_name: "buwiz-books-runtime" },
    });
    expect(options.password?.()).toBe("p@ssword");
  });

  it("supports the Cloud SQL empty-authority socket form", () => {
    const target = createMigrationDatabaseTarget(
      "postgresql://MigrationUser:secret@/Books?host=%2Fcloudsql%2Fproject%3Aus-central1%3Ainstance",
    );

    const options = getPostgresOptionsForDatabaseTarget(target, "migration");

    expect(options).toMatchObject({
      host: "localhost",
      port: 5432,
      path: "/cloudsql/project:us-central1:instance/.s.PGSQL.5432",
      database: "Books",
      username: "MigrationUser",
      ssl: false,
      connection: { application_name: "buwiz-books-migration" },
    });
    expect(options.password?.()).toBe("secret");
  });

  it("uses a locally validated CA without passing sslrootcert through", () => {
    const ca = rootCertificates[0];
    const target = createWorkerDatabaseTarget(
      "postgresql://worker@db.example.com/Books?sslmode=verify-full",
      { ca },
    );

    const options = getPostgresOptionsForDatabaseTarget(target, "worker");

    expect(options.ssl).toEqual({ ca, rejectUnauthorized: true });
  });

  it("makes passwordless connections independent of ambient PGPASSWORD", () => {
    const previous = process.env.PGPASSWORD;
    process.env.PGPASSWORD = "ambient-secret";

    try {
      const target = createIntegrationDatabaseTarget(
        "postgresql://integration@127.0.0.1:5432/buwiz-tests",
      );
      const options = getPostgresOptionsForDatabaseTarget(target, "integration");

      expect(options.password?.()).toBe("");
    } finally {
      if (previous === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = previous;
    }
  });

  it("accepts each named non-destructive policy on a loopback target", () => {
    expect(createRuntimeDatabaseTarget("postgresql://u@127.0.0.1/db").purpose).toBe("runtime");
    expect(createWorkerDatabaseTarget("postgresql://u@127.0.0.1/db").purpose).toBe("worker");
    expect(createMigrationDatabaseTarget("postgresql://u@127.0.0.1/db").purpose).toBe("migration");
    expect(createIntegrationDatabaseTarget("postgresql://u@127.0.0.1/db").purpose).toBe(
      "integration",
    );
    expect(createLiveEvalDatabaseTarget("postgresql://u@127.0.0.1/db").purpose).toBe("live-eval");
  });

  it("requires a disposable loopback database and an exact confirmation token", () => {
    const target = createDestructiveE2EDatabaseTarget(
      "postgresql://e2e@127.0.0.1:3211/buwiz_e2e_lane_a",
      "buwiz_e2e_lane_a",
    );

    expect(target.purpose).toBe("destructive-e2e");
    expect(getDisposableResetPostgresOptions(target).database).toBe("buwiz_e2e_lane_a");
    expect(() => getPostgresOptionsForDatabaseTarget(target, "runtime")).toThrow(/purpose/i);
  });

  it("rejects forged, cloned, proxied, and wrong-purpose targets before options are built", () => {
    const target = createRuntimeDatabaseTarget("postgresql://u@127.0.0.1:5432/db");

    expect(() => getPostgresOptionsForDatabaseTarget({ ...target }, "runtime")).toThrow(
      /provenance|target/i,
    );
    expect(() => getPostgresOptionsForDatabaseTarget(new Proxy(target, {}), "runtime")).toThrow(
      /provenance|target/i,
    );
    expect(() => getPostgresOptionsForDatabaseTarget(target, "worker")).toThrow(/purpose/i);
    expect(() => getDisposableResetPostgresOptions(target)).toThrow(/disposable|reset|target/i);
  });

  it.each([
    ["wrong scheme", "postgres://u@127.0.0.1/db"],
    ["missing username", "postgresql://127.0.0.1/db"],
    ["malformed escape", "postgresql://u@127.0.0.1/db%2"],
    ["fragment", "postgresql://u@127.0.0.1/db#fragment"],
    ["duplicate query", "postgresql://u@127.0.0.1/db?sslmode=disable&sslmode=disable"],
    ["unknown query", "postgresql://u@127.0.0.0/db?application_name=unsafe"],
    [
      "sslrootcert passthrough",
      "postgresql://u@db.example.com/db?sslmode=verify-full&sslrootcert=system",
    ],
    ["remote TLS missing", "postgresql://u@db.example.com/db"],
    ["remote insecure TLS", "postgresql://u@db.example.com/db?sslmode=require"],
    ["localhost alias", "postgresql://u@localhost/db?sslmode=verify-full"],
    ["private IP", "postgresql://u@192.168.1.20/db"],
    ["public IP", "postgresql://u@8.8.8.8/db?sslmode=verify-full"],
    ["odd IPv4", "postgresql://u@127.1/db"],
    ["mapped IPv4", "postgresql://u@[::ffff:127.0.0.1]/db"],
    ["multihost", "postgresql://u@db-a.example.com,db-b.example.com/db?sslmode=verify-full"],
    ["invalid port", "postgresql://u@127.0.0.1:65536/db"],
    ["authority/query port ambiguity", "postgresql://u@127.0.0.1:5432/db?port=5433"],
    ["relative socket", "postgresql://u@/db?host=relative/socket"],
    ["non-canonical socket", "postgresql://u@/db?host=%2Ftmp%2F..%2Fsocket"],
    ["missing socket host", "postgresql://u@/db"],
  ])("rejects %s", (_label, raw) => {
    expect(() => createRuntimeDatabaseTarget(raw)).toThrow();
  });

  it("rejects overlong identifiers and disposable policy violations", () => {
    const overlong = "a".repeat(64);

    expect(() => createRuntimeDatabaseTarget(`postgresql://u@127.0.0.1/${overlong}`)).toThrow(/63/);
    expect(() =>
      createDestructiveE2EDatabaseTarget(
        "postgresql://u@127.0.0.1/buwiz_e2e_lane_a",
        "buwiz_e2e_lane_b",
      ),
    ).toThrow(/confirmation|match/i);
    expect(() =>
      createDestructiveE2EDatabaseTarget(
        "postgresql://u@db.example.com/buwiz_e2e_lane_a?sslmode=verify-full",
        "buwiz_e2e_lane_a",
      ),
    ).toThrow(/loopback/i);
    expect(() =>
      createDestructiveE2EDatabaseTarget("postgresql://u@127.0.0.1/Books", "Books"),
    ).toThrow(/buwiz_e2e/i);
  });

  it("rejects invalid caller-supplied CA material", () => {
    expect(() =>
      createWorkerDatabaseTarget("postgresql://worker@db.example.com/Books?sslmode=verify-full", {
        ca: "not-a-certificate",
      }),
    ).toThrow(/certificate|CA|TLS/i);
  });
});
