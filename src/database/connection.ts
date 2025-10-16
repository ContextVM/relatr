import { Database } from "bun:sqlite";
import { config } from "../config/environment";

/**
 * Database connection manager
 * Provides singleton access to the SQLite database with proper configuration
 */
export class DatabaseConnection {
    private static instance: DatabaseConnection;
    private db: Database | null = null;
    private isConnected = false;

    private constructor() {}

    /**
     * Get the singleton instance
     */
    static getInstance(): DatabaseConnection {
        if (!DatabaseConnection.instance) {
            DatabaseConnection.instance = new DatabaseConnection();
        }
        return DatabaseConnection.instance;
    }

    /**
     * Connect to the database
     */
    connect(): Database {
        if (this.db && this.isConnected) {
            return this.db;
        }

        try {
            console.log(`Connecting to database: ${config.DB_PATH}`);
            
            // Create database with optimized settings
            this.db = new Database(config.DB_PATH, { create: true });
            
            // Configure database for performance
            this.db.exec("PRAGMA foreign_keys = ON;");
            this.db.exec("PRAGMA journal_mode = WAL;");
            this.db.exec("PRAGMA synchronous = NORMAL;");
            this.db.exec("PRAGMA cache_size = 10000;");
            this.db.exec("PRAGMA temp_store = memory;");
            this.db.exec("PRAGMA busy_timeout = 30000;"); // 30 second timeout
            
            this.isConnected = true;
            console.log("Database connected successfully");
            
            return this.db;
        } catch (error) {
            console.error("Failed to connect to database:", error);
            throw new Error(`Database connection failed: ${error}`);
        }
    }

    /**
     * Get the database instance (connects if not already connected)
     */
    getDatabase(): Database {
        if (!this.db || !this.isConnected) {
            return this.connect();
        }
        return this.db;
    }

    /**
     * Close the database connection
     */
    close(): void {
        if (this.db) {
            try {
                this.db.close();
                this.db = null;
                this.isConnected = false;
                console.log("Database connection closed");
            } catch (error) {
                console.error("Error closing database:", error);
                throw new Error(`Failed to close database: ${error}`);
            }
        }
    }

    /**
     * Check if database is connected
     */
    isConnectedToDatabase(): boolean {
        return this.isConnected && this.db !== null;
    }

    /**
     * Execute a health check on the database
     */
    healthCheck(): boolean {
        try {
            const db = this.getDatabase();
            const result = db.query("SELECT 1 as test").get() as { test: number };
            return result.test === 1;
        } catch (error) {
            console.error("Database health check failed:", error);
            return false;
        }
    }

    /**
     * Get database statistics
     */
    getStats(): {
        isConnected: boolean;
        path: string;
        pageCount?: number;
        pageSize?: number;
        databaseSize?: number;
    } {
        const stats: {
            isConnected: boolean;
            path: string;
            pageCount?: number;
            pageSize?: number;
            databaseSize?: number;
        } = {
            isConnected: this.isConnected,
            path: config.DB_PATH
        };

        if (this.isConnected && this.db) {
            try {
                const pageResult = this.db.query("PRAGMA page_count").get() as { page_count: number };
                const sizeResult = this.db.query("PRAGMA page_size").get() as { page_size: number };
                
                stats.pageCount = pageResult.page_count;
                stats.pageSize = sizeResult.page_size;
                stats.databaseSize = pageResult.page_count * sizeResult.page_size;
            } catch (error) {
                console.error("Failed to get database stats:", error);
            }
        }

        return stats;
    }
}

/**
 * Export singleton instance for easy access
 */
export const dbConnection = DatabaseConnection.getInstance();

/**
 * Convenience function to get database instance
 */
export function getDatabase(): Database {
    return dbConnection.getDatabase();
}

/**
 * Initialize database connection (called during app startup)
 */
export function initializeDatabase(): Database {
    return dbConnection.connect();
}

/**
 * Close database connection (called during app shutdown)
 */
export function closeDatabase(): void {
    dbConnection.close();
}