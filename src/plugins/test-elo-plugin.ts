/**
 * Test script for Elo plugin system
 * This script tests the basic functionality without requiring full integration
 */

import { loadConfig } from "../config";
import { loadPlugins } from "./PortablePluginLoader";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CapabilityExecutor } from "../capabilities/CapabilityExecutor";
import { runPlugins } from "./EloPluginRunner";
import { httpNip05Resolve } from "../capabilities/httpNip05Resolve";
import { graphOps } from "../capabilities/graphOps";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "test-elo-plugin" });

async function testEloPluginSystem() {
  logger.info("Starting Elo plugin system test");

  try {
    // Load configuration
    const config = loadConfig();
    logger.info(`Elo plugins enabled: ${config.eloPluginsEnabled}`);
    logger.info(`Elo plugins directory: ${config.eloPluginsDir}`);

    // Enable unsafe mode for testing
    process.env.ELO_PLUGINS_ALLOW_UNSAFE = "true";

    // Load plugins
    logger.info("Loading plugins...");
    const plugins = await loadPlugins(config.eloPluginsDir);
    logger.info(`Loaded ${plugins.length} plugins`);

    if (plugins.length === 0) {
      logger.warn("No plugins found, creating test plugin programmatically");
      // For now, just log that we need plugins
      return;
    }

    // Print plugin details
    for (const plugin of plugins) {
      logger.info(`Plugin: ${plugin.manifest.name}`);
      logger.info(`  Title: ${plugin.manifest.title}`);
      logger.info(`  About: ${plugin.manifest.about}`);
      logger.info(`  Weight: ${plugin.manifest.weight}`);
      logger.info(
        `  Capabilities: ${plugin.manifest.caps.map((c) => c.name).join(", ")}`,
      );
      logger.info(`  Unsafe: ${plugin.unsafe || false}`);
    }

    // Setup capability registry
    const registry = new CapabilityRegistry();

    // Register capabilities
    registry.register("http.nip05_resolve", httpNip05Resolve);
    registry.register("graph.stats", graphOps);
    registry.register("graph.all_pubkeys", graphOps);
    registry.register("graph.pubkey_exists", graphOps);
    registry.register("graph.is_following", graphOps);
    registry.register("graph.are_mutual", graphOps);
    registry.register("graph.degree", graphOps);

    logger.info("Registered capabilities:");
    for (const capName of registry.listCapabilities()) {
      logger.info(`  - ${capName} (enabled: ${registry.isEnabled(capName)})`);
    }

    // Setup capability executor
    const executor = new CapabilityExecutor(registry, config.cacheTtlHours);

    // Create test context
    const testContext = {
      targetPubkey: "test-target-pubkey",
      sourcePubkey: "test-source-pubkey",
      // Note: graph, pool, and relays would be provided in real usage
    };

    // Run plugins
    logger.info("Running plugins...");
    const metrics = await runPlugins(plugins, testContext, registry, executor, {
      eloPluginTimeoutMs: config.eloPluginTimeoutMs,
      capTimeoutMs: config.capTimeoutMs,
    });

    logger.info("Plugin execution results:");
    for (const [name, score] of Object.entries(metrics)) {
      logger.info(`  ${name}: ${score}`);
    }

    // Test cache stats
    const cacheStats = executor.getCacheStats();
    logger.info(
      `Capability cache size: ${cacheStats.size}, TTL: ${cacheStats.ttlHours} hours`,
    );

    logger.info("Elo plugin system test completed successfully!");
  } catch (error) {
    logger.error("Test failed:", error);
    process.exit(1);
  }
}

// Run the test
if (import.meta.main) {
  testEloPluginSystem().catch((error) => {
    logger.error("Unhandled error:", error);
    process.exit(1);
  });
}

export { testEloPluginSystem };
