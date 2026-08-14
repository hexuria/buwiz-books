import { main } from "./migrate";

main(["apply", "--through=0018"]).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
