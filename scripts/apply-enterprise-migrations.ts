import { main } from "./migrate";

// Compatibility delegate. The Enterprise migrations 0028-0036, their historical
// compatibility DDL, and their checksum fencing are all owned by the ordered
// manifest and the PostgreSQL adapter now. 0036 is the manifest's last entry.
main(["apply", "--through=0036"]).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
