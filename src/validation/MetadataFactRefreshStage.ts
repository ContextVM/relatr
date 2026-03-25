import type { PubkeyMetadataFetcher } from "@/graph/PubkeyMetadataFetcher";
import type { MetadataRepository } from "@/database/repositories/MetadataRepository";
import { logger } from "@/utils/Logger";
import type {
  FactRefreshStage,
  FactRefreshStageContext,
} from "@/validation/FactRefreshStage";
import type { MetadataRefreshTracker } from "@/validation/MetadataRefreshTracker";

export class MetadataFactRefreshStage implements FactRefreshStage {
  readonly label = "metadata refresh";

  constructor(
    private readonly metadataRepository: MetadataRepository,
    private readonly pubkeyMetadataFetcher: PubkeyMetadataFetcher,
    private readonly metadataRefreshTracker?: MetadataRefreshTracker,
  ) {}

  async refresh(context: FactRefreshStageContext): Promise<void> {
    if (context.pubkeys.length === 0) {
      return;
    }

    if (
      this.metadataRefreshTracker?.consumeBootstrapCoverage(
        context.pubkeys,
        context.sourcePubkey,
      )
    ) {
      logger.info(
        `👤 Skipping metadata refresh for ${context.pubkeys.length.toLocaleString()} validation targets because bootstrap already covered this scope`,
      );
      return;
    }

    const cachedProfiles = await this.metadataRepository.getBatch(
      context.pubkeys,
    );
    const missingPubkeys = context.pubkeys.filter(
      (pubkey) => !cachedProfiles.get(pubkey),
    );

    if (missingPubkeys.length === 0) {
      logger.info(
        `👤 Skipping metadata refresh for ${context.pubkeys.length.toLocaleString()} validation targets because cached metadata is still fresh`,
      );
      return;
    }

    logger.info(
      `👤 Refreshing metadata facts for ${missingPubkeys.length.toLocaleString()} of ${context.pubkeys.length.toLocaleString()} validation targets`,
    );

    await this.pubkeyMetadataFetcher.fetchMetadata({
      pubkeys: missingPubkeys,
      sourcePubkey: context.sourcePubkey,
    });
  }
}
