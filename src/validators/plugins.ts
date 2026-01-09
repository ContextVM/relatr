import { queryProfile } from "nostr-tools/nip05";
import type { NostrProfile } from "../types";
import { SocialGraph } from "../graph/SocialGraph";
import { withTimeout } from "@/utils/utils";
import type { RelayPool } from "applesauce-relay";
import { logger } from "../utils/Logger";
import { fetchUserRelayList } from "../utils/utils.nostr";
import type { PubkeyKvRepository } from "../database/repositories/PubkeyKvRepository";

/**
 * Validation context passed to all validation plugins
 */
export interface ValidationContext {
  pubkey: string;
  sourcePubkey?: string;
  profile?: NostrProfile;
  graphManager: SocialGraph;
  pool: RelayPool;
  relays: string[];
  pubkeyKvRepository: PubkeyKvRepository;
  searchQuery?: string; // For context-aware validations
}

/**
 * Validation plugin interface
 */
export interface ValidationPlugin {
  name: string;
  validate(context: ValidationContext): Promise<number>;
}

/**
 * Registry for managing validation plugins
 */
export class ValidationRegistry {
  private plugins = new Map<string, ValidationPlugin>();

  register(plugin: ValidationPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  unregister(name: string): void {
    this.plugins.delete(name);
  }

  get(name: string): ValidationPlugin | undefined {
    return this.plugins.get(name);
  }

  getAll(): ValidationPlugin[] {
    return Array.from(this.plugins.values());
  }

  async executeAll(
    context: ValidationContext,
  ): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    for (const [name, plugin] of this.plugins) {
      try {
        results[name] = await plugin.validate(context);
      } catch (error) {
        logger.warn(`Validation plugin '${name}' failed:`, error);
        results[name] = 0.0; // Default to 0 on error
      }
    }

    return results;
  }
}

/**
 * NIP-05 validation plugin
 */
export class Nip05Plugin implements ValidationPlugin {
  public name = "nip05Valid";
  private timeoutMs: number = 10000;

  async validate(ctx: ValidationContext): Promise<number> {
    if (!ctx.profile?.nip05) return 0.0;

    try {
      const nip05 = ctx.profile.nip05.includes("@")
        ? ctx.profile.nip05
        : `_@${ctx.profile.nip05}`;

      const result = await withTimeout(queryProfile(nip05), this.timeoutMs);

      return result?.pubkey === ctx.pubkey ? 1.0 : 0.0;
    } catch {
      return 0.0;
    }
  }
}

/**
 * Lightning address validation plugin
 */
export class LightningPlugin implements ValidationPlugin {
  public name = "lightningAddress";

  async validate(ctx: ValidationContext): Promise<number> {
    if (!ctx.profile) return 0.0;

    // Check for lud16 (Lightning Address format) first
    if (ctx.profile.lud16) {
      return this.isValidLightningAddressFormat(ctx.profile.lud16) ? 1.0 : 0.0;
    }

    // Check for lud06 (LNURL format)
    if (
      ctx.profile &&
      "lud06" in ctx.profile &&
      typeof (ctx.profile as { lud06?: string }).lud06 === "string"
    ) {
      return this.isValidLnurlFormat((ctx.profile as { lud06: string }).lud06)
        ? 1.0
        : 0.0;
    }

    return 0.0;
  }

  private isValidLightningAddressFormat(address: string): boolean {
    if (!address || typeof address !== "string") {
      return false;
    }

    // Basic email-like format: local@domain
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(address)) {
      return false;
    }

    const parts = address.split("@");
    if (parts.length !== 2) {
      return false;
    }

    const [local, domain] = parts;

    // Local part validation
    if (!local || local.length === 0 || local.length > 64) {
      return false;
    }

    // Domain part validation
    if (!domain || domain.length === 0 || domain.length > 253) {
      return false;
    }

    // Check for valid domain characters
    const domainRegex = /^[a-zA-Z0-9.-]+$/;
    if (!domainRegex.test(domain)) {
      return false;
    }

    // Domain shouldn't start or end with dot or dash
    if (
      domain.startsWith(".") ||
      domain.endsWith(".") ||
      domain.startsWith("-") ||
      domain.endsWith("-")
    ) {
      return false;
    }

    return true;
  }

  private isValidLnurlFormat(lnurl: string): boolean {
    if (!lnurl || typeof lnurl !== "string") {
      return false;
    }

    // Check if it's a bech32 encoded LNURL
    if (lnurl.toLowerCase().startsWith("lnurl")) {
      // Basic bech32 format check
      const bech32Regex = /^lnurl1[ac-hj-np-z02-9]{8,}$/;
      return bech32Regex.test(lnurl.toLowerCase());
    }

    // Check if it's a URL format
    try {
      const url = new URL(lnurl);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }
}

/**
 * Event kind 10002 validation plugin
 */
export class EventPlugin implements ValidationPlugin {
  public name = "eventKind10002";
  private timeoutMs: number = 10000;

  async validate(ctx: ValidationContext): Promise<number> {
    if (!ctx.pubkey || typeof ctx.pubkey !== "string") {
      return 0.0;
    }

    try {
      const relayList = await fetchUserRelayList(
        ctx.pubkey,
        ctx.pool,
        ctx.relays,
        ctx.pubkeyKvRepository,
        this.timeoutMs,
      );

      return relayList &&
        (relayList.inboxes?.length || relayList?.outboxes?.length)
        ? 1.0
        : 0.0;
    } catch {
      return 0.0;
    }
  }
}

/**
 * Reciprocity validation plugin
 */
export class ReciprocityPlugin implements ValidationPlugin {
  public name = "reciprocity";

  async validate(ctx: ValidationContext): Promise<number> {
    if (!ctx.sourcePubkey || !ctx.pubkey) {
      return 0.0;
    }

    try {
      // Ensure social graph is initialized
      if (!ctx.graphManager.isInitialized()) {
        return 0.0;
      }

      const areMutualFollows = await ctx.graphManager.areMutualFollows(
        ctx.sourcePubkey,
        ctx.pubkey,
      );

      // Reciprocity is only true if both follow each other
      return areMutualFollows ? 1.0 : 0.0;
    } catch {
      return 0.0;
    }
  }
}

/**
 * Root NIP-05 validation plugin
 */
export class RootNip05Plugin implements ValidationPlugin {
  public name = "isRootNip05";

  async validate(ctx: ValidationContext): Promise<number> {
    if (!ctx.profile?.nip05) return 0.0;

    const nip05 = ctx.profile.nip05.includes("@")
      ? ctx.profile.nip05
      : `_@${ctx.profile.nip05}`;

    const [username] = nip05.split("@");
    return username === "_" ? 1.0 : 0.0;
  }
}

/**
 * Array of all available validation plugins for easy iteration
 */
export const ALL_PLUGINS: ValidationPlugin[] = [
  new Nip05Plugin(),
  new LightningPlugin(),
  new EventPlugin(),
  new ReciprocityPlugin(),
  new RootNip05Plugin(),
];
