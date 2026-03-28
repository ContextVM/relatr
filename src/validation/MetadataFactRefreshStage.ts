import type { PubkeyMetadataFetcher } from "@/graph/PubkeyMetadataFetcher";
import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import type { NostrProfile } from "@/types";
import { logger } from "@/utils/Logger";
import type {
  FactRefreshStage,
  FactRefreshStageContext,
} from "@/validation/FactRefreshStage";
import type { MetadataRefreshTracker } from "@/validation/MetadataRefreshTracker";

type PreparedMetadataProfiles = Map<string, NostrProfile | null>;

export class MetadataFactRefreshStage implements FactRefreshStage {
  readonly label = "metadata refresh";
  readonly factDomain = "metadata" as const;

  constructor(
    private readonly metadataRepository: MetadataRepository,
    private readonly pubkeyMetadataFetcher: PubkeyMetadataFetcher,
    private readonly metadataRefreshTracker?: MetadataRefreshTracker,
  ) {}

  async refresh(context: FactRefreshStageContext): Promise<void> {
    if (context.pubkeys.length === 0) {
      return;
    }

    const preparedProfiles = this.prepareRunContext(context);

    if (
      this.metadataRefreshTracker?.consumeBootstrapCoverage(
        context.pubkeys,
        context.sourcePubkey,
      )
    ) {
      logger.info(
        `👤 Skipping metadata refresh for ${context.pubkeys.length.toLocaleString()} validation targets because bootstrap already covered this scope`,
      );

      await this.populatePreparedProfiles(
        preparedProfiles,
        await this.metadataRepository.getBatch(context.pubkeys),
      );

      return;
    }

    const cachedProfiles = await this.loadCachedProfiles(context.pubkeys);
    const missingPubkeys = context.pubkeys.filter(
      (pubkey) => !cachedProfiles.get(pubkey),
    );

    if (missingPubkeys.length === 0) {
      logger.info(
        `👤 Skipping metadata refresh for ${context.pubkeys.length.toLocaleString()} validation targets because cached metadata is still fresh`,
      );

      this.populatePreparedProfiles(preparedProfiles, cachedProfiles);

      return;
    }

    logger.info(
      `👤 Refreshing metadata facts for ${missingPubkeys.length.toLocaleString()} of ${context.pubkeys.length.toLocaleString()} validation targets`,
    );

    await this.pubkeyMetadataFetcher.fetchMetadata({
      pubkeys: missingPubkeys,
      sourcePubkey: context.sourcePubkey,
    });

    await this.populatePreparedProfiles(
      preparedProfiles,
      await this.loadCachedProfiles(context.pubkeys),
    );
  }

  private prepareRunContext(
    context: FactRefreshStageContext,
  ): PreparedMetadataProfiles {
    const preparedProfiles =
      context.validationRunContext?.preparedMetadataProfiles ?? new Map();

    if (context.validationRunContext) {
      context.validationRunContext.preparedMetadataProfiles = preparedProfiles;
      context.validationRunContext.metadataPreparedForPubkeys = new Set(
        context.pubkeys,
      );
    }

    return preparedProfiles;
  }

  private async loadCachedProfiles(pubkeys: string[]) {
    return await this.metadataRepository.getBatch(pubkeys);
  }

  private populatePreparedProfiles(
    preparedProfiles: PreparedMetadataProfiles,
    profiles: PreparedMetadataProfiles,
  ): void {
    for (const [pubkey, profile] of profiles) {
      preparedProfiles.set(pubkey, profile);
    }
  }
}
