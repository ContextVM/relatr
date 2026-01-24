import type { PluginManifest } from "./plugin-types";
import { isValidCapabilityName } from "../capabilities/capability-catalog";

/**
 * Parse Nostr event tags into a structured plugin manifest
 *
 * Tag schema:
 * - name, title, description, weight (single values)
 * - cap (repeatable) - capability allowlist
 *
 * @param tags - Nostr event tags (string[][])
 * @returns Parsed plugin manifest
 */
export function parseManifestTags(tags: string[][]): PluginManifest {
  const manifest: PluginManifest = {
    name: "",
    title: null,
    description: null,
    weight: null,
    caps: [],
  };

  for (const tag of tags) {
    if (tag.length < 2) continue; // Skip invalid tags

    const [key, value] = tag;

    switch (key) {
      case "name":
        manifest.name = value || "";
        break;
      case "title":
        manifest.title = value || null;
        break;
      case "description":
        manifest.description = value || null;
        break;
      case "weight":
        manifest.weight = isNaN(parseFloat(value || ""))
          ? null
          : parseFloat(value || "");
        break;
      case "cap":
        if (value && !manifest.caps.includes(value)) {
          manifest.caps.push(value);
        }
        break;
    }
  }

  return manifest;
}

/**
 * Validate that a manifest has required fields
 * @param manifest - The manifest to validate
 * @returns Validation result
 */
export function validateManifest(manifest: PluginManifest): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!manifest.name || manifest.name.trim() === "") {
    errors.push("Manifest must have a 'name' tag");
  }

  if (manifest.name && !/^[a-z0-9_-]+$/.test(manifest.name)) {
    errors.push(
      "Plugin name must be lowercase alphanumeric with hyphens/underscores only",
    );
  }

  // Validate cap names using the centralized catalog
  for (const capName of manifest.caps) {
    if (!isValidCapabilityName(capName)) {
      errors.push(`Unknown capability: ${capName}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
