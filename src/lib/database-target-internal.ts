import { isIP } from "node:net";
import { posix } from "node:path";
import { createSecureContext } from "node:tls";

export type DatabaseTargetPurpose =
  | "runtime"
  | "worker"
  | "migration"
  | "integration"
  | "live-eval"
  | "destructive-e2e";

export interface DatabaseTarget {
  readonly purpose: DatabaseTargetPurpose;
  readonly databaseName: string;
  readonly redactedIdentity: string;
}

export interface DatabaseTargetOptions {
  readonly ca?: string;
  readonly applicationName?: string;
}

export interface DatabaseTargetPostgresOptions {
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly database: string;
  readonly username: string;
  readonly password: () => string;
  readonly ssl: false | "verify-full" | { readonly ca: string; readonly rejectUnauthorized: true };
  readonly connection: { readonly application_name: string };
}

type Transport = "tcp" | "socket";
type TlsOption = DatabaseTargetPostgresOptions["ssl"];

interface TargetRecord {
  readonly purpose: DatabaseTargetPurpose;
  readonly databaseName: string;
  readonly username: string;
  readonly password: string;
  readonly applicationName: string;
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly transport: Transport;
  readonly loopback: boolean;
  readonly ssl: TlsOption;
}

interface ParsedQuery {
  readonly sslmode?: string;
  readonly host?: string;
  readonly port?: string;
}

interface ParsedEndpoint {
  readonly host: string;
  readonly port?: string;
}

const DEFAULT_PORT = 5432;
const MAX_IDENTIFIER_BYTES = 63;
const MAX_PASSWORD_BYTES = 4096;
const MAX_SOCKET_DIRECTORY_BYTES = 255;
const MAX_APPLICATION_NAME_BYTES = 63;
const DATABASE_NAME_PATTERN = /^buwiz_e2e_[a-z0-9_]+$/;
const ALLOWED_QUERY_KEYS = new Set(["host", "port", "sslmode"]);

const DEFAULT_APPLICATION_NAMES: Record<DatabaseTargetPurpose, string> = {
  runtime: "buwiz-books-runtime",
  worker: "buwiz-books-worker",
  migration: "buwiz-books-migration",
  integration: "buwiz-books-integration",
  "live-eval": "buwiz-books-live-eval",
  "destructive-e2e": "buwiz-books-e2e-reset",
};

const targetRecords = new WeakMap<object, TargetRecord>();
const disposableResetTargets = new WeakSet<object>();

function fail(message: string): never {
  throw new Error(`Invalid database target: ${message}`);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertSafeText(value: string, field: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      fail(`${field} contains control or malformed Unicode data`);
    }
  }
}

function decodeField(raw: string, field: string): string {
  if (/%(?![0-9a-fA-F]{2})/.test(raw)) {
    fail(`${field} contains a malformed percent escape`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    fail(`${field} contains an invalid percent escape`);
  }

  assertSafeText(decoded, field);
  return decoded;
}

function validateIdentifier(value: string, field: string): string {
  if (value.length === 0) fail(`${field} is required`);
  if (byteLength(value) > MAX_IDENTIFIER_BYTES) {
    fail(`${field} exceeds ${MAX_IDENTIFIER_BYTES} UTF-8 bytes`);
  }
  if (/[\s/\\@:#?%]/u.test(value) || value === "." || value === "..") {
    fail(`${field} contains an ambiguous character`);
  }
  return value;
}

function validatePassword(value: string): string {
  if (byteLength(value) > MAX_PASSWORD_BYTES) {
    fail(`password exceeds ${MAX_PASSWORD_BYTES} UTF-8 bytes`);
  }
  return value;
}

function parseDecodedPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(value) || (value.length > 1 && value.startsWith("0"))) {
    fail("port must be a canonical decimal integer");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fail("port must be between 1 and 65535");
  }
  return port;
}

function parsePort(raw: string | undefined): number {
  return parseDecodedPort(raw === undefined ? undefined : decodeField(raw, "port"));
}

function parseQuery(raw: string | undefined): ParsedQuery {
  if (raw === undefined) return {};
  if (raw.length === 0) fail("query string cannot be empty");

  const values = new Map<string, string>();
  for (const part of raw.split("&")) {
    if (part.length === 0) fail("query contains an empty parameter");
    const separator = part.indexOf("=");
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    const rawValue = separator === -1 ? "" : part.slice(separator + 1);
    if (rawKey.length === 0) fail("query parameter name is required");
    if (part.indexOf("=", separator + 1) !== -1) {
      fail("query parameter values must percent-encode '='");
    }

    const key = decodeField(rawKey, "query parameter name");
    if (values.has(key)) fail(`duplicate query parameter ${key}`);
    if (key === "sslrootcert") {
      fail("sslrootcert must be validated locally, not passed through");
    }
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      fail(`unsupported query parameter ${key}`);
    }
    values.set(key, decodeField(rawValue, `query parameter ${key}`));
  }

  return {
    sslmode: values.get("sslmode"),
    host: values.get("host"),
    port: values.get("port"),
  };
}

function parseAuthority(raw: string): {
  readonly username: string;
  readonly password: string;
  readonly endpoint: string;
} {
  const at = raw.indexOf("@");
  if (at === -1 || raw.indexOf("@", at + 1) !== -1) {
    fail("authority must contain exactly one username separator");
  }

  const userInfo = raw.slice(0, at);
  const endpoint = raw.slice(at + 1);
  const colon = userInfo.indexOf(":");
  if (colon !== -1 && userInfo.indexOf(":", colon + 1) !== -1) {
    fail("username and password fields must contain one separator");
  }

  const username = validateIdentifier(
    decodeField(colon === -1 ? userInfo : userInfo.slice(0, colon), "username"),
    "username",
  );
  const password = validatePassword(
    decodeField(colon === -1 ? "" : userInfo.slice(colon + 1), "password"),
  );

  return { username, password, endpoint };
}

function parseEndpoint(raw: string): ParsedEndpoint {
  if (raw.length === 0) fail("TCP host is required");
  if (raw.startsWith("[")) {
    const closing = raw.indexOf("]");
    if (closing === -1 || raw.indexOf("]", closing + 1) !== -1) {
      fail("IPv6 host brackets are malformed");
    }
    const host = raw.slice(1, closing);
    const remainder = raw.slice(closing + 1);
    if (host.length === 0 || host.includes("%")) {
      fail("IPv6 host is empty or has an unsupported zone identifier");
    }
    if (remainder.length > 0 && !remainder.startsWith(":")) {
      fail("unexpected data after IPv6 host");
    }
    return { host, port: remainder.length > 0 ? remainder.slice(1) : undefined };
  }

  if (raw.includes("[") || raw.includes("]")) {
    fail("IPv6 addresses must be bracketed");
  }
  const colon = raw.indexOf(":");
  if (colon === -1) return { host: raw, port: undefined };
  if (raw.indexOf(":", colon + 1) !== -1) {
    fail("IPv6 addresses must be bracketed and multihost forms are forbidden");
  }
  return { host: raw.slice(0, colon), port: raw.slice(colon + 1) };
}

function isCanonicalIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }
  return parts.every(
    (part) => (part === "0" || !part.startsWith("0")) && Number(part) >= 0 && Number(part) <= 255,
  );
}

function validateDnsName(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized === "localhost") fail("localhost is not an explicit host");
  if (normalized.endsWith(".")) fail("DNS host must be canonical without a trailing dot");
  if (byteLength(normalized) > 253) fail("DNS host is too long");

  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = normalized.split(".");
  if (labels.some((label) => !labelPattern.test(label))) {
    fail("host must be a DNS name or an explicit loopback literal");
  }
  return normalized;
}

function classifyHost(raw: string): { readonly host: string; readonly loopback: boolean } {
  if (raw.length === 0 || raw.includes("%")) fail("host is required and must not be encoded");

  const ipKind = isIP(raw);
  if (ipKind === 4) {
    if (!isCanonicalIpv4(raw)) fail("IPv4 host must use canonical dotted decimal notation");
    const loopback = raw.split(".")[0] === "127";
    if (!loopback) {
      fail("remote TCP targets require DNS names, not IP literals");
    }
    return { host: raw, loopback };
  }
  if (/^\d+(?:\.\d+)+$/.test(raw)) {
    fail("odd IPv4 spellings are not accepted");
  }
  if (ipKind === 6) {
    const normalized = raw.toLowerCase();
    if (normalized.includes("::ffff:")) {
      fail("IPv4-mapped IPv6 hosts are not accepted");
    }
    if (normalized === "::1") return { host: normalized, loopback: true };
    fail("only the IPv6 loopback literal is accepted");
  }

  return { host: validateDnsName(raw), loopback: false };
}

function validateSocketDirectory(raw: string): string {
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.endsWith("/") ||
    raw.includes("//") ||
    posix.normalize(raw) !== raw
  ) {
    fail("Unix socket host must be an absolute canonical directory");
  }
  if (byteLength(raw) > MAX_SOCKET_DIRECTORY_BYTES) {
    fail("Unix socket directory is too long");
  }

  const segments = raw.slice(1).split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(segment),
    )
  ) {
    fail("Unix socket directory contains an unsafe path segment");
  }
  return raw;
}

function assertSafeCaText(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0x01 && codePoint <= 0x08) ||
      (codePoint >= 0x0e && codePoint <= 0x1f)
    ) {
      fail("CA material contains unsafe control data");
    }
  }
}

function tlsOption(ca: string | undefined): TlsOption {
  if (ca === undefined) return "verify-full";
  if (ca.length === 0 || byteLength(ca) > 1_000_000) {
    fail("CA material is empty or unreasonably large");
  }
  assertSafeCaText(ca);
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) {
    fail("CA material must contain a PEM certificate bundle");
  }
  try {
    createSecureContext({ ca });
  } catch {
    fail("CA material is not a valid certificate bundle");
  }
  return Object.freeze({ ca, rejectUnauthorized: true as const });
}

function normalizeOptions(
  purpose: DatabaseTargetPurpose,
  options: DatabaseTargetOptions | undefined,
): { readonly ca?: string; readonly applicationName: string } {
  if (options === undefined) {
    return { applicationName: DEFAULT_APPLICATION_NAMES[purpose] };
  }
  if (typeof options !== "object" || options === null) {
    fail("options must be an object");
  }

  for (const key of Object.keys(options)) {
    if (key !== "ca" && key !== "applicationName") {
      fail(`unsupported option ${key}`);
    }
  }

  const ca = options.ca;
  if (ca !== undefined && typeof ca !== "string") fail("CA material must be a string");
  const applicationName = options.applicationName ?? DEFAULT_APPLICATION_NAMES[purpose];
  if (typeof applicationName !== "string" || applicationName.length === 0) {
    fail("applicationName is required");
  }
  assertSafeText(applicationName, "applicationName");
  if (byteLength(applicationName) > MAX_APPLICATION_NAME_BYTES) {
    fail(`applicationName exceeds ${MAX_APPLICATION_NAME_BYTES} UTF-8 bytes`);
  }
  return { ca, applicationName };
}

function parseTarget(
  raw: string,
  options: { readonly ca?: string },
): Omit<TargetRecord, "purpose" | "applicationName"> {
  if (typeof raw !== "string" || raw.length === 0) fail("connection string is required");
  assertSafeText(raw, "connection string");
  if (!raw.startsWith("postgresql://")) fail("connection string must use postgresql://");
  if (raw.includes("#")) fail("fragments are not accepted");
  if (raw.includes("\\")) fail("backslashes are not accepted");

  const body = raw.slice("postgresql://".length);
  const question = body.indexOf("?");
  if (question !== -1 && body.indexOf("?", question + 1) !== -1) {
    fail("connection string contains more than one query separator");
  }
  const authorityAndPath = question === -1 ? body : body.slice(0, question);
  const query = parseQuery(question === -1 ? undefined : body.slice(question + 1));
  const slash = authorityAndPath.indexOf("/");
  if (slash === -1) fail("database path is required");

  const authority = authorityAndPath.slice(0, slash);
  const databaseName = validateIdentifier(
    decodeField(authorityAndPath.slice(slash + 1), "database name"),
    "database name",
  );
  const credentials = parseAuthority(authority);
  const queryPort = query.port === undefined ? undefined : parseDecodedPort(query.port);

  if (credentials.endpoint.length === 0) {
    if (query.host === undefined) fail("Unix socket host is required");
    const directory = validateSocketDirectory(query.host);
    if (options.ca !== undefined) fail("CA material conflicts with Unix sockets");
    if (query.sslmode !== undefined && query.sslmode !== "disable") {
      fail("Unix sockets always disable TLS");
    }
    const port = queryPort ?? DEFAULT_PORT;
    return {
      databaseName,
      username: credentials.username,
      password: credentials.password,
      host: "localhost",
      port,
      path: `${directory}/.s.PGSQL.${port}`,
      transport: "socket",
      loopback: true,
      ssl: false,
    };
  }

  if (query.host !== undefined)
    fail("TCP targets cannot combine authority and host query parameters");
  const endpoint = parseEndpoint(credentials.endpoint);
  if (queryPort !== undefined && endpoint.port !== undefined) {
    fail("TCP port cannot be supplied in both authority and query");
  }
  const { host, loopback } = classifyHost(endpoint.host);
  const port = endpoint.port === undefined ? (queryPort ?? DEFAULT_PORT) : parsePort(endpoint.port);
  const sslmode = query.sslmode;
  let ssl: TlsOption;
  if (loopback) {
    if (sslmode === undefined || sslmode === "disable") {
      if (options.ca !== undefined) fail("CA material requires verified TLS");
      ssl = false;
    } else if (sslmode === "verify-full") {
      ssl = tlsOption(options.ca);
    } else {
      fail("loopback TCP targets allow only disable or verify-full TLS");
    }
  } else {
    if (sslmode !== "verify-full") {
      fail("remote TCP targets require sslmode=verify-full");
    }
    ssl = tlsOption(options.ca);
  }

  return {
    databaseName,
    username: credentials.username,
    password: credentials.password,
    host,
    port,
    transport: "tcp",
    loopback,
    ssl,
  };
}

function createTarget(
  purpose: DatabaseTargetPurpose,
  raw: string,
  options?: DatabaseTargetOptions,
): DatabaseTarget {
  const normalizedOptions = normalizeOptions(purpose, options);
  const parsed = parseTarget(raw, normalizedOptions);
  if ((purpose === "integration" || purpose === "live-eval") && !parsed.loopback) {
    fail(`${purpose} targets must use loopback TCP`);
  }

  const redactedIdentity = `${purpose}:${parsed.databaseName}`;
  const target = Object.freeze({
    purpose,
    databaseName: parsed.databaseName,
    redactedIdentity,
  }) satisfies DatabaseTarget;
  const record: TargetRecord = Object.freeze({
    ...parsed,
    purpose,
    applicationName: normalizedOptions.applicationName,
  });
  targetRecords.set(target, record);
  if (purpose === "destructive-e2e") disposableResetTargets.add(target);
  return target;
}

export function createRuntimeDatabaseTarget(
  raw: string,
  options?: DatabaseTargetOptions,
): DatabaseTarget {
  return createTarget("runtime", raw, options);
}

export function createWorkerDatabaseTarget(
  raw: string,
  options?: DatabaseTargetOptions,
): DatabaseTarget {
  return createTarget("worker", raw, options);
}

export function createMigrationDatabaseTarget(
  raw: string,
  options?: DatabaseTargetOptions,
): DatabaseTarget {
  return createTarget("migration", raw, options);
}

export function createIntegrationDatabaseTarget(
  raw: string,
  options?: DatabaseTargetOptions,
): DatabaseTarget {
  return createTarget("integration", raw, options);
}

export function createLiveEvalDatabaseTarget(
  raw: string,
  options?: DatabaseTargetOptions,
): DatabaseTarget {
  return createTarget("live-eval", raw, options);
}

export function createDestructiveE2EDatabaseTarget(
  raw: string,
  confirmation: string,
  options?: DatabaseTargetOptions,
): DatabaseTarget {
  const target = createTarget("destructive-e2e", raw, options);
  const record = requireTargetRecord(target);
  if (record.transport !== "tcp" || !record.loopback) {
    fail("destructive E2E targets require loopback TCP");
  }
  if (!DATABASE_NAME_PATTERN.test(record.databaseName)) {
    fail("destructive E2E database name must match buwiz_e2e_<suffix>");
  }
  if (typeof confirmation !== "string" || confirmation !== record.databaseName) {
    fail("E2E_RESET_CONFIRM must exactly match the normalized database name");
  }
  return target;
}

export const createDisposableE2EDatabaseTarget = createDestructiveE2EDatabaseTarget;

function requireTargetRecord(target: unknown): TargetRecord {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    fail("target provenance is missing");
  }
  const record = targetRecords.get(target);
  if (record === undefined) fail("target provenance is missing");
  return record;
}

function assertPurpose(record: TargetRecord, expectedPurpose: DatabaseTargetPurpose): void {
  if (record.purpose !== expectedPurpose) {
    fail(`target purpose ${record.purpose} cannot be used as ${expectedPurpose}`);
  }
}

function toPostgresOptions(record: TargetRecord): DatabaseTargetPostgresOptions {
  const options: DatabaseTargetPostgresOptions = {
    host: record.host,
    port: record.port,
    ...(record.path === undefined ? {} : { path: record.path }),
    database: record.databaseName,
    username: record.username,
    password: () => record.password,
    ssl: record.ssl,
    connection: Object.freeze({ application_name: record.applicationName }),
  };
  return Object.freeze(options);
}

export function getPostgresOptionsForDatabaseTarget(
  target: unknown,
  expectedPurpose: DatabaseTargetPurpose,
): DatabaseTargetPostgresOptions {
  const record = requireTargetRecord(target);
  assertPurpose(record, expectedPurpose);
  if (record.purpose === "destructive-e2e") {
    fail("destructive E2E targets require reset authority");
  }
  return toPostgresOptions(record);
}

export function getDisposableResetPostgresOptions(target: unknown): DatabaseTargetPostgresOptions {
  const record = requireTargetRecord(target);
  if (!disposableResetTargets.has(target as object)) {
    fail("target does not carry disposable reset authority");
  }
  if (record.purpose !== "destructive-e2e") {
    fail("target purpose is not destructive-e2e");
  }
  return toPostgresOptions(record);
}
