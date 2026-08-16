import { createHash } from "node:crypto";
import type { VerificationEvidence } from "../engine";
import {
  normalizedSqlWhitespace,
  verifyCatalog,
  type CatalogSnapshot,
  type FunctionExpectation,
} from "./catalog";
import { evidence } from "./types";

export interface FunctionContract extends FunctionExpectation {
  bodySha256: string;
}

function normalizedFunctionBody(body: string): string {
  return normalizedSqlWhitespace(body.replace(/\r\n?/g, "\n"));
}

function functionBodySha256(body: string): string {
  return createHash("sha256").update(normalizedFunctionBody(body)).digest("hex");
}

export function verifyFunctionContracts(
  snapshot: CatalogSnapshot,
  contracts: readonly FunctionContract[],
): VerificationEvidence[] {
  const checks = verifyCatalog(snapshot, {
    functions: contracts.map(({ bodySha256: _bodySha256, ...contract }) => contract),
  });
  for (const contract of contracts) {
    const actual = snapshot.functions.get(contract.identity);
    checks.push(
      evidence(
        `function:${contract.identity}:body-sha256`,
        actual !== undefined && functionBodySha256(actual.body) === contract.bodySha256,
        contract.bodySha256,
        actual === undefined ? "missing" : functionBodySha256(actual.body),
      ),
    );
  }
  return checks;
}

export function functionContract(
  identity: string,
  bodySha256: string,
  options: {
    resultType?: string;
    language?: string;
    volatility?: FunctionExpectation["volatility"];
    securityDefiner?: boolean;
    searchPath?: readonly string[];
  } = {},
): FunctionContract {
  return {
    identity,
    bodySha256,
    resultType: options.resultType,
    language: options.language,
    volatility: options.volatility,
    strict: false,
    securityDefiner: options.securityDefiner,
    parallel: "unsafe",
    searchPath: options.searchPath,
  };
}
