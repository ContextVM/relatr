import type { PluginManifest } from "./plugin-types";

/**
 * Parse Nostr event tags into a structured plugin manifest
 *
 * Tag schema:
 * - name, relatr-version (single values)
 * - title, description, weight (single values)
 *
 * @param tags - Nostr event tags (string[][])
 * @returns Parsed plugin manifest
 */
export function parseManifestTags(tags: string[][]): PluginManifest {
  const manifest: PluginManifest = {
    name: "",
    relatrVersion: "",
    title: null,
    description: null,
    weight: null,
  };

  for (const tag of tags) {
    if (tag.length < 2) continue; // Skip invalid tags

    const [key, value] = tag;

    switch (key) {
      case "name":
        manifest.name = value || "";
        break;
      case "relatr-version":
        manifest.relatrVersion = value || "";
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

  if (!manifest.relatrVersion || manifest.relatrVersion.trim() === "") {
    errors.push("Manifest must have a 'relatr-version' tag");
  }

  // v0 and v1 are supported during migration.
  if (manifest.relatrVersion && manifest.relatrVersion !== "v1") {
    errors.push(
      `Unsupported relatr-version: ${manifest.relatrVersion} (expected 'v1')`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
