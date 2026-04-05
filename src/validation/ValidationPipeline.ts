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
import {
  resolveRequiredFactDomains,
  type FactDomain,
} from "@/validation/fact-dependencies";
import { mapWithConcurrency } from "@/utils/mapWithConcurrency";

interface ValidationStageTimings {
  factRefresh: Array<{ label: string; durationMs: number }>;
  batchScoringMs: number;
  persistenceMs: number;
  fallbackMs: number;
}

interface ValidationRunSummary {
  totalPubkeys: number;
  metricKeyCount: number;
  progress: ValidationSyncProgress;
  timings: ValidationStageTimings;
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

interface FactRefreshExecutionContext {
  pubkeys: string[];
  sourcePubkey?: string;
  validationRunContext?: ValidationRunContext;
  requiredFactDomains?: ReadonlySet<FactDomain>;
}

interface QueuedValidationSyncRequest {
  batchSize: number;
  sourcePubkey?: string;
  metricKeys?: string[];
}

export class ValidationPipeline {
  private validationRunPromise: Promise<void> | null = null;
  private queuedValidationSyncRequest: QueuedValidationSyncRequest | null =
    null;

  constructor(private readonly deps: ValidationPipelineDeps) {}

  async scheduleValidationSync(
    batchSize: number = 250,
    sourcePubkey?: string,
    metricKeys?: string[],
  ): Promise<void> {
    if (this.validationRunPromise) {
      this.queuedValidationSyncRequest = {
        batchSize,
        sourcePubkey,
        metricKeys: metricKeys ? [...metricKeys] : undefined,
      };
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

      const queuedRequest = this.queuedValidationSyncRequest;
      this.queuedValidationSyncRequest = null;

      if (!queuedRequest) {
        return;
      }

      logger.info("🔄 Starting queued follow-up validation sync");

      try {
        queueMicrotask(async () => {
          await this.scheduleValidationSync(
            queuedRequest.batchSize,
            queuedRequest.sourcePubkey,
            queuedRequest.metricKeys,
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
        `🔍 Reconciling validation coverage for ${allPubkeys.length.toLocaleString()} pubkeys against the current validator set`,
      );

      if (metricKeys && metricKeys.length > 0) {
        logger.info(
          `🎯 Narrowing validation sync to ${metricKeys.length} metric keys`,
        );
      }

      const requiredFactDomains = this.resolveRequiredFactDomains(metricKeys);

      await this.runFactRefreshStages(
        this.getFactRefreshStage(),
        {
          pubkeys: allPubkeys,
          sourcePubkey: effectiveSourcePubkey,
          validationRunContext,
          requiredFactDomains,
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
          `🔄 Checking validation batch ${index + 1} of ${batches.length} (${batch.length} pubkeys)`,
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
      this.logCompletionSummary(
        {
          totalPubkeys: allPubkeys.length,
          metricKeyCount: metricKeys?.length ?? 0,
          progress,
          timings,
        },
        nowMs() - startTime,
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
    context: FactRefreshExecutionContext,
    timings: ValidationStageTimings,
  ): Promise<void> {
    if (stage instanceof CompositeFactRefreshStage) {
      for (const innerStage of stage.getStages()) {
        if (
          innerStage.factDomain &&
          context.requiredFactDomains &&
          !context.requiredFactDomains.has(innerStage.factDomain)
        ) {
          logger.info(
            `⏭️ Skipping ${innerStage.label ?? innerStage.factDomain} because it is not required for the selected metric scope`,
          );
          continue;
        }

        await this.runFactRefreshStages(innerStage, context, timings);
      }
      return;
    }

    const label = stage.label ?? "fact refresh";
    const startedAt = nowMs();
    await stage.refresh(context);
    timings.factRefresh.push({ label, durationMs: nowMs() - startedAt });
  }

  private resolveRequiredFactDomains(
    metricKeys?: string[],
  ): Set<FactDomain> | undefined {
    const metricsValidatorWithEngine = this.deps
      .metricsValidator as unknown as {
      eloEngine?: {
        getRuntimeState(): {
          plugins: Array<{ pubkey: string; manifest: { name: string } }>;
          metricFactDependencies?: Map<string, Set<FactDomain>>;
        };
      };
    };

    if (!metricsValidatorWithEngine.eloEngine) {
      return undefined;
    }

    const runtime = metricsValidatorWithEngine.eloEngine.getRuntimeState();
    const metricDependencies = runtime.metricFactDependencies;

    if (!metricDependencies) {
      return undefined;
    }

    return resolveRequiredFactDomains({
      metricKeys,
      availableMetricKeys: runtime.plugins.map(
        (plugin: { pubkey: string; manifest: { name: string } }) =>
          `${plugin.pubkey}:${plugin.manifest.name}`,
      ),
      metricDependencies,
    });
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
    const fallbackConcurrency = Math.max(
      this.deps.config.validationFallbackConcurrency ?? 1,
      1,
    );

    await mapWithConcurrency(batch, fallbackConcurrency, async (pubkey) => {
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
    });

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
      `📈 Validation coverage progress: ${progress.processedCount}/${totalPubkeys} checked, ${progress.successCount} ready, ${progress.errorCount} failed`,
    );
  }

  private logCompletionSummary(
    summary: ValidationRunSummary,
    durationMs: number,
  ): void {
    const { totalPubkeys, metricKeyCount, progress, timings } = summary;
    const scopeLabel =
      metricKeyCount > 0
        ? `${metricKeyCount.toLocaleString()} requested metric${metricKeyCount === 1 ? "" : "s"}`
        : "full validator set";

    if (
      progress.errorCount === 0 &&
      timings.fallbackMs === 0 &&
      timings.persistenceMs === 0
    ) {
      logger.info(
        `✅ Validation sync completed in ${durationMs}ms. All ${progress.successCount.toLocaleString()}/${totalPubkeys.toLocaleString()} pubkeys were already ready for ${scopeLabel}; no metric persistence or fallback recovery was needed.`,
      );
      return;
    }

    logger.info(
      `✅ Validation sync completed in ${durationMs}ms. Checked ${progress.processedCount.toLocaleString()}/${totalPubkeys.toLocaleString()} pubkeys for ${scopeLabel}; ${progress.successCount.toLocaleString()} ready, ${progress.errorCount.toLocaleString()} failed.`,
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
