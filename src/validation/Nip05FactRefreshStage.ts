import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import type { Nip05CacheStore } from "@/capabilities/http/Nip05CacheStore";
import type { RelatrConfig } from "@/types";
import { logger } from "@/utils/Logger";
import { LruCache } from "@/utils/lru-cache";
import {
  resolveNip05WithAbortableFetch,
  splitNormalizedNip05,
} from "@/capabilities/http/utils/resolveNip05Http";
import type { CapabilityRunCache } from "@/plugins/plugin-types";
import type {
  FactRefreshStage,
  FactRefreshStageContext,
} from "@/validation/FactRefreshStage";
import { normalizeNip05 } from "@/capabilities/http/utils/httpNip05Normalize";

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex]!);
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export class Nip05FactRefreshStage implements FactRefreshStage {
  readonly label = "NIP-05 refresh";
  private readonly preparedResults = new LruCache<{ pubkey: string | null }>(
    10000,
  );

  constructor(
    private readonly metadataRepository: MetadataRepository,
    private readonly nip05CacheStore: Nip05CacheStore,
    private readonly config: RelatrConfig,
    private readonly concurrency: number = 24,
  ) {}

  configureRunCache(capRunCache: CapabilityRunCache): void {
    capRunCache.nip05PreparedResults = this.preparedResults;
    capRunCache.nip05LiveFetchDisabled = true;
  }

  clearPreparedResults(): void {
    this.preparedResults.clear();
  }

  async refresh(context: FactRefreshStageContext): Promise<void> {
    this.preparedResults.clear();

    if (context.pubkeys.length === 0) {
      return;
    }

    const profiles = await this.metadataRepository.getBatch(context.pubkeys);
    const candidates = new Map<string, string>();

    for (const pubkey of context.pubkeys) {
      const profile = profiles.get(pubkey);
      const formattedNip05 = profile?.nip05
        ? normalizeNip05(profile.nip05)
        : null;

      if (formattedNip05) {
        candidates.set(formattedNip05, pubkey);
      }
    }

    if (candidates.size === 0) {
      logger.info(
        "🪪 No NIP-05 facts to refresh for current validation targets",
      );
      return;
    }

    logger.info(
      `🪪 Refreshing ${candidates.size.toLocaleString()} unique NIP-05 facts before scoring`,
    );

    const timeoutMs = Math.min(
      this.config.capTimeoutMs,
      this.config.nip05ResolveTimeoutMs,
    );

    await mapWithConcurrency(
      Array.from(candidates.keys()),
      this.concurrency,
      async (formattedNip05) => {
        const parsed = splitNormalizedNip05(formattedNip05);
        const domain = parsed?.domain ?? null;

        try {
          if (
            domain &&
            (await this.nip05CacheStore.isDomainCoolingDown(domain))
          ) {
            this.preparedResults.set(formattedNip05, { pubkey: null });
            return;
          }

          const existing =
            await this.nip05CacheStore.getResolution(formattedNip05);
          if (existing) {
            this.preparedResults.set(formattedNip05, existing);
            return;
          }

          const result = await resolveNip05WithAbortableFetch(
            formattedNip05,
            timeoutMs,
          );

          this.preparedResults.set(formattedNip05, result);

          await this.nip05CacheStore.setResolution({
            nip05: formattedNip05,
            pubkey: result.pubkey,
            ttlSeconds: this.config.nip05CacheTtlSeconds,
          });
        } catch (error) {
          this.preparedResults.set(formattedNip05, { pubkey: null });

          if (domain) {
            await this.nip05CacheStore.markDomainCooldown(
              domain,
              this.config.nip05DomainCooldownSeconds,
            );
          }

          logger.warn(
            `Failed to refresh NIP-05 fact for ${formattedNip05}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
  }
}
