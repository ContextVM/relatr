/**
 * Database error handling utilities
 * Provides standardized error types and handling for database operations
 */

/**
 * Base database error class
 */
export class DatabaseError extends Error {
    public readonly code: string;
    public readonly query?: string;
    public readonly params?: Record<string, any>;
    public readonly originalError?: Error;

    constructor(
        message: string,
        code: string = 'DATABASE_ERROR',
        query?: string,
        params?: Record<string, any>,
        originalError?: Error
    ) {
        super(message);
        this.name = 'DatabaseError';
        this.code = code;
        this.query = query;
        this.params = params;
        this.originalError = originalError;
        
        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, DatabaseError);
        }
    }

    /**
     * Get a detailed error description
     */
    getDetails(): string {
        let details = `${this.code}: ${this.message}`;
        
        if (this.query) {
            details += `\nQuery: ${this.query}`;
        }
        
        if (this.params) {
            details += `\nParams: ${JSON.stringify(this.params, null, 2)}`;
        }
        
        if (this.originalError) {
            details += `\nOriginal error: ${this.originalError.message}`;
        }
        
        return details;
    }

    /**
     * Convert to a JSON-serializable object
     */
    toJSON(): {
        name: string;
        code: string;
        message: string;
        query?: string;
        params?: Record<string, any>;
        stack?: string;
    } {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            query: this.query,
            params: this.params,
            stack: this.stack
        };
    }
}

/**
 * Connection error
 */
export class ConnectionError extends DatabaseError {
    constructor(message: string, originalError?: Error) {
        super(message, 'CONNECTION_ERROR', undefined, undefined, originalError);
        this.name = 'ConnectionError';
    }
}

/**
 * Query execution error
 */
export class QueryError extends DatabaseError {
    constructor(message: string, query: string, params?: Record<string, any>, originalError?: Error) {
        super(message, 'QUERY_ERROR', query, params, originalError);
        this.name = 'QueryError';
    }
}

/**
 * Transaction error
 */
export class TransactionError extends DatabaseError {
    constructor(message: string, originalError?: Error) {
        super(message, 'TRANSACTION_ERROR', undefined, undefined, originalError);
        this.name = 'TransactionError';
    }
}

/**
 * Constraint violation error
 */
export class ConstraintError extends DatabaseError {
    constructor(message: string, query: string, params?: Record<string, any>, originalError?: Error) {
        super(message, 'CONSTRAINT_ERROR', query, params, originalError);
        this.name = 'ConstraintError';
    }
}

/**
 * Timeout error
 */
export class TimeoutError extends DatabaseError {
    constructor(message: string, query?: string, params?: Record<string, any>, originalError?: Error) {
        super(message, 'TIMEOUT_ERROR', query, params, originalError);
        this.name = 'TimeoutError';
    }
}

/**
 * Error handler utility class
 */
export class DatabaseErrorHandler {
    /**
     * Wrap a database operation with error handling
     */
    static async handleOperation<T>(
        operation: () => Promise<T>,
        context?: {
            operation?: string;
            query?: string;
            params?: Record<string, any>;
        }
    ): Promise<{ success: boolean; data?: T; error?: DatabaseError }> {
        try {
            const result = await operation();
            return { success: true, data: result };
        } catch (error) {
            const dbError = this.parseError(error, context);
            return { success: false, error: dbError };
        }
    }

    /**
     * Parse and categorize database errors
     */
    static parseError(
        error: any,
        context?: {
            operation?: string;
            query?: string;
            params?: Record<string, any>;
        }
    ): DatabaseError {
        const errorMessage = error?.message || String(error);
        const { query, params, operation } = context || {};

        // SQLite error patterns
        if (errorMessage.includes('SQLITE_CONSTRAINT')) {
            return new ConstraintError(
                `Database constraint violation${operation ? ` during ${operation}` : ''}: ${errorMessage}`,
                query || '',
                params,
                error
            );
        }

        if (errorMessage.includes('SQLITE_BUSY') || errorMessage.includes('database is locked')) {
            return new TimeoutError(
                `Database timeout${operation ? ` during ${operation}` : ''}: ${errorMessage}`,
                query || '',
                params,
                error
            );
        }

        if (errorMessage.includes('SQLITE_CANTOPEN') || errorMessage.includes('no such table')) {
            return new ConnectionError(
                `Database connection or schema error${operation ? ` during ${operation}` : ''}: ${errorMessage}`,
                error
            );
        }

        if (errorMessage.includes('SQLITE_ERROR')) {
            return new QueryError(
                `Database query error${operation ? ` during ${operation}` : ''}: ${errorMessage}`,
                query || '',
                params,
                error
            );
        }

        // Transaction errors
        if (errorMessage.includes('transaction') || errorMessage.includes('rollback')) {
            return new TransactionError(
                `Transaction error${operation ? ` during ${operation}` : ''}: ${errorMessage}`,
                error
            );
        }

        // Generic database error
        return new DatabaseError(
            `Database error${operation ? ` during ${operation}` : ''}: ${errorMessage}`,
            'DATABASE_ERROR',
            query || '',
            params,
            error
        );
    }

    /**
     * Log database errors with context
     */
    static logError(error: DatabaseError, context?: {
        operation?: string;
        userId?: string;
        requestId?: string;
    }): void {
        const logData = {
            timestamp: new Date().toISOString(),
            error: error.toJSON(),
            context: context
        };

        console.error('Database Error:', JSON.stringify(logData, null, 2));
    }

    /**
     * Check if an error is retryable
     */
    static isRetryable(error: DatabaseError): boolean {
        return (
            error instanceof TimeoutError ||
            error.code === 'SQLITE_BUSY' ||
            error.code === 'DATABASE_LOCKED'
        );
    }

    /**
     * Retry a database operation with exponential backoff
     */
    static async retryOperation<T>(
        operation: () => Promise<T>,
        maxRetries: number = 3,
        baseDelay: number = 1000,
        context?: {
            operation?: string;
            query?: string;
            params?: Record<string, any>;
        }
    ): Promise<{ success: boolean; data?: T; error?: DatabaseError }> {
        let lastError: DatabaseError | undefined;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const result = await DatabaseErrorHandler.handleOperation(operation, context);
            
            if (result.success) {
                return result;
            }

            lastError = result.error;

            // Don't retry non-retryable errors
            if (lastError && !DatabaseErrorHandler.isRetryable(lastError)) {
                break;
            }

            // Don't wait after the last attempt
            if (attempt < maxRetries && lastError) {
                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.warn(`Database operation failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${lastError.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        return { success: false, error: lastError };
    }
}

/**
 * Error boundary for database operations
 */
export class DatabaseErrorBoundary {
    /**
     * Execute an operation with comprehensive error handling
     */
    async execute<T>(
        operation: () => Promise<T>,
        options: {
            operation?: string;
            query?: string;
            params?: Record<string, any>;
            retry?: boolean;
            maxRetries?: number;
            logErrors?: boolean;
        } = {}
    ): Promise<{ success: boolean; data?: T; error?: DatabaseError }> {
        const {
            operation: opName,
            query,
            params,
            retry = false,
            maxRetries = 3,
            logErrors = true
        } = options;

        const context = {
            operation: opName,
            query,
            params
        };

        const result = retry
            ? await DatabaseErrorHandler.retryOperation(operation, maxRetries, 1000, context)
            : await DatabaseErrorHandler.handleOperation(operation, context);

        if (!result.success && logErrors && result.error) {
            DatabaseErrorHandler.logError(result.error, context);
        }

        return result;
    }
}

/**
 * Export singleton error boundary
 */
export const errorBoundary = new DatabaseErrorBoundary();