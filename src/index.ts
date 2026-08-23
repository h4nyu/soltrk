import { runLoop } from "./control/loop";
import { printStatus } from "./status";

const command = process.argv[2] ?? "run";

switch (command) {
  case "run":
    runLoop().catch((err) => {
      console.error(err);
      process.exit(1);
    });
    break;
  case "status":
    printStatus();
    break;
  default:
    console.error(`Unknown command: ${command} (expected "run" or "status")`);
    process.exit(1);
}
