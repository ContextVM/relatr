import { parseArgs } from "util";
import { startServer } from "process-pastry";
import configApp from "./config-ui/index.html";

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

// Start process-pastry server with the bundled HTML
startServer({
  port: 3000,
  envPath: ".env",
  command: ["bun", "run", "src/app.ts"],
  htmlRoute: "/",
  html: configApp,
  exampleEnvPath: ".env.example"
});
