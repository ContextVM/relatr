import { nowMs } from "@/utils/utils";
import { logger } from "@/utils/Logger";
import { RelatrError } from "@/types";
import type { SocialGraph } from "@/graph/SocialGraph";
import type { MetricsValidator } from "@/validators/MetricsValidator";
import type { ProfileMetrics, RelatrConfig } from "@/types";
import {
  CompositeFactRefreshStage,
  NoopFactRefreshStage,
  type FactRefreshStage,
} from "@/validation/FactRefreshStage";
import type { ValidationRunContext } from "@/validation/ValidationRunContext";

interface ValidationStageTimings {
  factRefresh: Array<{ label: string; durationMs: number }>;
  batchScoringMs: number;
  persistenceMs: number;
  fallbackMs: number;
}

export interface ValidationPipelineDeps {
  config: RelatrConfig;
  socialGraph: SocialGraph;
  metricsValidator: MetricsValidator;
  factRefreshStage?: FactRefreshStage;
}

interface ValidationSyncProgress {
  processedCount: number;
  successCount: number;
  errorCount: number;
}

export class ValidationPipeline {
  private validationRunPromise: Promise<void> | null = null;
  private validationRerunRequested = false;

  constructor(private readonly deps: ValidationPipelineDeps) {}

  async scheduleValidationSync(
    batchSize: number = 250,
    sourcePubkey?: string,
    metricKeys?: string[],
  ): Promise<void> {
    if (this.validationRunPromise) {
      this.validationRerunRequested = true;
      logger.info(
        "⏳ Validation sync already in progress, queuing follow-up run",
      );
      return this.validationRunPromise;
    }

    const run = this.runValidationSync(
      batchSize,
      sourcePubkey,
      metricKeys,
    ).finally(async () => {
      this.validationRunPromise = null;

      if (!this.validationRerunRequested) {
        return;
      }

      this.validationRerunRequested = false;
      logger.info("🔄 Starting queued follow-up validation sync");

      try {
        queueMicrotask(async () => {
          await this.scheduleValidationSync(
            batchSize,
            sourcePubkey,
            metricKeys,
          ).catch((error) => {
            logger.error(
              "Follow-up validation warm-up failed:",
              error instanceof Error ? error.message : String(error),
            );
          });
        });
      } catch (error) {
        logger.error(
          "Failed to trigger follow-up validation sync:",
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    this.validationRunPromise = run;
    return run;
  }

  async runValidationSync(
    batchSize: number = 250,
    sourcePubkey?: string,
    metricKeys?: string[],
  ): Promise<void> {
    logger.info("Starting validation sync...");

    const { socialGraph, metricsValidator, config } = this.deps;

    if (!socialGraph || !metricsValidator) {
      throw new RelatrError(
        "ValidationPipeline dependencies not properly initialized",
        "NOT_INITIALIZED",
      );
    }

    const startTime = nowMs();
    const effectiveSourcePubkey = sourcePubkey || config.defaultSourcePubkey;
    const validationRunContext: ValidationRunContext = {};
    const timings: ValidationStageTimings = {
      factRefresh: [],
      batchScoringMs: 0,
      persistenceMs: 0,
      fallbackMs: 0,
    };

    try {
      if (!metricsValidator.hasConfiguredValidators()) {
        logger.info(
          "No validator plugins enabled; skipping metric validation sync.",
        );
        return;
      }

      const allPubkeys = await socialGraph.getAllUsersInGraph();
      logger.info(
        `📊 Found ${allPubkeys.length.toLocaleString()} pubkeys in social graph`,
      );

      if (allPubkeys.length === 0) {
        logger.info(
          "✅ No pubkeys found in social graph, validation sync skipped",
        );
        return;
      }

      logger.info(
        `🔍 Validating ${allPubkeys.length.toLocaleString()} pubkeys against the current validator set`,
      );

      if (metricKeys && metricKeys.length > 0) {
        logger.info(
          `🎯 Narrowing validation sync to ${metricKeys.length} metric keys`,
        );
      }

      await this.runFactRefreshStages(
        this.getFactRefreshStage(),
        {
          pubkeys: allPubkeys,
          sourcePubkey: effectiveSourcePubkey,
          validationRunContext,
        },
        timings,
      );

      const progress: ValidationSyncProgress = {
        processedCount: 0,
        successCount: 0,
        errorCount: 0,
      };

      const batches = this.createBatches(allPubkeys, batchSize);

      for (const [index, batch] of batches.entries()) {
        logger.info(
          `🔄 Processing validation batch ${index + 1} of ${batches.length} (${batch.length} pubkeys)`,
        );

        try {
          const batchStartTime = nowMs();
          const batchResults = await this.runBatchValidation({
            batch,
            sourcePubkey: effectiveSourcePubkey,
            metricKeys,
            metricsValidator,
            validationRunContext,
          });
          timings.batchScoringMs += nowMs() - batchStartTime;

          const persistenceStartTime = nowMs();
          this.recordBatchResults(batchResults, progress);
          timings.persistenceMs += nowMs() - persistenceStartTime;
          this.logProgress(progress, allPubkeys.length);
        } catch (error) {
          logger.warn(
            `Batch validation failed for batch ${index + 1}, falling back to individual validations:`,
            error instanceof Error ? error.message : String(error),
          );

          const fallbackStartTime = nowMs();
          const fallbackResults = await this.runBatchFallback({
            batch,
            sourcePubkey: effectiveSourcePubkey,
            metricKeys,
            metricsValidator,
            validationRunContext,
          });
          timings.fallbackMs += nowMs() - fallbackStartTime;

          const persistenceStartTime = nowMs();
          this.recordBatchResults(fallbackResults, progress);
          timings.persistenceMs += nowMs() - persistenceStartTime;
          this.logProgress(progress, allPubkeys.length);
        }
      }

      this.logStageTimings(timings);

      logger.info(
        `✅ Validation sync completed in ${nowMs() - startTime}ms. Processed: ${progress.processedCount}, Successful: ${progress.successCount}, Failed: ${progress.errorCount}`,
      );
    } catch (error) {
      logger.error(
        "Validation sync error:",
        error instanceof Error ? error.message : String(error),
      );
      throw new RelatrError(
        `Validation sync failed: ${error instanceof Error ? error.message : String(error)}`,
        "VALIDATION_SYNC_ERROR",
      );
    }
  }

  private async runBatchValidation(input: {
    batch: string[];
    sourcePubkey?: string;
    metricKeys?: string[];
    metricsValidator: MetricsValidator;
    validationRunContext: ValidationRunContext;
  }): Promise<Map<string, ProfileMetrics | undefined>> {
    const {
      batch,
      sourcePubkey,
      metricKeys,
      metricsValidator,
      validationRunContext,
    } = input;

    return new Map(
      await metricsValidator.validateAllBatch(
        batch,
        sourcePubkey,
        metricKeys,
        validationRunContext,
      ),
    );
  }

  private getFactRefreshStage(): FactRefreshStage {
    return this.deps.factRefreshStage ?? new NoopFactRefreshStage();
  }

  private async runFactRefreshStages(
    stage: FactRefreshStage,
    context: {
      pubkeys: string[];
      sourcePubkey?: string;
      validationRunContext?: ValidationRunContext;
    },
    timings: ValidationStageTimings,
  ): Promise<void> {
    if (stage instanceof CompositeFactRefreshStage) {
      for (const innerStage of stage.getStages()) {
        await this.runFactRefreshStages(innerStage, context, timings);
      }
      return;
    }

    const label = stage.label ?? "fact refresh";
    const startedAt = nowMs();
    await stage.refresh(context);
    timings.factRefresh.push({ label, durationMs: nowMs() - startedAt });
  }

  private createBatches(pubkeys: string[], batchSize: number): string[][] {
    const batches: string[][] = [];

    for (let i = 0; i < pubkeys.length; i += batchSize) {
      batches.push(pubkeys.slice(i, i + batchSize));
    }

    return batches;
  }

  private recordBatchResults(
    batchResults: Map<string, ProfileMetrics | undefined>,
    progress: ValidationSyncProgress,
  ): void {
    for (const [pubkey, metrics] of batchResults) {
      this.recordResult(pubkey, metrics, progress);
    }
  }

  private async runBatchFallback(input: {
    batch: string[];
    sourcePubkey?: string;
    metricKeys?: string[];
    metricsValidator: MetricsValidator;
    validationRunContext: ValidationRunContext;
  }): Promise<Map<string, ProfileMetrics | undefined>> {
    const {
      batch,
      sourcePubkey,
      metricKeys,
      metricsValidator,
      validationRunContext,
    } = input;
    const results = new Map<string, ProfileMetrics | undefined>();

    for (const pubkey of batch) {
      try {
        const metrics = await metricsValidator.validateAll(
          pubkey,
          sourcePubkey,
          metricKeys,
          validationRunContext,
        );
        results.set(pubkey, metrics);
      } catch (error) {
        logger.warn(
          `⚠️ Validation failed for ${pubkey}:`,
          error instanceof Error ? error.message : String(error),
        );
        results.set(pubkey, undefined);
      }
    }

    return results;
  }

  private recordResult(
    pubkey: string,
    metrics: ProfileMetrics | undefined,
    progress: ValidationSyncProgress,
  ): void {
    progress.processedCount++;

    if (metrics) {
      progress.successCount++;
      return;
    }

    progress.errorCount++;
    logger.warn(`⚠️ Validation failed for ${pubkey}: No metrics generated`);
  }

  private logProgress(
    progress: ValidationSyncProgress,
    totalPubkeys: number,
  ): void {
    logger.info(
      `📈 Progress: ${progress.processedCount}/${totalPubkeys} processed, ${progress.successCount} successful, ${progress.errorCount} failed`,
    );
  }

  private logStageTimings(timings: ValidationStageTimings): void {
    for (const factRefreshStage of timings.factRefresh) {
      logger.info(
        `⏱️ Validation stage ${factRefreshStage.label}: ${factRefreshStage.durationMs}ms`,
      );
    }

    logger.info(
      `⏱️ Validation stage batch scoring: ${timings.batchScoringMs}ms`,
    );
    logger.info(`⏱️ Validation stage persistence: ${timings.persistenceMs}ms`);

    if (timings.fallbackMs > 0) {
      logger.info(`⏱️ Validation stage fallback: ${timings.fallbackMs}ms`);
    }
  }
}
