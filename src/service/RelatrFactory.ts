import { RelayPool } from 'applesauce-relay';
import { PrivateKeySigner } from "@contextvm/sdk";
import { RelatrConfigSchema } from '../config';
import { DatabaseManager } from '../database/DatabaseManager';
import { MetadataRepository } from '../database/repositories/MetadataRepository';
import { MetricsRepository } from '../database/repositories/MetricsRepository';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { TARepository } from '../database/repositories/TARepository';
import { PubkeyMetadataFetcher } from '../graph/PubkeyMetadataFetcher';
import { SocialGraph as RelatrSocialGraph } from '../graph/SocialGraph';
import { SocialGraphBuilder, type SocialGraphCreationResult } from '../graph/SocialGraphBuilder';
import { TrustCalculator } from '../trust/TrustCalculator';
import type { MetadataRepository as IMetadataRepository } from '../database/repositories/MetadataRepository';
import type { MetricsRepository as IMetricsRepository } from '../database/repositories/MetricsRepository';
import type { SettingsRepository as ISettingsRepository } from '../database/repositories/SettingsRepository';
import type { RelatrConfig } from '../types';
import { RelatrError, ValidationError } from '../types';
import { MetricsValidator } from '../validators/MetricsValidator';
import { ALL_PLUGINS } from '../validators/plugins';
import { logger } from '../utils/Logger';
import type { RelatrServiceDependencies } from './ServiceInterfaces';
import { RelatrService } from './RelatrService';
import { SearchService } from './SearchService';
import { SchedulerService } from './SchedulerService';
import { TAService } from './TAService';
import { dirname } from "path";

export class RelatrFactory {
    static async createRelatrService(config: RelatrConfig): Promise<{relatrService: RelatrService; taService: TAService | null}> {
        if (!config) throw new RelatrError('Configuration required', 'FACTORY_CONFIG');
        
        const validationResult = RelatrConfigSchema.safeParse(config);
        
        if (!validationResult.success) {
          const errorMessages = validationResult.error.errors.map(err =>
            `${err.path.join('.')}: ${err.message}`
          ).join(', ');
          throw new ValidationError(`Configuration validation failed: ${errorMessages}`, 'config');
        }
        
        const validatedConfig = validationResult.data;
        
        try {
            logger.debug('Starting Relatr factory initialization...');
            
            // Step 0: Ensure data directory exists with proper permissions
            await RelatrFactory.ensureDataDirectory(validatedConfig.databasePath);
            
            // Step 1: Initialize Database Manager
            const dbManager = DatabaseManager.getInstance(validatedConfig.databasePath);
            await dbManager.initialize();
            
            // Use a single shared connection for all components to reduce transaction conflicts
            const sharedConnection = dbManager.getConnection();
            
            // Step 2: Initialize Repositories
            const metricsRepository: IMetricsRepository = new MetricsRepository(sharedConnection, validatedConfig.cacheTtlSeconds);
            const metadataRepository: IMetadataRepository = new MetadataRepository(sharedConnection);
            const settingsRepository: ISettingsRepository = new SettingsRepository(sharedConnection);

            // TA is optional and operator-controlled
            const taRepository = validatedConfig.taEnabled ? new TARepository(sharedConnection) : undefined;
            
            // Step 3: Initialize network components and builders first
            const pool = new RelayPool();
            const socialGraphBuilder = new SocialGraphBuilder(pool);
            const pubkeyMetadataFetcher = new PubkeyMetadataFetcher(pool, metadataRepository);

            // Step 4: Check if social graph exists and handle first-time setup
            let graphExists = false;
            try {
                const result = await sharedConnection.run(`
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
                logger.warn('Failed to check if social graph exists (expected during first-time setup):', error instanceof Error ? error.message : String(error));
                graphExists = false;
            }
            
            let creationResult: SocialGraphCreationResult | undefined;

            if (!graphExists) {
                logger.info('Social graph tables not found in database. Creating new graph...');
                
                creationResult = await socialGraphBuilder.createGraph({
                    sourcePubkey: validatedConfig.defaultSourcePubkey,
                    hops: validatedConfig.numberOfHops,
                    connection: sharedConnection
                });
                logger.info('Social graph created successfully.');
            }
            
            // Step 5: Initialize the social graph with the shared connection
            const socialGraph = new RelatrSocialGraph(sharedConnection, creationResult?.socialGraph);
            await socialGraph.initialize(validatedConfig.defaultSourcePubkey);
            
            const graphStats = await socialGraph.getStats();
            logger.info('Social graph stats', graphStats);
            
            // Step 6: Initialize trust calculation components
            // TrustCalculator uses the canonical default weighting scheme internally.
            const trustCalculator = new TrustCalculator(validatedConfig);
            const metricsValidator = new MetricsValidator(
                pool,
                validatedConfig.nostrRelays,
                socialGraph,
                metricsRepository,
                metadataRepository,
                validatedConfig.cacheTtlSeconds,
                ALL_PLUGINS,
            );
            
            // Step 7: Initialize specialized services
            const searchService = new SearchService(
                validatedConfig,
                metadataRepository,
                socialGraph,
                metricsValidator,
                trustCalculator,
                pool
            );
            
            // Initialize task queue service

            const schedulerService = new SchedulerService(
                validatedConfig,
                metricsRepository,
                socialGraph,
                metricsValidator,
                metadataRepository,
                pubkeyMetadataFetcher,
                settingsRepository,
                pool
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
                schedulerService
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
                })
              : null;
            
            // Step 8: If this is the first time running, fetch initial metadata
            if (!graphExists && (await metadataRepository.getStats()).totalEntries === 0) {
                logger.info('Fetching initial profile metadata...');
                try {
                    const keys = Object.keys(graphStats.sizeByDistance);
                    const maxDistance = keys.length ? Math.max(...keys.map(Number)) : null;
                    const pubkeys = await socialGraph.getAllUsersInGraph();
                    logger.info(`Found ${pubkeys.length.toLocaleString()} pubkeys within ${maxDistance || validatedConfig.numberOfHops} hops for metadata fetching`);
                    await pubkeyMetadataFetcher.fetchMetadata({
                        pubkeys,
                        sourcePubkey: validatedConfig.defaultSourcePubkey
                    });
                } catch (error) {
                    logger.warn('Initial metadata fetch failed:', error instanceof Error ? error.message : String(error));
                    // Continue despite metadata fetch failure
                }
            }
            
            // Step 9: Start background processes
            await schedulerService.start();
            logger.info('Background processes started');

            logger.debug('Relatr factory initialization completed');
            return {
                relatrService,
                taService
            };

        } catch (error) {
            // Cleanup on error
            logger.error('Factory initialization failed:', error instanceof Error ? error.message : String(error));
            if (error instanceof RelatrError) {
                throw error;
            }
            throw new RelatrError(`Factory initialization failed: ${error instanceof Error ? error.message : String(error)}`, 'FACTORY_INIT');
        }
    }

    /**
     * Ensure data directory exists with proper permissions
     * @private
     */
    private static async ensureDataDirectory(databasePath: string): Promise<void> {
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
                    const testFile = `${dataDir}/.write_test_${Date.now()}`;
                    await Bun.write(testFile, "test");
                    await Bun.$`rm ${testFile}`;
                } catch {
                  const effectiveUid = typeof process.getuid === "function" ? process.getuid() : null;
                  const effectiveGid = typeof process.getgid === "function" ? process.getgid() : null;

                    throw new RelatrError(
                        `Data directory exists but is not writable by current user (uid=${effectiveUid} gid=${effectiveGid}). ` +
                        `Please ensure the data directory has proper permissions or remove it to let the application create it.`,
                        'DATA_DIRECTORY_PERMISSIONS'
                    );
                }
            }
        } catch (error) {
            if (error instanceof RelatrError) {
                throw error;
            }
            throw new RelatrError(
                `Failed to ensure data directory: ${error instanceof Error ? error.message : String(error)}`,
                'DATA_DIRECTORY'
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