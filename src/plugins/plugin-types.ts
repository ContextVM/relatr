/**
 * Data models for Elo portable plugins
 */

import type { NostrEvent } from "nostr-tools";

/**
 * Parsed plugin manifest from Nostr event tags
 */
export interface PluginManifest {
  name: string;
  title: string | null;
  about: string | null;
  weight: number | null;
  caps: Array<{
    name: string;
    args: string[];
  }>;
}

/**
 * Internal representation of a loaded portable plugin
 */
export interface PortablePlugin {
  id: string;
  pubkey: string;
  createdAt: number;
  kind: number;
  content: string;
  manifest: PluginManifest;
  rawEvent: NostrEvent;
  unsafe?: boolean;
}

/**
 * Capability request structure
 */
export interface CapabilityRequest {
  capName: string;
  args: string[];
  timeoutMs: number;
  cacheKey: string;
}

/**
 * Capability response structure
 */
export interface CapabilityResponse {
  ok: boolean;
  value: any;
  error: string | null;
  elapsedMs: number;
}

/**
 * Elo evaluation input (the "_" object)
 */
export interface EloInput {
  pubkey: string;
  sourcePubkey?: string;
  now: number;
  cap: Record<string, any>;
}

/**
 * Elo evaluation result
 */
export interface EloEvaluationResult {
  pluginId: string;
  pluginName: string;
  score: number;
  success: boolean;
  error?: string;
  elapsedMs: number;
}
