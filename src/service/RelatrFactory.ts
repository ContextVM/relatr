import { RelayPool } from "applesauce-relay";
import { PrivateKeySigner } from "@contextvm/sdk";
import { RelatrConfigSchema } from "../config";
import { DatabaseManager } from "../database/DatabaseManager";
import { MetadataRepository } from "../database/repositories/MetadataRepository";
import { MetricsRepository } from "../database/repositories/MetricsRepository";
import { SettingsRepository } from "../database/repositories/SettingsRepository";
import { TARepository } from "../database/repositories/TARepository";
import { PubkeyKvRepository } from "../database/repositories/PubkeyKvRepository";
import { PubkeyMetadataFetcher } from "../graph/PubkeyMetadataFetcher";
import { SocialGraph as RelatrSocialGraph } from "../graph/SocialGraph";
import {
  SocialGraphBuilder,
  type SocialGraphCreationResult,
} from "../graph/SocialGraphBuilder";
import { TrustCalculator } from "../trust/TrustCalculator";
import type { MetadataRepository as IMetadataRepository } from "../database/repositories/MetadataRepository";
import type { MetricsRepository as IMetricsRepository } from "../database/repositories/MetricsRepository";
import type { SettingsRepository as ISettingsRepository } from "../database/repositories/SettingsRepository";
import type { RelatrConfig } from "../types";
import { RelatrError, ValidationError } from "../types";
import { MetricsValidator } from "../validators/MetricsValidator";
import { logger } from "../utils/Logger";
import type { RelatrServiceDependencies } from "./ServiceInterfaces";
import { RelatrService } from "./RelatrService";
import { SearchService } from "./SearchService";
import { SchedulerService } from "./SchedulerService";
import { TAService } from "./TAService";
import { dirname } from "path";
import {
  EloPluginEngine,
  type IEloPluginEngine,
} from "../plugins/EloPluginEngine";
import { NullEloPluginEngine } from "../plugins/NullEloPluginEngine";
import { nowMs } from "@/utils/utils";

export class RelatrFactory {
  static async createRelatrService(
    config: RelatrConfig,
  ): Promise<{ relatrService: RelatrService; taService: TAService | null }> {
    if (!config)
      throw new RelatrError("Configuration required", "FACTORY_CONFIG");

    const validationResult = RelatrConfigSchema.safeParse(config);

    if (!validationResult.success) {
      const errorMessages = validationResult.error.errors
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join(", ");
      throw new ValidationError(
        `Configuration validation failed: ${errorMessages}`,
        "config",
      );
    }

    const validatedConfig = validationResult.data;

    try {
      logger.debug("Starting Relatr factory initialization...");

      // Step 0: Ensure data directory exists with proper permissions
      await RelatrFactory.ensureDataDirectory(validatedConfig.databasePath);

      // Step 1: Initialize Database Manager
      const dbManager = DatabaseManager.getInstance(
        validatedConfig.databasePath,
      );
      await dbManager.initialize();

      // Step 2: Initialize dual connections (write and read)
      const writeConnection = dbManager.getWriteConnection();
      const readConnection = dbManager.getReadConnection();

      // Step 3: Initialize Repositories (use dual connections: read for reads, write for writes)
      const metricsRepository: IMetricsRepository = new MetricsRepository(
        readConnection,
        writeConnection,
        validatedConfig.cacheTtlHours * 3600,
      );
      const metadataRepository: IMetadataRepository = new MetadataRepository(
        readConnection,
        writeConnection,
      );
      const settingsRepository: ISettingsRepository = new SettingsRepository(
        readConnection,
        writeConnection,
      );
      const pubkeyKvRepository = new PubkeyKvRepository(
        readConnection,
        writeConnection,
      );

      // TA is optional and operator-controlled
      const taRepository = validatedConfig.taEnabled
        ? new TARepository(readConnection, writeConnection)
        : undefined;

      // Step 4: Initialize network components and builders first
      const pool = new RelayPool();
      const socialGraphBuilder = new SocialGraphBuilder(pool);
      const pubkeyMetadataFetcher = new PubkeyMetadataFetcher(
        pool,
        metadataRepository,
      );

      // Step 5: Check if social graph exists and handle first-time setup
      let graphExists = false;
      try {
        const result = await readConnection.run(`
                    SELECT EXISTS (
                        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                        WHERE TABLE_SCHEMA = 'main'
                        AND TABLE_NAME = 'nsd_follows'
                    ) as table_exists
                `);
        const rows = await result.getRows();
        const row = rows[0] as unknown[];
        graphExists = Boolean(row[0]);
      } catch (error) {
        logger.warn(
          "Failed to check if social graph exists (expected during first-time setup):",
          error instanceof Error ? error.message : String(error),
        );
        graphExists = false;
      }

      let creationResult: SocialGraphCreationResult | undefined;

      if (!graphExists) {
        logger.info(
          "Social graph tables not found in database. Creating new graph...",
        );

        creationResult = await socialGraphBuilder.createGraph({
          sourcePubkey: validatedConfig.defaultSourcePubkey,
          hops: validatedConfig.numberOfHops,
          connection: writeConnection,
        });
        logger.info("Social graph created successfully.");
      }

      // Step 6: Initialize the social graph with the write connection
      const socialGraph = new RelatrSocialGraph(
        writeConnection,
        creationResult?.socialGraph,
      );
      await socialGraph.initialize(validatedConfig.defaultSourcePubkey);

      const graphStats = await socialGraph.getStats();
      logger.info("Social graph stats", graphStats);

      // Step 7: Create Elo plugin engine first (needed for MetricsValidator and TrustCalculator)
      let eloEngine: IEloPluginEngine;
      if (validatedConfig.eloPluginsEnabled) {
        logger.info("Elo plugins enabled, creating engine...");
        eloEngine = new EloPluginEngine(validatedConfig, {
          pool,
          relays: validatedConfig.nostrRelays,
          graph: socialGraph,
        });
        await eloEngine.initialize();
        logger.info(
          `Elo plugin engine initialized with ${eloEngine.getPluginCount()} plugins`,
        );
      } else {
        logger.info("Elo plugins disabled, using null-object engine");
        eloEngine = new NullEloPluginEngine();
      }

      // Step 8: Initialize trust calculation with resolved plugin weights
      const trustCalculator = new TrustCalculator(
        validatedConfig,
        eloEngine.getResolvedWeights(),
      );

      // Step 9: Initialize MetricsValidator with Elo engine
      const metricsValidator = new MetricsValidator(
        pool,
        validatedConfig.nostrRelays,
        socialGraph,
        metricsRepository,
        metadataRepository,
        eloEngine,
        validatedConfig.cacheTtlHours * 3600,
      );

      // Step 10: Initialize specialized services
      const searchService = new SearchService(
        validatedConfig,
        metadataRepository,
        socialGraph,
        metricsValidator,
        trustCalculator,
        pool,
      );

      const serviceDependencies: RelatrServiceDependencies = {
        config: validatedConfig,
        dbManager,
        socialGraph,
        metricsValidator,
        metadataRepository,
        metricsRepository,
        settingsRepository,
        taRepository,
        pubkeyMetadataFetcher,
        trustCalculator,
        searchService,
        schedulerService: undefined,
        taService: undefined, // Will be set after TA service is created
      };

      const relatrService = new RelatrService(serviceDependencies);

      // Initialize TA service after relatrService is created (optional)
      const taService = validatedConfig.taEnabled
        ? new TAService({
            config: validatedConfig,
            taRepository: taRepository!,
            relatrService,
            relayPool: pool,
            signer: new PrivateKeySigner(validatedConfig.serverSecretKey),
            pubkeyKvRepository,
          })
        : null;

      // Update relatrService with taService for lazy TA refresh
      if (taService) {
        relatrService.setTAService(taService);
      }

      // Initialize task queue service (after TA service is created)
      const schedulerService = new SchedulerService(
        validatedConfig,
        metricsRepository,
        socialGraph,
        metricsValidator,
        metadataRepository,
        pubkeyMetadataFetcher,
        settingsRepository,
        pool,
        taService || undefined,
      );

      // Update serviceDependencies with the actual schedulerService
      serviceDependencies.schedulerService = schedulerService;

      // Step 11: If this is the first time running, fetch initial metadata
      if (
        !graphExists &&
        (await metadataRepository.getStats()).totalEntries === 0
      ) {
        logger.info("Fetching initial profile metadata...");
        try {
          const keys = Object.keys(graphStats.sizeByDistance);
          const maxDistance = keys.length
            ? Math.max(...keys.map(Number))
            : null;
          const pubkeys = await socialGraph.getAllUsersInGraph();
          logger.info(
            `Found ${pubkeys.length.toLocaleString()} pubkeys within ${maxDistance || validatedConfig.numberOfHops} hops for metadata fetching`,
          );
          await pubkeyMetadataFetcher.fetchMetadata({
            pubkeys,
            sourcePubkey: validatedConfig.defaultSourcePubkey,
          });
        } catch (error) {
          logger.warn(
            "Initial metadata fetch failed:",
            error instanceof Error ? error.message : String(error),
          );
          // Continue despite metadata fetch failure
        }
      }

      // Step 12: Start background processes
      await schedulerService.start();
      logger.info("Background processes started");

      logger.debug(
        "Relatr factory initialization completed with dual-connection architecture",
      );
      return {
        relatrService,
        taService,
      };
    } catch (error) {
      // Cleanup on error
      logger.error(
        "Factory initialization failed:",
        error instanceof Error ? error.message : String(error),
      );
      if (error instanceof RelatrError) {
        throw error;
      }
      throw new RelatrError(
        `Factory initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        "FACTORY_INIT",
      );
    }
  }

  /**
   * Ensure data directory exists with proper permissions
   * @private
   */
  private static async ensureDataDirectory(
    databasePath: string,
  ): Promise<void> {
    try {
      // Extract data directory from database path (default: ./data/relatr.db)
      const dataDir = RelatrFactory.extractDataDirectory(databasePath);

      // Check if directory exists
      let dirExists = false;
      try {
        await Bun.$`stat ${dataDir}`;
        dirExists = true;
      } catch {
        dirExists = false;
      }

      if (!dirExists) {
        logger.info(`📁 Creating data directory: ${dataDir}`);

        // Create directory recursively
        await Bun.$`mkdir -p ${dataDir}`;

        logger.info(`✅ Data directory created`);
      } else {
        // Check if directory is writable by current user
        try {
          // Try to create a test file to check write permissions
          const testFile = `${dataDir}/.write_test_${nowMs()}`;
          await Bun.write(testFile, "test");
          await Bun.$`rm ${testFile}`;
        } catch {
          const effectiveUid =
            typeof process.getuid === "function" ? process.getuid() : null;
          const effectiveGid =
            typeof process.getgid === "function" ? process.getgid() : null;

          throw new RelatrError(
            `Data directory exists but is not writable by current user (uid=${effectiveUid} gid=${effectiveGid}). ` +
              `Please ensure the data directory has proper permissions or remove it to let the application create it.`,
            "DATA_DIRECTORY_PERMISSIONS",
          );
        }
      }
    } catch (error) {
      if (error instanceof RelatrError) {
        throw error;
      }
      throw new RelatrError(
        `Failed to ensure data directory: ${error instanceof Error ? error.message : String(error)}`,
        "DATA_DIRECTORY",
      );
    }
  }

  /**
   * Extract data directory path from file path
   * @private
   */
  private static extractDataDirectory(filePath: string): string {
    return dirname(filePath);
  }
}
