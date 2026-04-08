import { decode } from "nostr-tools/nip19";
import { mkdir, writeFile, rm, readdir, readFile } from "fs/promises";
import { join } from "path";
import { parseManifestTags, validateManifest } from "./parseManifestTags";
import { loadPluginsFromDirectory } from "./PortablePluginLoader";
import type { PortablePlugin } from "./plugin-types";
import type { IEloPluginEngine } from "./EloPluginEngine";
import {
  buildPluginWeightRuntimeState,
  pluginKeyOf,
} from "./resolvePluginWeights";
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

type PluginLifecycleCallbacks = {
  onValidatorsChanged?: (input?: {
    metricKeys?: string[];
    forceRefreshMetricKeys?: string[];
  }) => void | Promise<void>;
};

export interface InstallPluginInput {
  eventId?: string;
  nevent?: string;
  relays?: string[];
  enable?: boolean;
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

export interface UninstallPluginsInput {
  pluginKeys: string[];
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

function artifactFileNameFor(pluginKey: string): string {
  return `${pluginKey.replaceAll(":", "-")}.json`;
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
    private readonly settingsRepository: Pick<
      SettingsRepository,
      "get" | "set"
    >,
    private readonly eloEngine: Pick<
      IEloPluginEngine,
      "getRuntimeState" | "reloadFromPlugins"
    >,
    private readonly trustCalculator: Pick<TrustCalculator, "setPluginWeights">,
    private readonly pool: RelayPool,
    private readonly defaultRelays: string[],
    private readonly pluginsDir?: string,
    private readonly callbacks: PluginLifecycleCallbacks = {},
  ) {}

  bootstrapFromFilesystem(): Promise<{ imported: number }> {
    return this.runSerialized(async () => {
      if (!this.pluginsDir) return { imported: 0 };

      const fsPlugins = await loadPluginsFromDirectory(this.pluginsDir);
      const fsInstalled: InstalledMap = Object.fromEntries(
        fsPlugins.map((plugin) => [pluginKeyOf(plugin), plugin]),
      );
      const state = await this.readState();
      const previousRuntime = this.eloEngine.getRuntimeState();

      const imported = Object.keys(fsInstalled).filter(
        (key) => !state.installed[key],
      ).length;
      const nextEnabled: EnabledMap = {};
      const nextOverrides: WeightOverrideMap = {};
      for (const key of Object.keys(fsInstalled)) {
        nextEnabled[key] = state.enabled[key] ?? true;
        if (state.overrides[key] !== undefined) {
          nextOverrides[key] = state.overrides[key];
        }
      }

      const nextState = {
        ...state,
        installed: fsInstalled,
        enabled: nextEnabled,
        overrides: nextOverrides,
      };

      const candidateRuntime = this.buildRuntimeState(
        nextState.installed,
        nextState.enabled,
        nextState.overrides,
      );

      try {
        await this.eloEngine.reloadFromPlugins(candidateRuntime);
        this.trustCalculator.setPluginWeights(candidateRuntime.resolvedWeights);
      } catch (error) {
        try {
          await this.eloEngine.reloadFromPlugins(previousRuntime);
          this.trustCalculator.setPluginWeights(
            previousRuntime.resolvedWeights,
          );
        } catch (rollbackError) {
          logger.error(
            "Plugin runtime rollback failed:",
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          );
        }
        throw new RelatrError(
          `Failed to apply plugin runtime bootstrap: ${error instanceof Error ? error.message : String(error)}`,
          "PLUGIN_RUNTIME_APPLY_FAILED",
        );
      }

      await this.persistStateWithRollback(state.previousRaw, nextState);
      return { imported };
    });
  }

  install(
    input: InstallPluginInput,
  ): Promise<{ pluginKey: string; enabled: boolean }> {
    return this.runSerialized(async () => {
      const event = await this.resolveInstallEvent(input);
      const plugin = this.toPortablePlugin(event);
      const key = pluginKeyOf(plugin);
      const state = await this.readState();
      const previousPlugin = state.installed[key];
      const forceRefreshMetricKeys =
        previousPlugin && previousPlugin.id !== plugin.id ? [key] : undefined;

      await this.persistPluginArtifact(plugin, key);
      logger.info(`📥 Installing plugin: ${key}`);

      state.installed[key] = plugin;
      if (state.enabled[key] === undefined) {
        state.enabled[key] = input.enable === true;
      }

      const candidateRuntime = this.buildRuntimeState(
        state.installed,
        state.enabled,
        state.overrides,
      );
      const previousRuntime = this.eloEngine.getRuntimeState();

      try {
        await this.eloEngine.reloadFromPlugins(candidateRuntime);
        this.trustCalculator.setPluginWeights(candidateRuntime.resolvedWeights);
      } catch (error) {
        try {
          await this.eloEngine.reloadFromPlugins(previousRuntime);
          this.trustCalculator.setPluginWeights(
            previousRuntime.resolvedWeights,
          );
        } catch (rollbackError) {
          logger.error(
            "Plugin runtime rollback failed:",
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          );
        }
        throw new RelatrError(
          `Failed to apply plugin install runtime: ${error instanceof Error ? error.message : String(error)}`,
          "PLUGIN_RUNTIME_APPLY_FAILED",
        );
      }

      await this.persistStateWithRollback(state.previousRaw, state);

      if (state.enabled[key] === true) {
        logger.info(
          `🚀 Plugin ${key} installed and enabled, triggering validation warm-up`,
        );
        this.triggerValidatorWarmup([key], forceRefreshMetricKeys);
      } else {
        logger.info(`✅ Plugin ${key} installed (disabled)`);
      }

      return { pluginKey: key, enabled: state.enabled[key] === true };
    });
  }

  configure(input: ConfigurePluginsInput): Promise<{ updated: number }> {
    return this.runSerialized(async () => {
      if (!input.changes?.length) {
        throw new ValidationError(
          "changes must contain at least one item",
          "changes",
        );
      }

      const state = await this.readState();
      const installedKeys = new Set(Object.keys(state.installed));

      for (const change of input.changes) {
        if (!installedKeys.has(change.pluginKey)) {
          throw new ValidationError(
            `Unknown pluginKey: ${change.pluginKey}`,
            "pluginKey",
          );
        }
        if (
          change.weightOverride !== undefined &&
          change.weightOverride !== null &&
          (change.weightOverride < 0 || change.weightOverride > 1)
        ) {
          throw new ValidationError(
            "weightOverride must be between 0 and 1",
            "weightOverride",
          );
        }
      }

      const previousRuntime = this.eloEngine.getRuntimeState();
      const candidateEnabled: EnabledMap = { ...state.enabled };
      const hasWeightOverrideEdits = input.changes.some(
        (change) => change.weightOverride !== undefined,
      );
      const hasExplicitWeightAssignments = input.changes.some(
        (change) =>
          change.weightOverride !== undefined && change.weightOverride !== null,
      );
      let candidateOverrides: WeightOverrideMap = { ...state.overrides };

      for (const change of input.changes) {
        if (change.enabled !== undefined) {
          candidateEnabled[change.pluginKey] = change.enabled;
        }
      }

      const hasEnabledSetChanges = Object.keys({
        ...state.enabled,
        ...candidateEnabled,
      }).some(
        (pluginKey) => state.enabled[pluginKey] !== candidateEnabled[pluginKey],
      );

      if (hasExplicitWeightAssignments) {
        candidateOverrides = this.rebuildOverridesForWeightEdit({
          previousResolvedWeights: previousRuntime.resolvedWeights,
          nextEnabled: candidateEnabled,
          changes: input.changes,
        });
      } else if (hasEnabledSetChanges) {
        candidateOverrides = this.rebuildOverridesForEnabledSet({
          previousResolvedWeights: previousRuntime.resolvedWeights,
          previousEnabled: state.enabled,
          previousOverrides: state.overrides,
          nextEnabled: candidateEnabled,
        });
      }

      if (hasWeightOverrideEdits && !hasExplicitWeightAssignments) {
        for (const change of input.changes) {
          if (change.weightOverride !== undefined) {
            if (change.weightOverride === null) {
              delete candidateOverrides[change.pluginKey];
            } else {
              candidateOverrides[change.pluginKey] = change.weightOverride;
            }
          }
        }
      }

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
          this.trustCalculator.setPluginWeights(
            previousRuntime.resolvedWeights,
          );
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

      const enabledMetricKeys = this.getNewlyEnabledMetricKeys(
        state.enabled,
        candidateEnabled,
      );
      if (enabledMetricKeys.length > 0) {
        logger.info(
          `🚀 Triggering validation warm-up for ${enabledMetricKeys.length} affected plugin metrics`,
        );
        this.triggerValidatorWarmup(enabledMetricKeys);
      }

      return { updated: input.changes.length };
    });
  }

  uninstall(input: UninstallPluginsInput): Promise<{ removed: number }> {
    return this.runSerialized(async () => {
      if (!input.pluginKeys?.length) {
        throw new ValidationError(
          "pluginKeys must contain at least one item",
          "pluginKeys",
        );
      }
      if (!this.pluginsDir) {
        throw new RelatrError(
          "Plugin directory is not configured",
          "PLUGIN_STORAGE_NOT_CONFIGURED",
        );
      }

      const state = await this.readState();
      for (const pluginKey of input.pluginKeys) {
        if (!state.installed[pluginKey]) {
          throw new ValidationError(
            `Unknown pluginKey: ${pluginKey}`,
            "pluginKey",
          );
        }
      }

      for (const pluginKey of input.pluginKeys) {
        const plugin = state.installed[pluginKey]!;
        await this.removePluginArtifact(plugin, pluginKey);
      }

      const candidateInstalled: InstalledMap = { ...state.installed };
      const candidateEnabled: EnabledMap = { ...state.enabled };
      for (const pluginKey of input.pluginKeys) {
        delete candidateInstalled[pluginKey];
        delete candidateEnabled[pluginKey];
      }

      const previousRuntime = this.eloEngine.getRuntimeState();
      const candidateOverrides = this.rebuildOverridesForEnabledSet({
        previousResolvedWeights: previousRuntime.resolvedWeights,
        previousEnabled: state.enabled,
        previousOverrides: state.overrides,
        nextEnabled: candidateEnabled,
      });
      const candidateRuntime = this.buildRuntimeState(
        candidateInstalled,
        candidateEnabled,
        candidateOverrides,
      );

      try {
        await this.eloEngine.reloadFromPlugins(candidateRuntime);
        this.trustCalculator.setPluginWeights(candidateRuntime.resolvedWeights);
      } catch (error) {
        try {
          await this.eloEngine.reloadFromPlugins(previousRuntime);
          this.trustCalculator.setPluginWeights(
            previousRuntime.resolvedWeights,
          );
        } catch (rollbackError) {
          logger.error(
            "Plugin runtime rollback failed:",
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          );
        }
        throw new RelatrError(
          `Failed to apply plugin uninstall runtime: ${error instanceof Error ? error.message : String(error)}`,
          "PLUGIN_RUNTIME_APPLY_FAILED",
        );
      }

      await this.persistStateWithRollback(state.previousRaw, {
        installed: candidateInstalled,
        enabled: candidateEnabled,
        overrides: candidateOverrides,
      });

      return { removed: input.pluginKeys.length };
    });
  }

  async list(
    input: ListPluginsInput = {},
  ): Promise<{ plugins: PluginListItem[] }> {
    const state = await this.readState();
    const runtime = this.buildRuntimeState(
      state.installed,
      state.enabled,
      state.overrides,
    );
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

  private async resolveInstallEvent(
    input: InstallPluginInput,
  ): Promise<NostrEvent> {
    const source = this.extractEventSource(input);
    const relays = Array.from(
      new Set([
        ...(input.relays || []),
        ...source.relayHints,
        ...this.defaultRelays,
      ]),
    );

    const event = await new Promise<NostrEvent | null>((resolve, reject) => {
      this.pool
        .request(relays, {
          ids: [source.id],
          kinds: [RELATR_PLUGIN_KIND],
          limit: 1,
        })
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

  private async persistPluginArtifact(
    plugin: PortablePlugin,
    pluginKey: string,
  ): Promise<void> {
    if (!this.pluginsDir) {
      throw new RelatrError(
        "Plugin directory is not configured",
        "PLUGIN_STORAGE_NOT_CONFIGURED",
      );
    }

    try {
      await mkdir(this.pluginsDir, { recursive: true });
      const fileName = artifactFileNameFor(pluginKey);
      const filePath = join(this.pluginsDir, fileName);
      await writeFile(
        filePath,
        JSON.stringify(plugin.rawEvent, null, 2),
        "utf-8",
      );
    } catch (error) {
      throw new RelatrError(
        `Failed to persist plugin artifact: ${error instanceof Error ? error.message : String(error)}`,
        "PLUGIN_ARTIFACT_PERSIST_FAILED",
      );
    }
  }

  private async removePluginArtifact(
    plugin: PortablePlugin,
    pluginKey: string,
  ): Promise<void> {
    if (!this.pluginsDir) {
      throw new RelatrError(
        "Plugin directory is not configured",
        "PLUGIN_STORAGE_NOT_CONFIGURED",
      );
    }

    const dashedPath = join(this.pluginsDir, artifactFileNameFor(pluginKey));
    const encodedPath = join(
      this.pluginsDir,
      `${encodeURIComponent(pluginKey)}.json`,
    );
    try {
      await rm(dashedPath);
      return;
    } catch {
      // try legacy encoded filename, then fallback to scan by event id
    }

    try {
      await rm(encodedPath);
      return;
    } catch {
      // fallback to scan by event id for filesystem-imported plugins
    }

    try {
      const entries = await readdir(this.pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = join(this.pluginsDir, entry.name);
        try {
          const raw = await readFile(filePath, "utf-8");
          const parsed = JSON.parse(raw) as { id?: string };
          if (parsed.id === plugin.id) {
            await rm(filePath);
            return;
          }
        } catch {
          // ignore unreadable/non-json file and continue scanning
        }
      }

      throw new Error(`Plugin artifact not found for key: ${pluginKey}`);
    } catch (error) {
      throw new RelatrError(
        `Failed to remove plugin artifact: ${error instanceof Error ? error.message : String(error)}`,
        "PLUGIN_ARTIFACT_DELETE_FAILED",
      );
    }
  }

  private extractEventSource(input: InstallPluginInput): ResolvedInstallSource {
    if (!!input.eventId === !!input.nevent) {
      throw new ValidationError(
        "Provide exactly one of eventId or nevent",
        "source",
      );
    }

    if (input.eventId) return { id: input.eventId, relayHints: [] };

    try {
      const decoded = decode(input.nevent!);
      if (decoded.type !== "nevent") {
        throw new ValidationError(
          "nevent must decode to nevent type",
          "nevent",
        );
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
      throw new ValidationError(
        `Unsupported plugin kind: ${event.kind}`,
        "kind",
      );
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
    return buildPluginWeightRuntimeState({
      installed,
      enabled,
      overrides,
    });
  }

  private async readState(): Promise<{
    installed: InstalledMap;
    enabled: EnabledMap;
    overrides: WeightOverrideMap;
    previousRaw: {
      installed: string | null;
      enabled: string | null;
      overrides: string | null;
    };
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
      previousRaw: {
        installed: installedRaw,
        enabled: enabledRaw,
        overrides: overridesRaw,
      },
    };
  }

  private async persistStateWithRollback(
    previousRaw: {
      installed: string | null;
      enabled: string | null;
      overrides: string | null;
    },
    state: {
      installed: InstalledMap;
      enabled: EnabledMap;
      overrides: WeightOverrideMap;
    },
  ): Promise<void> {
    const target = {
      installed: JSON.stringify(state.installed),
      enabled: JSON.stringify(state.enabled),
      overrides: JSON.stringify(state.overrides),
    };

    try {
      await this.settingsRepository.set(
        SETTINGS_KEYS.installed,
        target.installed,
      );
      await this.settingsRepository.set(SETTINGS_KEYS.enabled, target.enabled);
      await this.settingsRepository.set(
        SETTINGS_KEYS.overrides,
        target.overrides,
      );
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

  private getNewlyEnabledMetricKeys(
    previousEnabled: EnabledMap,
    nextEnabled: EnabledMap,
  ): string[] {
    const metricKeys: string[] = [];

    for (const [pluginKey, enabled] of Object.entries(nextEnabled)) {
      if (enabled === true && previousEnabled[pluginKey] !== true) {
        metricKeys.push(pluginKey);
      }
    }

    return metricKeys;
  }

  private rebuildOverridesForWeightEdit(input: {
    previousResolvedWeights: Record<string, number>;
    nextEnabled: EnabledMap;
    changes: ConfigurePluginsInput["changes"];
  }): WeightOverrideMap {
    const editedWeights = new Map<string, number>();

    for (const change of input.changes) {
      if (
        change.weightOverride !== undefined &&
        change.weightOverride !== null
      ) {
        editedWeights.set(change.pluginKey, change.weightOverride);
      }
    }

    const enabledKeys = Object.entries(input.nextEnabled)
      .filter(([, enabled]) => enabled === true)
      .map(([pluginKey]) => pluginKey);
    const nextOverrides: WeightOverrideMap = {};
    const explicitTotal = Array.from(editedWeights.values()).reduce(
      (sum, weight) => sum + weight,
      0,
    );

    if (explicitTotal >= 1) {
      const scale = explicitTotal > 0 ? 1 / explicitTotal : 0;
      for (const [pluginKey, weight] of editedWeights.entries()) {
        nextOverrides[pluginKey] = weight * scale;
      }
      for (const pluginKey of enabledKeys) {
        if (!editedWeights.has(pluginKey)) {
          nextOverrides[pluginKey] = 0;
        }
      }
      return nextOverrides;
    }

    for (const [pluginKey, weight] of editedWeights.entries()) {
      nextOverrides[pluginKey] = weight;
    }

    const untouchedEnabledKeys = enabledKeys.filter(
      (pluginKey) => !editedWeights.has(pluginKey),
    );
    const remainingBudget = 1 - explicitTotal;

    if (untouchedEnabledKeys.length === 0 || remainingBudget <= 0) {
      return nextOverrides;
    }

    const previousUntouchedTotal = untouchedEnabledKeys.reduce(
      (sum, pluginKey) => sum + (input.previousResolvedWeights[pluginKey] ?? 0),
      0,
    );

    if (previousUntouchedTotal <= 0) {
      const each = remainingBudget / untouchedEnabledKeys.length;
      for (const pluginKey of untouchedEnabledKeys) {
        nextOverrides[pluginKey] = each;
      }
      return nextOverrides;
    }

    for (const pluginKey of untouchedEnabledKeys) {
      const previousWeight = input.previousResolvedWeights[pluginKey] ?? 0;
      nextOverrides[pluginKey] =
        (previousWeight / previousUntouchedTotal) * remainingBudget;
    }

    return nextOverrides;
  }

  private rebuildOverridesForEnabledSet(input: {
    previousResolvedWeights: Record<string, number>;
    previousEnabled: EnabledMap;
    previousOverrides: WeightOverrideMap;
    nextEnabled: EnabledMap;
  }): WeightOverrideMap {
    const enabledKeys = Object.entries(input.nextEnabled)
      .filter(([, enabled]) => enabled === true)
      .map(([pluginKey]) => pluginKey);

    if (enabledKeys.length === 0) {
      return {};
    }

    const hasUnseededNewlyEnabledPlugin = enabledKeys.some(
      (pluginKey) =>
        input.previousEnabled[pluginKey] !== true &&
        input.previousOverrides[pluginKey] === undefined,
    );

    if (hasUnseededNewlyEnabledPlugin) {
      return {};
    }

    const baselineWeights = Object.fromEntries(
      enabledKeys.map((pluginKey) => [
        pluginKey,
        input.previousResolvedWeights[pluginKey] ??
          input.previousOverrides[pluginKey] ??
          0,
      ]),
    );

    const enabledTotal = Object.values(baselineWeights).reduce(
      (sum, weight) => sum + weight,
      0,
    );

    if (enabledTotal <= 0) {
      const equalWeight = 1 / enabledKeys.length;
      return Object.fromEntries(
        enabledKeys.map((pluginKey) => [pluginKey, equalWeight]),
      );
    }

    return Object.fromEntries(
      enabledKeys.map((pluginKey) => [
        pluginKey,
        (baselineWeights[pluginKey] ?? 0) / enabledTotal,
      ]),
    );
  }

  private triggerValidatorWarmup(
    metricKeys?: string[],
    forceRefreshMetricKeys?: string[],
  ): void {
    const onValidatorsChanged = this.callbacks.onValidatorsChanged;
    if (!onValidatorsChanged) {
      return;
    }

    queueMicrotask(() => {
      Promise.resolve(
        onValidatorsChanged({ metricKeys, forceRefreshMetricKeys }),
      ).catch((error) => {
        logger.warn(
          "Plugin validator warm-up trigger failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
    });
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
