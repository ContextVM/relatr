#! /usr/bin/env bun

/** Entry point for the config and process manager */
import { startServer } from "process-pastry";
import { parseArgs } from "util";

import configApp from "./config-ui/index.html";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    env: {
      type: "string",
      short: "e",
      default: ".env",
    },
    command: {
      type: "string",
      short: "c",
    },
  },
  allowPositionals: true,
});

// Start process-pastry server with the bundled HTML
startServer({
  port: 3000,
  envPath: values.env || ".env",
  command: values.command
    ? values.command.split(" ")
    : ["bun", "run", "src/app.ts"],
  // Expose existing environment variables to the config UI
  expose: [
    "SERVER_SECRET_KEY",
    "DEFAULT_SOURCE_PUBKEY",
    "SERVER_RELAYS",
    "NOSTR_RELAYS",
  ],
  html: configApp,
});
