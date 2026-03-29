import { describe, expect, test } from "bun:test";
import { RELATR_CAPABILITIES } from "@contextvm/relo";

import {
  buildMetricFactDependencyIndex,
  inferFactDependenciesFromPluginSource,
  resolveRequiredFactDomains,
} from "@/validation/fact-dependencies";

describe("fact dependency inference", () => {
  test("marks metadata and nip05 dependencies when plugin uses the shared nip05 capability constant", () => {
    const dependencies = inferFactDependenciesFromPluginSource(
      `plan p = do '${RELATR_CAPABILITIES.httpNip05Resolve}' {nip05: 'alice@example.com'} in 1.0`,
    );

    expect([...dependencies]).toEqual(["metadata", "nip05"]);
  });

  test("returns no dependencies when plugin source does not use nip05 resolution", () => {
    const dependencies = inferFactDependenciesFromPluginSource(
      `plan p = do '${RELATR_CAPABILITIES.graphStats}' {} in 1.0`,
    );

    expect([...dependencies]).toEqual([]);
  });
});

describe("metric fact dependency index", () => {
  test("indexes dependencies per metric key and resolves required domains", () => {
    const dependencies = buildMetricFactDependencyIndex([
      {
        pubkey: "pubkey-a",
        manifest: { name: "nip05-metric" },
        content: `plan p = do '${RELATR_CAPABILITIES.httpNip05Resolve}' {nip05: 'alice@example.com'} in 1.0`,
      },
      {
        pubkey: "pubkey-b",
        manifest: { name: "graph-metric" },
        content: `plan p = do '${RELATR_CAPABILITIES.graphStats}' {} in 1.0`,
      },
    ]);

    expect([...dependencies.get("pubkey-a:nip05-metric")!]).toEqual([
      "metadata",
      "nip05",
    ]);
    expect([...dependencies.get("pubkey-b:graph-metric")!]).toEqual([]);

    const requiredDomains = resolveRequiredFactDomains({
      metricKeys: ["pubkey-a:nip05-metric"],
      availableMetricKeys: [...dependencies.keys()],
      metricDependencies: dependencies,
    });

    expect([...requiredDomains]).toEqual(["metadata", "nip05"]);
  });
});
