import { compile } from "@enspirit/elo";
import type {
  PortablePlugin,
  EloInput,
  EloEvaluationResult,
} from "./plugin-types";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "EloEvaluator" });

/**
 * Cache for compiled Elo functions
 */
const compilationCache = new Map<string, (_: any) => any>();

/**
 * Compile Elo code to a JavaScript function
 * @param plugin - The portable plugin containing Elo code
 * @returns Compiled function
 */
function compileElo(plugin: PortablePlugin): (_: any) => any {
  const cacheKey = plugin.id;

  // Check compilation cache
  const cached = compilationCache.get(cacheKey);
  if (cached) {
    logger.debug(
      `Using cached compilation for plugin: ${plugin.manifest.name}`,
    );
    return cached;
  }

  try {
    logger.debug(`Compiling Elo for plugin: ${plugin.manifest.name}`);

    // Compile Elo to JavaScript function
    // The compiled function takes an input object "_" and returns a value
    const compiled = compile(plugin.content) as (_: any) => any;

    // Cache the compiled function
    compilationCache.set(cacheKey, compiled);

    logger.debug(
      `Successfully compiled Elo for plugin: ${plugin.manifest.name}`,
    );
    return compiled;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to compile Elo for plugin ${plugin.manifest.name}: ${errorMsg}`,
    );
    throw new Error(`Elo compilation failed: ${errorMsg}`);
  }
}

/**
 * Evaluate a plugin's Elo code with the given input
 * @param plugin - The portable plugin to evaluate
 * @param input - The Elo input object
 * @param timeoutMs - Timeout in milliseconds
 * @returns Evaluation result
 */
export async function evaluateElo(
  plugin: PortablePlugin,
  input: EloInput,
  timeoutMs: number = 200,
): Promise<EloEvaluationResult> {
  const startTime = Date.now();

  try {
    // Compile the Elo code (or get from cache)
    const compiledFn = compileElo(plugin);

    // Execute with timeout
    const result = await executeWithTimeout(() => compiledFn(input), timeoutMs);

    // Validate and clamp result to [0, 1]
    const score = clampScore(result);

    const elapsedMs = Date.now() - startTime;

    logger.debug(
      `Plugin ${plugin.manifest.name} evaluated to score: ${score} in ${elapsedMs}ms`,
    );

    return {
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      score,
      success: true,
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    logger.warn(
      `Plugin ${plugin.manifest.name} evaluation failed: ${errorMsg}`,
    );

    return {
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      score: 0.0, // Safe default on error
      success: false,
      error: errorMsg,
      elapsedMs,
    };
  }
}

/**
 * Execute a function with timeout
 */
async function executeWithTimeout<T>(
  fn: () => T,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Elo evaluation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = fn();
      clearTimeout(timer);
      resolve(result);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * Clamp score to [0, 1] range
 */
function clampScore(value: any): number {
  if (typeof value !== "number") {
    logger.warn(
      `Elo evaluation returned non-numeric value: ${typeof value}, defaulting to 0.0`,
    );
    return 0.0;
  }

  if (isNaN(value) || !isFinite(value)) {
    logger.warn(
      `Elo evaluation returned invalid number: ${value}, defaulting to 0.0`,
    );
    return 0.0;
  }

  return Math.max(0.0, Math.min(1.0, value));
}

/**
 * Clear the compilation cache (useful for testing)
 */
export function clearCompilationCache(): void {
  compilationCache.clear();
  logger.info("Elo compilation cache cleared");
}

/**
 * Get compilation cache statistics
 */
export function getCompilationCacheStats(): { size: number } {
  return { size: compilationCache.size };
}
