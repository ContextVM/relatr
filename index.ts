import { parseArgs } from "util";
import { RelatrService } from "./src/service/RelatrService";
import { loadConfig } from "./src/config";

const printHelp = () => {
  console.log(`
Usage: bun run index.ts [options]

Options:
  -h, --help             Show this help message.
    `);
};

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    help: {
      type: "boolean",
      short: "h",
    },
  },
  strict: false,
  allowPositionals: true,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const config = loadConfig();
const relatrService = new RelatrService(config);

const main = async () => {
  console.log("Initializing RelatrService...");
  try {
    await relatrService.initialize();
  } catch (error) {
    console.error("An error occurred:", error);
    process.exit(1);
  }
};

main().catch((error) => {
  console.error("Unhandled error in main:", error);
  process.exit(1);
});

const gracefulShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  await relatrService.shutdown();
  console.log("Shutdown complete.");
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
