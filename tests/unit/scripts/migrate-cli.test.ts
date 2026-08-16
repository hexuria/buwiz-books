import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrationEntrypoint } from "@/lib/migrations/entrypoint";
import type { MigrationReport } from "@/lib/migrations/engine";
import {
  main,
  migrationExitCode,
  parseMigrationCliArgs,
  type ProcessRunner,
} from "../../../scripts/migrate";

vi.mock("@/lib/migrations/entrypoint", () => ({
  runMigrationEntrypoint: vi.fn(),
}));

const runEntrypoint = vi.mocked(runMigrationEntrypoint);

const LOOPBACK_URL = "postgresql://migration_owner@127.0.0.1:5432/buwiz_books_test";
const DATABASE_NAME = "buwiz_books_test";

function report(ok: boolean, command: MigrationReport["command"] = "status"): MigrationReport {
  return {
    command,
    ok,
    outcomes: [
      {
        id: "0018",
        file: "0018_integrity_and_server_secrets.sql",
        phase: "post_schema",
        checksum: "a".repeat(64),
        state: ok ? "applied" : "blocked",
        evidence: [],
      },
    ],
  };
}

let exitCodeBeforeTest: typeof process.exitCode;

beforeEach(() => {
  exitCodeBeforeTest = process.exitCode;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  // A leaked non-zero exit code would fail the whole Vitest run, not this test.
  process.exitCode = exitCodeBeforeTest;
  vi.restoreAllMocks();
  runEntrypoint.mockReset();
});

describe("parseMigrationCliArgs", () => {
  it("reports help as an outcome rather than an error", () => {
    expect(parseMigrationCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseMigrationCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseMigrationCliArgs(["status", "--help"])).toEqual({ kind: "help" });
  });

  it("accepts both the separated and joined form of every valued option", () => {
    const separated = parseMigrationCliArgs([
      "apply",
      "--phase",
      "pre_schema",
      "--through",
      "0027",
    ]);
    const joined = parseMigrationCliArgs(["apply", "--phase=pre_schema", "--through=0027"]);

    expect(separated).toEqual(joined);
    expect(joined).toEqual({
      kind: "run",
      options: {
        command: "apply",
        phase: "pre_schema",
        from: undefined,
        through: "0027",
        json: false,
      },
    });
  });

  it("requires a known command", () => {
    expect(() => parseMigrationCliArgs([])).toThrow("A command is required");
    expect(() => parseMigrationCliArgs(["migrate"])).toThrow("A command is required");
  });

  it.each([
    [["apply", "--phase"], "--phase requires a value"],
    [["apply", "--through"], "--through requires a value"],
    [["apply", "--phase=sideways"], "Invalid --phase sideways"],
    [["apply", "--unknown"], "Unknown migration option --unknown"],
    [["status", "--phase=pre_schema"], "--phase is only valid with apply"],
    // Both selectors are apply-only. Accepting one silently while rejecting the
    // other would make a bounded-looking read command report the whole manifest.
    [["status", "--through=0024"], "--through is only valid with apply"],
    [["status", "--from=0028"], "--from is only valid with apply"],
    [["verify", "--through", "0024"], "--through is only valid with apply"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseMigrationCliArgs(argv)).toThrow(message);
  });

  it("carries --json through", () => {
    expect(parseMigrationCliArgs(["verify", "--json"])).toEqual({
      kind: "run",
      options: {
        command: "verify",
        phase: "all",
        from: undefined,
        through: undefined,
        json: true,
      },
    });
  });
});

describe("migrationExitCode", () => {
  it("fails the process for any report that is not ok", () => {
    expect(migrationExitCode(report(true))).toBe(0);
    expect(migrationExitCode(report(false))).toBe(1);
  });
});

describe("main", () => {
  const environment = {
    MIGRATION_DATABASE_URL: LOOPBACK_URL,
    MIGRATION_SCHEMA_SYNC_CONFIRM: DATABASE_NAME,
  } satisfies NodeJS.ProcessEnv;

  it("exits non-zero when status reports a blocked manifest", async () => {
    runEntrypoint.mockResolvedValue(report(false));

    await main(["status"], environment);

    expect(process.exitCode).toBe(1);
  });

  it("leaves a clean status green", async () => {
    runEntrypoint.mockResolvedValue(report(true));

    await main(["status"], environment);

    expect(process.exitCode).toBe(0);
  });

  it("never accepts the serving credential in place of a migration URL", async () => {
    await expect(
      main(["status"], { DATABASE_URL: "postgresql://app@127.0.0.1:5432/buwiz_books" }),
    ).rejects.toThrow(/MIGRATION_DATABASE_URL or DATABASE_URL_ADMIN is required/);

    expect(runEntrypoint).not.toHaveBeenCalled();
  });

  it("prints help without running anything", async () => {
    await expect(main(["--help"], environment)).resolves.toBeUndefined();

    expect(runEntrypoint).not.toHaveBeenCalled();
  });

  it("carries a lower bound so a suffix of the manifest can be applied alone", async () => {
    runEntrypoint.mockResolvedValue(report(true, "apply"));

    await main(["apply", "--from=0028", "--through=0036"], environment, async () => undefined);

    // CI applies only the Enterprise migrations onto a pushed schema, exactly as
    // the workflow it replaced did; without a lower bound the engine would also
    // plan 0018-0027 and stop on migrations that a pushed database satisfies
    // differently.
    expect(runEntrypoint.mock.calls[0]?.[0]).toMatchObject({
      command: "apply",
      from: "0028",
      through: "0036",
    });
  });

  it("forwards the bounded selection to the entrypoint", async () => {
    runEntrypoint.mockResolvedValue(report(true, "apply"));

    await main(
      ["apply", "--phase=pre_schema", "--through=0027"],
      environment,
      async () => undefined,
    );

    expect(runEntrypoint.mock.calls[0]?.[0]).toMatchObject({
      command: "apply",
      phase: "pre_schema",
      through: "0027",
    });
  });

  it("passes no lifecycle hooks to a read-only command", async () => {
    runEntrypoint.mockResolvedValue(report(true));

    await main(["verify"], environment);

    const request = runEntrypoint.mock.calls[0]?.[0];
    expect(request).toMatchObject({ command: "verify" });
    expect(request).not.toHaveProperty("hooks");
    expect(request).not.toHaveProperty("phase");
  });

  it("blocks every schema hook before spawning when the confirmation does not match", async () => {
    const processRunner = vi.fn<ProcessRunner>(async () => undefined);
    runEntrypoint.mockResolvedValue(report(true, "apply"));

    await main(
      ["apply"],
      { ...environment, MIGRATION_SCHEMA_SYNC_CONFIRM: "some-other-database" },
      processRunner,
    );

    const hooks = runEntrypoint.mock.calls[0]?.[0]?.hooks;
    expect(hooks).toBeDefined();
    await expect(hooks?.prepareBaseSchema()).rejects.toThrow(
      `MIGRATION_SCHEMA_SYNC_CONFIRM must exactly equal ${DATABASE_NAME}`,
    );
    // synchronizeSchema spawns nothing at all now, so there is no tool for the
    // guard to gate; the guarded step is the one that applies the schema.
    await expect(hooks?.synchronizeSchema()).resolves.toBeUndefined();
    expect(processRunner).not.toHaveBeenCalled();
  });

  it("applies the schema with push and never invokes drizzle-kit migrate", async () => {
    const processRunner = vi.fn<ProcessRunner>(async () => undefined);
    runEntrypoint.mockResolvedValue(report(true, "apply"));

    await main(["apply"], environment, processRunner);

    const hooks = runEntrypoint.mock.calls[0]?.[0]?.hooks;
    await hooks?.prepareBaseSchema();
    await hooks?.synchronizeSchema();

    // `drizzle-kit migrate` applies only the journalled 0000-0002 history, and the
    // intermediate schema it leaves cannot be reconciled by push without an
    // interactive enum "created or renamed?" prompt, which is fatal in CI.
    expect(processRunner).toHaveBeenCalledTimes(1);
    expect(processRunner).toHaveBeenNthCalledWith(
      1,
      ["x", "drizzle-kit", "push", "--force"],
      expect.objectContaining({ DATABASE_URL: LOOPBACK_URL }),
    );
    expect(processRunner).not.toHaveBeenCalledWith(
      expect.arrayContaining(["migrate"]),
      expect.anything(),
    );
  });
});
