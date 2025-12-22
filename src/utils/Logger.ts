/**
 * Standardized logging service for Relatr
 * Provides consistent logging with levels and structured output
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LoggerOptions {
  level?: LogLevel;
  service?: string;
  timestamp?: boolean;
}

export class Logger {
  private level: LogLevel;
  private service: string;
  private timestamp: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.service = options.service ?? "Relatr";
    this.timestamp = options.timestamp ?? true;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  private formatMessage(
    level: string,
    message: string,
    ...args: unknown[]
  ): string {
    const timestamp = this.timestamp ? `[${new Date().toISOString()}]` : "";
    const service = this.service ? `[${this.service}]` : "";
    const levelTag = `[${level}]`;

    const baseMessage = `${timestamp}${service}${levelTag} ${message}`;

    if (args.length > 0) {
      return `${baseMessage} ${args
        .map((arg) => this.serializeArg(arg))
        .join(" ")}`;
    }

    return baseMessage;
  }

  private serializeArg(arg: unknown): string {
    if (arg instanceof Error) {
      const errorObj: Record<string, unknown> = {
        name: arg.name,
        message: arg.message,
        stack: arg.stack,
      };
      if (arg.cause) {
        errorObj.cause = this.serializeArg(arg.cause);
      }
      return JSON.stringify(errorObj, null, 2);
    }

    if (typeof arg === "object" && arg !== null) {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        // If JSON.stringify fails (e.g., circular references), fall back to String
        return String(arg);
      }
    }

    return String(arg);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.debug(this.formatMessage("DEBUG", message, ...args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage("INFO", message, ...args));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage("WARN", message, ...args));
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage("ERROR", message, ...args));
    }
  }

  // Create a child logger with a specific service name
  child(service: string): Logger {
    return new Logger({
      level: this.level,
      service: `${this.service}:${service}`,
      timestamp: this.timestamp,
    });
  }

  // Static factory for common use cases
  static create(service?: string): Logger {
    const level =
      process.env.NODE_ENV === "production" ? LogLevel.INFO : LogLevel.DEBUG;
    return new Logger({ level, service });
  }
}

// Default logger instance
export const logger = Logger.create();
