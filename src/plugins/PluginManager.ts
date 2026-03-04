import { decode } from "nostr-tools/nip19";
import { parseManifestTags, validateManifest } from "./parseManifestTags";
import type { PortablePlugin } from "./plugin-types";
import type { IEloPluginEngine } from "./EloPluginEngine";
import type { SettingsRepository } from "@/database/repositories/SettingsRepository";
import type { RelayPool } from "applesauce-relay";
import { ValidationError, RelatrError } from "@/types";
import { logger } from "@/utils/Logger";
import type { TrustCalculator } from "@/trust/TrustCalculator";
import type { NostrEvent } from "applesauce-core/helpers";

const RELATR_PLUGIN_KIND = 765;

const SETTINGS_KEYS = {
  installed: "plugins.installed.v1",
  enabled: "plugins.enabled.v1",
  overrides: "plugins.weightOverrides.v1",
} as const;

type InstalledMap = Record<string, PortablePlugin>;
type EnabledMap = Record<string, boolean>;
type WeightOverrideMap = Record<string, number>;

export interface InstallPluginInput {
  eventId?: string;
  nevent?: string;
  relays?: string[];
}

interface ResolvedInstallSource {
  id: string;
  relayHints: string[];
}

export interface ConfigurePluginsInput {
  changes: Array<{
    pluginKey: string;
    enabled?: boolean;
    weightOverride?: number | null;
  }>;
}

export interface ListPluginsInput {
  verbose?: boolean;
}

export interface PluginListItem {
  pluginKey: string;
  name: string;
  enabled: boolean;
  effectiveWeight: number;
  pubkey?: string;
  title?: string | null;
  description?: string | null;
  versionInfo?: string;
  defaultWeight?: number | null;
  installedEventId?: string;
  createdAt?: number;
}

function pluginKeyOf(plugin: PortablePlugin): string {
  return `${plugin.pubkey}:${plugin.manifest.name}`;
}

function parseJsonOrDefault<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class PluginManager {
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settingsRepository: Pick<SettingsRepository, "get" | "set">,
    private readonly eloEngine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    >,
    private readonly trustCalculator: Pick<TrustCalculator, "setPluginWeights">,
    private readonly pool: RelayPool,
    private readonly defaultRelays: string[],
  ) {}

  install(input: InstallPluginInput): Promise<{ pluginKey: string; enabled: false }> {
    return this.runSerialized(async () => {
      const event = await this.resolveInstallEvent(input);
      const plugin = this.toPortablePlugin(event);
      const key = pluginKeyOf(plugin);

      const state = await this.readState();
      state.installed[key] = plugin;
      if (state.enabled[key] === undefined) {
        state.enabled[key] = false;
      }

      await this.persistStateWithRollback(state.previousRaw, state);

      return { pluginKey: key, enabled: false };
    });
  }

  configure(input: ConfigurePluginsInput): Promise<{ updated: number }> {
    return this.runSerialized(async () => {
      if (!input.changes?.length) {
        throw new ValidationError("changes must contain at least one item", "changes");
      }

      const state = await this.readState();
      const installedKeys = new Set(Object.keys(state.installed));

      for (const change of input.changes) {
        if (!installedKeys.has(change.pluginKey)) {
          throw new ValidationError(`Unknown pluginKey: ${change.pluginKey}`, "pluginKey");
        }
        if (
          change.weightOverride !== undefined &&
          change.weightOverride !== null &&
          (change.weightOverride < 0 || change.weightOverride > 1)
        ) {
          throw new ValidationError("weightOverride must be between 0 and 1", "weightOverride");
        }
      }

      const candidateEnabled: EnabledMap = { ...state.enabled };
      const candidateOverrides: WeightOverrideMap = { ...state.overrides };
      for (const change of input.changes) {
        if (change.enabled !== undefined) {
          candidateEnabled[change.pluginKey] = change.enabled;
        }
        if (change.weightOverride !== undefined) {
          if (change.weightOverride === null) {
            delete candidateOverrides[change.pluginKey];
          } else {
            candidateOverrides[change.pluginKey] = change.weightOverride;
          }
        }
      }

      const previousRuntime = this.eloEngine.getRuntimeState();
      const candidateRuntime = this.buildRuntimeState(
        state.installed,
        candidateEnabled,
        candidateOverrides,
      );

      try {
        await this.eloEngine.reloadFromPlugins(candidateRuntime);
        this.trustCalculator.setPluginWeights(candidateRuntime.resolvedWeights);
      } catch (error) {
        try {
          await this.eloEngine.reloadFromPlugins(previousRuntime);
          this.trustCalculator.setPluginWeights(previousRuntime.resolvedWeights);
        } catch (rollbackError) {
          logger.error(
            "Plugin runtime rollback failed:",
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          );
        }
        throw new RelatrError(
          `Failed to apply plugin config runtime: ${error instanceof Error ? error.message : String(error)}`,
          "PLUGIN_RUNTIME_APPLY_FAILED",
        );
      }

      const nextState = {
        ...state,
        enabled: candidateEnabled,
        overrides: candidateOverrides,
      };

      await this.persistStateWithRollback(state.previousRaw, nextState);
      return { updated: input.changes.length };
    });
  }

  async list(input: ListPluginsInput = {}): Promise<{ plugins: PluginListItem[] }> {
    const state = await this.readState();
    const runtime = this.buildRuntimeState(state.installed, state.enabled, state.overrides);
    const plugins = Object.entries(state.installed)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pluginKey, plugin]) => {
        const base: PluginListItem = {
          pluginKey,
          name: plugin.manifest.name,
          enabled: runtime.enabled[pluginKey] ?? false,
          effectiveWeight: runtime.resolvedWeights[pluginKey] ?? 0,
        };

        if (!input.verbose) return base;

        return {
          ...base,
          pubkey: plugin.pubkey,
          title: plugin.manifest.title,
          description: plugin.manifest.description,
          versionInfo: plugin.manifest.relatrVersion,
          defaultWeight: plugin.manifest.weight,
          installedEventId: plugin.id,
          createdAt: plugin.createdAt,
        };
      });

    return { plugins };
  }

  private async resolveInstallEvent(input: InstallPluginInput): Promise<NostrEvent> {
    const source = this.extractEventSource(input);
    const relays = Array.from(
      new Set([...(input.relays || []), ...source.relayHints, ...this.defaultRelays]),
    );

    const event = await new Promise<NostrEvent | null>((resolve, reject) => {
      this.pool
        .request(relays, { ids: [source.id], kinds: [RELATR_PLUGIN_KIND], limit: 1 })
        .subscribe({
          next: (evt) => {
            resolve(evt);
          },
          error: (err) => {
            reject(err);
          },
          complete: () => {
            resolve(null);
          },
        });
    });

    if (!event) {
      throw new RelatrError(
        `Plugin event not found for id: ${source.id}`,
        "PLUGIN_EVENT_NOT_FOUND",
      );
    }

    return event;
  }

  private extractEventSource(input: InstallPluginInput): ResolvedInstallSource {
    if (!!input.eventId === !!input.nevent) {
      throw new ValidationError("Provide exactly one of eventId or nevent", "source");
    }

    if (input.eventId) return { id: input.eventId, relayHints: [] };

    try {
      const decoded = decode(input.nevent!);
      if (decoded.type !== "nevent") {
        throw new ValidationError("nevent must decode to nevent type", "nevent");
      }

      const data = decoded.data as { id: string; relays?: string[] };
      return {
        id: data.id,
        relayHints: data.relays ?? [],
      };
    } catch {
      throw new ValidationError("Invalid nevent", "nevent");
    }
  }

  private toPortablePlugin(event: NostrEvent): PortablePlugin {
    if (event.kind !== RELATR_PLUGIN_KIND) {
      throw new ValidationError(`Unsupported plugin kind: ${event.kind}`, "kind");
    }

    const manifest = parseManifestTags(event.tags || []);
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new ValidationError(
        `Plugin manifest validation failed: ${validation.errors.join(", ")}`,
        "manifest",
      );
    }

    return {
      id: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      kind: event.kind,
      content: event.content,
      manifest,
      rawEvent: event,
      unsafe: false,
    };
  }

  private buildRuntimeState(
    installed: InstalledMap,
    enabled: EnabledMap,
    overrides: WeightOverrideMap,
  ): {
    plugins: PortablePlugin[];
    enabled: EnabledMap;
    weightOverrides: WeightOverrideMap;
    resolvedWeights: Record<string, number>;
  } {
    const plugins = Object.entries(installed)
      .filter(([key]) => enabled[key] === true)
      .map(([, plugin]) => plugin);

    const resolvedWeights: Record<string, number> = {};
    const weighted: Array<{ key: string; weight: number }> = [];
    const unweighted: string[] = [];

    for (const plugin of plugins) {
      const key = pluginKeyOf(plugin);
      const override = overrides[key];
      if (override !== undefined) {
        weighted.push({ key, weight: override });
      } else if (plugin.manifest.weight != null) {
        weighted.push({ key, weight: plugin.manifest.weight });
      } else {
        unweighted.push(key);
      }
    }

    const total = weighted.reduce((sum, w) => sum + w.weight, 0);
    const normalized = total > 1 ? weighted.map((w) => ({ ...w, weight: w.weight / total })) : weighted;
    const normalizedTotal = normalized.reduce((sum, w) => sum + w.weight, 0);
    const remaining = Math.max(0, 1 - normalizedTotal);

    for (const item of normalized) {
      resolvedWeights[item.key] = item.weight;
    }

    if (unweighted.length > 0 && remaining > 0) {
      const each = remaining / unweighted.length;
      for (const key of unweighted) resolvedWeights[key] = each;
    }

    return {
      plugins,
      enabled: { ...enabled },
      weightOverrides: { ...overrides },
      resolvedWeights,
    };
  }

  private async readState(): Promise<{
    installed: InstalledMap;
    enabled: EnabledMap;
    overrides: WeightOverrideMap;
    previousRaw: { installed: string | null; enabled: string | null; overrides: string | null };
  }> {
    const [installedRaw, enabledRaw, overridesRaw] = await Promise.all([
      this.settingsRepository.get(SETTINGS_KEYS.installed),
      this.settingsRepository.get(SETTINGS_KEYS.enabled),
      this.settingsRepository.get(SETTINGS_KEYS.overrides),
    ]);

    return {
      installed: parseJsonOrDefault(installedRaw, {}),
      enabled: parseJsonOrDefault(enabledRaw, {}),
      overrides: parseJsonOrDefault(overridesRaw, {}),
      previousRaw: { installed: installedRaw, enabled: enabledRaw, overrides: overridesRaw },
    };
  }

  private async persistStateWithRollback(
    previousRaw: { installed: string | null; enabled: string | null; overrides: string | null },
    state: { installed: InstalledMap; enabled: EnabledMap; overrides: WeightOverrideMap },
  ): Promise<void> {
    const target = {
      installed: JSON.stringify(state.installed),
      enabled: JSON.stringify(state.enabled),
      overrides: JSON.stringify(state.overrides),
    };

    try {
      await this.settingsRepository.set(SETTINGS_KEYS.installed, target.installed);
      await this.settingsRepository.set(SETTINGS_KEYS.enabled, target.enabled);
      await this.settingsRepository.set(SETTINGS_KEYS.overrides, target.overrides);
    } catch (error) {
      try {
        await this.settingsRepository.set(
          SETTINGS_KEYS.installed,
          previousRaw.installed ?? "{}",
        );
        await this.settingsRepository.set(
          SETTINGS_KEYS.enabled,
          previousRaw.enabled ?? "{}",
        );
        await this.settingsRepository.set(
          SETTINGS_KEYS.overrides,
          previousRaw.overrides ?? "{}",
        );
      } catch (rollbackError) {
        logger.error(
          "Plugin settings rollback failed:",
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      }

      throw new RelatrError(
        `Failed to persist plugin settings: ${error instanceof Error ? error.message : String(error)}`,
        "PLUGIN_SETTINGS_PERSIST_FAILED",
      );
    }
  }

  private runSerialized<T>(op: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(op, op);
    this.mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
