import type { PluginManifest } from "./plugin-types";

/**
 * Parse Nostr event tags into a structured plugin manifest
 *
 * Tag schema:
 * - name, title, about, weight (single values)
 * - cap (repeatable)
 * - cap_arg (repeatable, associated with preceding cap)
 *
 * @param tags - Nostr event tags (string[][])
 * @returns Parsed plugin manifest
 */
export function parseManifestTags(tags: string[][]): PluginManifest {
  const manifest: PluginManifest = {
    name: "",
    title: null,
    about: null,
    weight: null,
    caps: [],
  };

  // Simple state machine to associate cap_arg with the most recent cap
  let currentCap: { name: string; args: string[] } | null = null;

  for (const tag of tags) {
    if (tag.length < 2) continue; // Skip invalid tags

    const [key, value, ...rest] = tag;

    switch (key) {
      case "name":
        manifest.name = value || "";
        break;
      case "title":
        manifest.title = value || null;
        break;
      case "about":
        manifest.about = value || null;
        break;
      case "weight":
        const weight = parseFloat(value || "");
        manifest.weight = isNaN(weight) ? null : weight;
        break;
      case "cap":
        // If we have a current cap being built, push it to the list
        if (currentCap) {
          manifest.caps.push(currentCap);
        }
        // Start a new cap
        currentCap = { name: value || "", args: [] };
        break;
      case "cap_arg":
        // Associate with current cap if one is active
        if (currentCap) {
          currentCap.args.push(value || "");
        }
        break;
    }
  }

  // Push the last cap if it exists
  if (currentCap) {
    manifest.caps.push(currentCap);
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

  // Validate cap names
  const validCapNames = [
    "nostr.query",
    "graph.stats",
    "graph.all_pubkeys",
    "graph.pubkey_exists",
    "graph.is_following",
    "graph.are_mutual",
    "graph.degree",
    "http.nip05_resolve",
  ];

  for (const cap of manifest.caps) {
    if (!validCapNames.includes(cap.name)) {
      errors.push(`Unknown capability: ${cap.name}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
