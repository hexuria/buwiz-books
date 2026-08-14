import { main } from "./migrate";

// Compatibility delegate. --status now reports the whole manifest rather than only
// the deduplication migrations; the ordered engine cannot apply 0024 while an
// earlier migration is missing, so the narrower report was never the real state.
const argv = process.argv.includes("--status") ? ["status"] : ["apply", "--through=0024"];
main(argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
