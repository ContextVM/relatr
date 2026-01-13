import { readFile } from "fs/promises";
import { readdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import type { NostrEvent } from "nostr-tools";
import type { PortablePlugin } from "./plugin-types";
import { parseManifestTags, validateManifest } from "./parseManifestTags";
import { logger } from "@/utils/Logger";

/**
 * Check if unsafe plugins are allowed (dev/test mode)
 */
function isUnsafeModeEnabled(): boolean {
  return process.env.ELO_PLUGINS_ALLOW_UNSAFE === "true";
}

/**
 * Derive a deterministic ID for unsafe plugins
 */
function deriveUnsafeId(event: Partial<NostrEvent>): string {
  const hash = createHash("sha256");

  // Include all fields that would normally contribute to the event id
  hash.update(String(event.kind || 0));
  hash.update(event.pubkey || "");
  hash.update(String(event.created_at || 0));

  // Serialize tags
  if (event.tags) {
    for (const tag of event.tags) {
      hash.update(tag.join(","));
    }
  }

  // Include content
  hash.update(event.content || "");

  return `unsafe:${hash.digest("hex")}`;
}

/**
 * Load a single plugin from a JSON file
 * @param filePath - Path to the plugin JSON file
 * @returns The loaded portable plugin
 */
export async function loadPluginFromFile(
  filePath: string,
): Promise<PortablePlugin> {
  try {
    const content = await readFile(filePath, "utf-8");
    const rawEvent = JSON.parse(content) as NostrEvent;

    // Check if this is an unsafe plugin (missing signature)
    const isUnsafe = !rawEvent.sig;

    if (isUnsafe && !isUnsafeModeEnabled()) {
      throw new Error(
        `Plugin ${filePath} is missing signature. ` +
          `Set ELO_PLUGINS_ALLOW_UNSAFE=true to load unsigned plugins (dev/test only).`,
      );
    }

    // For unsafe plugins, derive a local ID if missing
    const pluginId = isUnsafe
      ? rawEvent.id || deriveUnsafeId(rawEvent)
      : rawEvent.id;

    // Validate required fields
    if (!pluginId) {
      throw new Error(`Plugin ${filePath} is missing required 'id' field`);
    }

    if (!rawEvent.pubkey) {
      throw new Error(`Plugin ${filePath} is missing required 'pubkey' field`);
    }

    if (!rawEvent.created_at) {
      throw new Error(
        `Plugin ${filePath} is missing required 'created_at' field`,
      );
    }

    if (!rawEvent.kind) {
      throw new Error(`Plugin ${filePath} is missing required 'kind' field`);
    }

    if (!rawEvent.tags) {
      throw new Error(`Plugin ${filePath} is missing required 'tags' field`);
    }

    if (rawEvent.content === undefined) {
      throw new Error(`Plugin ${filePath} is missing required 'content' field`);
    }

    // Parse manifest
    const manifest = parseManifestTags(rawEvent.tags);

    // Validate manifest
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(
        `Plugin ${filePath} manifest validation failed: ${validation.errors.join(", ")}`,
      );
    }

    // Log warning for unsafe plugins
    if (isUnsafe) {
      logger.warn(`Loading unsafe plugin: ${manifest.name} from ${filePath}`);
    }

    return {
      id: pluginId,
      pubkey: rawEvent.pubkey,
      createdAt: rawEvent.created_at,
      kind: rawEvent.kind,
      content: rawEvent.content,
      manifest,
      rawEvent,
      unsafe: isUnsafe,
    };
  } catch (error) {
    throw new Error(
      `Failed to load plugin from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Load all plugins from a directory
 * @param dirPath - Path to the plugins directory
 * @returns Array of loaded portable plugins
 */
export async function loadPluginsFromDirectory(
  dirPath: string,
): Promise<PortablePlugin[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const pluginFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(dirPath, entry.name));

    if (pluginFiles.length === 0) {
      logger.warn(`No plugin files found in directory: ${dirPath}`);
      return [];
    }

    const plugins: PortablePlugin[] = [];
    const errors: string[] = [];

    // Load each plugin file
    for (const filePath of pluginFiles) {
      try {
        const plugin = await loadPluginFromFile(filePath);
        plugins.push(plugin);
        logger.info(`Loaded plugin: ${plugin.manifest.name} from ${filePath}`);
      } catch (error) {
        const errorMsg = `Failed to load plugin ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMsg);
        logger.error(errorMsg);
      }
    }

    // Log summary
    if (plugins.length > 0) {
      logger.info(
        `Successfully loaded ${plugins.length} plugins from ${dirPath}`,
      );
    }

    if (errors.length > 0) {
      logger.warn(`Encountered ${errors.length} errors while loading plugins`);
    }

    return plugins;
  } catch (error) {
    throw new Error(
      `Failed to read plugins directory ${dirPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Load plugins using configuration
 * @param pluginsDir - Directory path from config
 * @returns Array of loaded portable plugins
 */
export async function loadPlugins(
  pluginsDir: string,
): Promise<PortablePlugin[]> {
  if (!isUnsafeModeEnabled()) {
    logger.info(
      "Loading plugins in safe mode (unsigned plugins will be rejected)",
    );
  } else {
    logger.warn("Loading plugins in UNSAFE mode (unsigned plugins allowed)");
  }

  return loadPluginsFromDirectory(pluginsDir);
}
