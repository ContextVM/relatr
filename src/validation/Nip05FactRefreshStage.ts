import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import type { Nip05CacheStore } from "@/capabilities/http/Nip05CacheStore";
import type { RelatrConfig } from "@/types";
import { logger } from "@/utils/Logger";
import { LruCache } from "@/utils/lru-cache";
import { resolveNip05WithAbortableFetch } from "@/capabilities/http/utils/resolveNip05Http";
import type {
  FactRefreshStage,
  FactRefreshStageContext,
} from "@/validation/FactRefreshStage";
import { normalizeNip05 } from "@/capabilities/http/utils/httpNip05Normalize";
import { mapWithConcurrency } from "@/utils/mapWithConcurrency";

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

  async refresh(context: FactRefreshStageContext): Promise<void> {
    if (context.pubkeys.length === 0) {
      return;
    }

    const preparedResults = this.prepareRunContext(context);
    const candidates = await this.loadCandidates(context.pubkeys);

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
        await this.prepareResolution(
          formattedNip05,
          timeoutMs,
          preparedResults,
        );
      },
    );
  }

  private prepareRunContext(
    context: FactRefreshStageContext,
  ): LruCache<{ pubkey: string | null }> {
    this.preparedResults.clear();

    if (context.validationRunContext) {
      context.validationRunContext.nip05PreparedResults = this.preparedResults;
      context.validationRunContext.nip05LiveFetchDisabled = true;
    }

    return this.preparedResults;
  }

  private async loadCandidates(
    pubkeys: string[],
  ): Promise<Map<string, string>> {
    const profiles = await this.metadataRepository.getBatch(pubkeys);
    const candidates = new Map<string, string>();

    for (const pubkey of pubkeys) {
      const profile = profiles.get(pubkey);
      const formattedNip05 = profile?.nip05
        ? normalizeNip05(profile.nip05)
        : null;

      if (formattedNip05) {
        candidates.set(formattedNip05, pubkey);
      }
    }

    return candidates;
  }

  private async prepareResolution(
    formattedNip05: string,
    timeoutMs: number,
    preparedResults: LruCache<{ pubkey: string | null }>,
  ): Promise<void> {
    try {
      const existing = await this.nip05CacheStore.getResolution(formattedNip05);
      if (existing) {
        preparedResults.set(formattedNip05, existing);
        return;
      }

      const result = await resolveNip05WithAbortableFetch(
        formattedNip05,
        timeoutMs,
      );

      preparedResults.set(formattedNip05, result);

      await this.nip05CacheStore.setResolution({
        nip05: formattedNip05,
        pubkey: result.pubkey,
        ttlSeconds: this.config.nip05CacheTtlSeconds,
      });
    } catch (error) {
      preparedResults.set(formattedNip05, { pubkey: null });

      await this.nip05CacheStore.setResolution({
        nip05: formattedNip05,
        pubkey: null,
        ttlSeconds: this.config.nip05CacheTtlSeconds,
      });

      logger.warn(
        `Failed to refresh NIP-05 fact for ${formattedNip05}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
