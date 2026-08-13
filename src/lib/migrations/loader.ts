import { createHash } from "node:crypto";
import { readFile as readFileFromDisk } from "node:fs/promises";
import {
  migrationManifest,
  validateMigrationManifest,
  type MigrationId,
  type MigrationManifestEntry,
} from "./manifest";

export interface PreparedMigration extends MigrationManifestEntry<MigrationId> {
  readonly sql: string;
  readonly executionSql: string;
}

export function checksumMigration(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export interface MigrationLoaderOptions {
  manifest?: readonly MigrationManifestEntry<MigrationId>[];
  migrationDirectory?: URL;
  readFile?: (file: URL) => Promise<string>;
}

const defaultMigrationDirectory = new URL("../../../drizzle/", import.meta.url);

const TOP_LEVEL_TRANSACTION_STATEMENT =
  /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END(?:\s+TRANSACTION)?|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?\s*;/i;

interface SqlStatement {
  start: number;
  codeStart: number;
  end: number;
  text: string;
}

function topLevelStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let statementStart = 0;
  let statementCodeStart: number | null = null;
  let index = 0;
  let singleQuoted = false;
  let escapeString = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarQuote: string | null = null;

  function markStatementCode(position: number): void {
    if (statementCodeStart === null) statementCodeStart = position;
  }

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (current === "\n") lineComment = false;
      index += 1;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (current === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length;
        dollarQuote = null;
      } else {
        index += 1;
      }
      continue;
    }
    if (singleQuoted) {
      if (escapeString && current === "\\") index += Math.min(2, sql.length - index);
      else if (current === "'" && next === "'") index += 2;
      else {
        if (current === "'") {
          singleQuoted = false;
          escapeString = false;
        }
        index += 1;
      }
      continue;
    }
    if (doubleQuoted) {
      if (current === '"' && next === '"') index += 2;
      else {
        if (current === '"') doubleQuoted = false;
        index += 1;
      }
      continue;
    }

    if (current === "-" && next === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (current === "'") {
      markStatementCode(index);
      escapeString =
        index > 0 &&
        (sql[index - 1] === "E" || sql[index - 1] === "e") &&
        (index === 1 || !/[A-Za-z0-9_$]/.test(sql[index - 2]));
      singleQuoted = true;
      index += 1;
      continue;
    }
    if (current === '"') {
      markStatementCode(index);
      doubleQuoted = true;
      index += 1;
      continue;
    }
    if (current === "$") {
      const delimiter = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter) {
        markStatementCode(index);
        dollarQuote = delimiter;
        index += delimiter.length;
        continue;
      }
    }
    if (!/\s/.test(current)) markStatementCode(index);
    if (current === ";") {
      if (statementCodeStart === null) {
        statementStart = index + 1;
        index += 1;
        continue;
      }
      statements.push({
        start: statementStart,
        codeStart: statementCodeStart,
        end: index + 1,
        text: sql.slice(statementStart, index + 1),
      });
      statementStart = index + 1;
      statementCodeStart = null;
    }
    index += 1;
  }

  if (singleQuoted || doubleQuoted || blockCommentDepth > 0 || dollarQuote) {
    throw new Error("Migration SQL contains an unterminated quoted value or comment.");
  }
  if (sql.slice(statementStart).trim() !== "") {
    throw new Error("Migration SQL must end with a statement terminator.");
  }
  return statements;
}

function transactionStatements(sql: string): SqlStatement[] {
  return topLevelStatements(sql).filter((statement) =>
    TOP_LEVEL_TRANSACTION_STATEMENT.test(
      statement.text.slice(statement.codeStart - statement.start),
    ),
  );
}

function statementCode(statement: SqlStatement): string {
  return statement.text.slice(statement.codeStart - statement.start);
}

function stripOuterTransaction(sql: string, migrationId: string): string {
  const statements = topLevelStatements(sql);
  const transaction = transactionStatements(sql);
  if (
    transaction.length !== 2 ||
    !/^BEGIN\s*;/i.test(statementCode(transaction[0])) ||
    !/^(?:COMMIT|END(?:\s+TRANSACTION)?)\s*;/i.test(statementCode(transaction[1]))
  ) {
    throw new Error(
      `Migration ${migrationId} must contain exactly one standalone BEGIN and one standalone COMMIT.`,
    );
  }
  if (
    statementCode(statements[0]) !== statementCode(transaction[0]) ||
    statementCode(statements.at(-1)!) !== statementCode(transaction[1])
  ) {
    throw new Error(
      `Migration ${migrationId} must use BEGIN and COMMIT as its outer transaction envelope.`,
    );
  }

  return `${sql.slice(0, transaction[0].codeStart)}${sql.slice(
    transaction[0].end,
    transaction[1].codeStart,
  )}${sql.slice(transaction[1].end)}`;
}

export function prepareExecutionSql(entry: MigrationManifestEntry, sql: string): string {
  if (entry.execution === "strip_outer_transaction") {
    return stripOuterTransaction(sql, entry.id);
  }
  if (transactionStatements(sql).length > 0) {
    throw new Error(
      `Migration ${entry.id} contains a transaction statement but is not declared strip_outer_transaction.`,
    );
  }
  return sql;
}

export async function loadPreparedMigrations(
  options: MigrationLoaderOptions = {},
): Promise<readonly PreparedMigration[]> {
  const manifest = options.manifest ?? migrationManifest;
  const validation = validateMigrationManifest(manifest);
  if (!validation.ok) throw new Error(validation.reason);

  const migrationDirectory = options.migrationDirectory ?? defaultMigrationDirectory;
  const readFile = options.readFile ?? ((file: URL) => readFileFromDisk(file, "utf8"));
  const loaded = await Promise.all(
    manifest.map(async (entry) => {
      const file = new URL(entry.file, migrationDirectory);
      let sql: string;
      try {
        sql = await readFile(file);
      } catch (error) {
        throw new Error(`Unable to read managed migration ${entry.id} at ${file.pathname}.`, {
          cause: error,
        });
      }

      const computedChecksum = checksumMigration(sql);
      if (computedChecksum !== entry.checksum) {
        throw new Error(
          `Managed migration ${entry.id} checksum drift: expected ${entry.checksum}, got ${computedChecksum}.`,
        );
      }

      return Object.freeze({
        ...entry,
        historyAliases: Object.freeze([...entry.historyAliases]),
        sql,
        executionSql: prepareExecutionSql(entry, sql),
      } as PreparedMigration);
    }),
  );

  return Object.freeze(loaded);
}
