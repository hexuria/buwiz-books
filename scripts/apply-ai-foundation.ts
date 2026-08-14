import { main } from "./migrate";

main(["apply", "--phase=pre_schema", "--through=0027"]).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
