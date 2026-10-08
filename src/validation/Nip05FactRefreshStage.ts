import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import type { Nip05CacheStore } from "@/capabilities/http/Nip05CacheStore";
import type { RelatrConfig } from "@/types";
import { logger } from "@/utils/Logger";
import { LruCache } from "@/utils/lru-cache";
import {
  Nip05TransportError,
  resolveNip05WithAbortableFetch,
  splitNormalizedNip05,
} from "@/capabilities/http/utils/resolveNip05Http";
import type {
  FactRefreshStage,
  FactRefreshStageContext,
} from "@/validation/FactRefreshStage";
import { normalizeNip05 } from "@/capabilities/http/utils/httpNip05Normalize";
import { mapWithConcurrency } from "@/utils/mapWithConcurrency";

export class Nip05FactRefreshStage implements FactRefreshStage {
  readonly label = "NIP-05 refresh";
  readonly factDomain = "nip05" as const;
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

    const persistedResolutions = await this.nip05CacheStore.getResolutionBatch(
      Array.from(candidates.keys()),
    );
    const refreshTargets = Array.from(candidates.keys()).filter(
      (formattedNip05) => {
        const cached = persistedResolutions.get(formattedNip05) ?? null;
        if (cached) {
          preparedResults.set(formattedNip05, cached);
          return false;
        }
        return true;
      },
    );

    if (refreshTargets.length === 0) {
      logger.info(
        `🪪 Reused ${candidates.size.toLocaleString()} cached NIP-05 facts before scoring`,
      );
      return;
    }

    logger.info(
      `🪪 Refreshing ${refreshTargets.length.toLocaleString()} unique NIP-05 facts before scoring (${(candidates.size - refreshTargets.length).toLocaleString()} reused from cache)`,
    );

    const timeoutMs = Math.min(
      this.config.capTimeoutMs,
      this.config.nip05ResolveTimeoutMs,
    );
    // Grows during the run so that one transport failure skips the rest of that domain's names.
    const coolingDownDomains = await this.nip05CacheStore.getCoolingDownDomains(
      Array.from(
        new Set(
          refreshTargets.flatMap(
            (nip05) => splitNormalizedNip05(nip05)?.domain ?? [],
          ),
        ),
      ),
    );
    let skippedCount = 0;

    await mapWithConcurrency(
      refreshTargets,
      this.concurrency,
      async (formattedNip05) => {
        const domain = splitNormalizedNip05(formattedNip05)?.domain;
        if (domain && coolingDownDomains.has(domain)) {
          preparedResults.set(formattedNip05, { pubkey: null });
          skippedCount++;
          return;
        }

        await this.prepareResolution(
          formattedNip05,
          timeoutMs,
          preparedResults,
          coolingDownDomains,
        );
      },
    );

    if (skippedCount > 0) {
      logger.info(
        `🪪 Skipped ${skippedCount.toLocaleString()} NIP-05 facts on domains in transport cooldown`,
      );
    }
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
    coolingDownDomains: Set<string>,
  ): Promise<void> {
    try {
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

      // Transport failures say nothing about the name, so only the domain is put on hold;
      // its names are retried once the cooldown expires instead of being cached as invalid.
      if (error instanceof Nip05TransportError) {
        coolingDownDomains.add(error.domain);
        await this.nip05CacheStore.setDomainCooldown(
          error.domain,
          this.config.nip05DomainCooldownSeconds,
        );
      }

      logger.warn(
        `Failed to refresh NIP-05 fact for ${formattedNip05}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
