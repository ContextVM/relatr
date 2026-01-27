import type { PluginManifest } from "./plugin-types";
import { HOST_VERSION } from "../version";

/**
 * Parse Nostr event tags into a structured plugin manifest
 *
 * Tag schema:
 * - n (single-letter, indexable): plugin name
 * - relatr-version (single value): semver range
 * - title, description, weight (single values, optional)
 *
 * Per Nostr convention, the name uses a single-letter tag 'n' for relay indexing.
 * See: plans/relatr-plugins-spec-v1.md §10
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
      case "n":
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
  const hostVersion = HOST_VERSION;

  if (!manifest.name || manifest.name.trim() === "") {
    errors.push("Manifest must have an 'n' tag (plugin name)");
  }

  if (manifest.name && !/^[a-z0-9_-]+$/.test(manifest.name)) {
    errors.push(
      "Plugin name must be lowercase alphanumeric with hyphens/underscores only",
    );
  }

  if (!manifest.relatrVersion || manifest.relatrVersion.trim() === "") {
    errors.push("Manifest must have a 'relatr-version' tag");
  }

  // relatr-version is a semver range (e.g. ^0.1.16) that must match the host.
  // Minimal implementation: support caret ranges only.
  if (manifest.relatrVersion) {
    const v = manifest.relatrVersion.trim();
    if (!v.startsWith("^")) {
      errors.push(
        `Unsupported relatr-version: ${manifest.relatrVersion} (expected caret semver like '^${hostVersion}')`,
      );
    } else {
      const base = v.slice(1);
      if (base !== hostVersion) {
        errors.push(
          `Unsupported relatr-version: ${manifest.relatrVersion} (host is ${hostVersion})`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
