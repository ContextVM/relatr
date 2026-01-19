/**
 * Data models for Elo portable plugins
 */

import type { NostrEvent } from "nostr-tools";
import type { SocialGraph } from "../graph/SocialGraph";
import type { RelayPool } from "applesauce-relay";

/**
 * Base context shared across plugin and capability execution
 */
export interface BaseContext {
  targetPubkey: string;
  sourcePubkey?: string;
  // Optional context for specific capability types
  graph?: SocialGraph;
  pool?: RelayPool;
  relays?: string[];
}

/**
 * Parsed plugin manifest from Nostr event tags
 */
export interface PluginManifest {
  name: string;
  title: string | null;
  description: string | null;
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
}

/**
 * Capability response structure
 */
export interface CapabilityResponse {
  ok: boolean;
  value: unknown;
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
  cap: Record<string, unknown>;
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
