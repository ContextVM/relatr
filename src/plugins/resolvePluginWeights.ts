import type { PortablePlugin } from "./plugin-types";

export type PluginWeightRuntimeState = {
  plugins: PortablePlugin[];
  enabled: Record<string, boolean>;
  weightOverrides: Record<string, number>;
  resolvedWeights: Record<string, number>;
};

export function pluginKeyOf(plugin: PortablePlugin): string {
  return `${plugin.pubkey}:${plugin.manifest.name}`;
}

export function buildPluginWeightRuntimeState(input: {
  installed: Record<string, PortablePlugin>;
  enabled: Record<string, boolean>;
  overrides: Record<string, number>;
}): PluginWeightRuntimeState {
  const plugins = Object.entries(input.installed)
    .filter(([key]) => input.enabled[key] === true)
    .map(([, plugin]) => plugin);

  return {
    plugins,
    enabled: { ...input.enabled },
    weightOverrides: { ...input.overrides },
    resolvedWeights: resolvePluginWeights({
      plugins,
      overrides: input.overrides,
    }),
  };
}

export function resolvePluginWeights(input: {
  plugins: PortablePlugin[];
  overrides?: Record<string, number>;
}): Record<string, number> {
  const weights: Record<string, number> = {};
  const weightedPlugins: Array<{ key: string; weight: number }> = [];
  const remainingPlugins: string[] = [];

  for (const plugin of input.plugins) {
    const key = pluginKeyOf(plugin);
    const override = input.overrides?.[key];

    if (override !== undefined) {
      weightedPlugins.push({ key, weight: override });
      continue;
    }

    remainingPlugins.push(key);
  }

  const explicitTotal = weightedPlugins.reduce(
    (sum, item) => sum + item.weight,
    0,
  );

  if (explicitTotal >= 1) {
    const scale = explicitTotal > 0 ? 1 / explicitTotal : 0;
    for (const item of weightedPlugins) {
      weights[item.key] = item.weight * scale;
    }
    for (const key of remainingPlugins) {
      weights[key] = 0;
    }

    return weights;
  }

  for (const item of weightedPlugins) {
    weights[item.key] = item.weight;
  }

  const remainingBudget = 1 - explicitTotal;
  if (remainingPlugins.length === 0 || remainingBudget <= 0) {
    return weights;
  }

  const each = remainingBudget / remainingPlugins.length;
  for (const key of remainingPlugins) {
    weights[key] = each;
  }

  return weights;
}
