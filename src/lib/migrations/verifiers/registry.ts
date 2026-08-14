import type { MigrationVerifier } from "./types";
import type { MigrationId } from "../manifest";
import { verifier0018 } from "./0018";
import { verifier0019 } from "./0019";
import { verifier0020 } from "./0020";
import { verifier0021 } from "./0021";
import { verifier0022 } from "./0022";
import { verifier0023 } from "./0023";
import { verifier0024 } from "./0024";
import { verifier0025 } from "./0025";
import { verifier0026 } from "./0026";
import { verifier0027 } from "./0027";
import { verifier0028 } from "./0028";
import { verifier0029 } from "./0029";
import { verifier0030 } from "./0030";
import { verifier0031 } from "./0031";
import { verifier0032 } from "./0032";
import { verifier0033 } from "./0033";
import { verifier0034 } from "./0034";
import { verifier0035 } from "./0035";
import { verifier0036 } from "./0036";

export const migrationVerifierRegistry = {
  "0018": verifier0018,
  "0019": verifier0019,
  "0020": verifier0020,
  "0021": verifier0021,
  "0022": verifier0022,
  "0023": verifier0023,
  "0024": verifier0024,
  "0025": verifier0025,
  "0026": verifier0026,
  "0027": verifier0027,
  "0028": verifier0028,
  "0029": verifier0029,
  "0030": verifier0030,
  "0031": verifier0031,
  "0032": verifier0032,
  "0033": verifier0033,
  "0034": verifier0034,
  "0035": verifier0035,
  "0036": verifier0036,
} satisfies Record<MigrationId, MigrationVerifier>;

export function validateVerifierRegistry(): void {
  for (const [id, verifier] of Object.entries(migrationVerifierRegistry)) {
    if (verifier.id !== id) {
      throw new Error(`Migration verifier ${id} declares mismatched id ${verifier.id}.`);
    }
  }
}
