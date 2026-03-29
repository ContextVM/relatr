#!/usr/bin/env node

import { runCliFromProcess } from "./cli";

runCliFromProcess().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
