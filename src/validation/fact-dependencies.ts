import { RELATR_CAPABILITIES } from "@contextvm/relo";

export type FactDomain = "metadata" | "nip05";

const HTTP_NIP05_RESOLVE_CAPABILITY = RELATR_CAPABILITIES.httpNip05Resolve;

function pluginKeyOf(plugin: {
  pubkey: string;
  manifest: { name: string };
}): string {
  return `${plugin.pubkey}:${plugin.manifest.name}`;
}

export function inferFactDependenciesFromPluginSource(
  source: string,
): Set<FactDomain> {
  const domains = new Set<FactDomain>();

  if (source.includes(`'${HTTP_NIP05_RESOLVE_CAPABILITY}'`)) {
    domains.add("metadata");
    domains.add("nip05");
  }

  return domains;
}

export function buildMetricFactDependencyIndex(
  plugins: Array<{
    pubkey: string;
    manifest: { name: string };
    content: string;
  }>,
): Map<string, Set<FactDomain>> {
  return new Map(
    plugins.map((plugin) => [
      pluginKeyOf(plugin),
      inferFactDependenciesFromPluginSource(plugin.content),
    ]),
  );
}

export function resolveRequiredFactDomains(input: {
  metricKeys?: string[];
  availableMetricKeys: string[];
  metricDependencies: ReadonlyMap<string, ReadonlySet<FactDomain>>;
}): Set<FactDomain> {
  const selectedMetricKeys =
    input.metricKeys && input.metricKeys.length > 0
      ? input.metricKeys
      : input.availableMetricKeys;

  const domains = new Set<FactDomain>();

  for (const metricKey of selectedMetricKeys) {
    const metricDomains = input.metricDependencies.get(metricKey);
    if (!metricDomains) {
      continue;
    }

    for (const domain of metricDomains) {
      domains.add(domain);
    }
  }

  return domains;
}
