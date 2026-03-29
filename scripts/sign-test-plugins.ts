/**
 * Sign Test Plugins Script
 *
 * Signs unsigned test plugins from test-plugins/ and saves them to plugins/elo/
 *
 * Usage:
 *   bun run scripts/sign-test-plugins.ts
 *
 * Environment:
 *   PLUGIN_SIGNER_KEY - Optional hex private key (64 chars). If not provided,
 *                       a new key will be generated for testing purposes.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve, join } from "path";
import {
  generateSecretKey,
  getPublicKey,
  NostrEvent,
  UnsignedEvent,
} from "nostr-tools";
import { PrivateKeySigner } from "@contextvm/sdk";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

interface PluginProcessResult {
  name: string;
  success: boolean;
  error?: string;
}

async function signEvent(
  event: UnsignedEvent,
  privateKey?: string,
): Promise<NostrEvent> {
  const signer = new PrivateKeySigner(privateKey);
  return await signer.signEvent(event);
}

async function processPlugin(
  inputPath: string,
  outputDir: string,
  privateKey: string,
): Promise<PluginProcessResult> {
  const fileName = inputPath.split("/").pop() || "unknown";
  const event = JSON.parse(readFileSync(inputPath, "utf-8")) as NostrEvent;

  console.log(`   ${fileName}...`);

  try {
    const signedEvent = await signEvent(event, privateKey);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, fileName),
      JSON.stringify(signedEvent, null, 2),
    );
    return { name: fileName, success: true };
  } catch (error) {
    return {
      name: fileName,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  console.log("🔐 Relatr Plugin Signing Script");
  console.log("================================\n");

  let privateKey = process.env.PLUGIN_SIGNER_KEY;

  if (privateKey) {
    if (privateKey.length !== 64) {
      console.error(
        `❌ Invalid private key length: ${privateKey.length} (expected 64 hex chars)`,
      );
      process.exit(1);
    }
    console.log("✅ Using signer key from PLUGIN_SIGNER_KEY");
  } else {
    const sk = generateSecretKey();
    privateKey = bytesToHex(sk);
    console.log("⚠️  Generated new testing key (not persistent)");
  }

  const publicKey = getPublicKey(hexToBytes(privateKey));
  console.log(`   Public key: ${publicKey}\n`);

  const testPluginsDir = resolve("test-plugins");
  const outputDir = resolve("plugins/elo");

  // Read all .json files from test-plugins directory
  const pluginFiles = readdirSync(testPluginsDir).filter((f) =>
    f.endsWith(".json"),
  );

  if (pluginFiles.length === 0) {
    console.log("   No plugin files found in test-plugins/");
    return;
  }

  console.log("📦 Signing plugins...");

  const results = await Promise.all(
    pluginFiles.map((file) =>
      processPlugin(join(testPluginsDir, file), outputDir, privateKey),
    ),
  );

  const successCount = results.filter((r) => r.success).length;

  console.log("\n================================");
  console.log(`✅ Signed ${successCount}/${pluginFiles.length} plugins`);
  console.log(`📁 Output: ${outputDir}`);

  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    console.log("\n❌ Failed:");
    for (const r of failed) {
      console.log(`   - ${r.name}: ${r.error}`);
    }
  }

  console.log("\nNext steps:");
  console.log("  1. Update .env with ELO_PLUGINS_DIR=./plugins/elo");
  console.log("  2. Start Relatr to test plugin loading");
}

main().catch((error) => {
  console.error("❌ Script failed:", error);
  process.exit(1);
});
