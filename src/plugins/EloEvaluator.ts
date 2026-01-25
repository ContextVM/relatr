import { compile } from "@contextvm/elo";
import { DateTime, Duration } from "luxon";
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
const compilationCache = new Map<string, (_: EloInput) => unknown>();

/**
 * Compile Elo code to a JavaScript function
 * @param source - The Elo source code
 * @param cacheKey - Optional cache key
 * @returns Compiled function
 */
export function compileElo(
  source: string,
  cacheKey?: string,
): (_: EloInput) => unknown {
  // Check compilation cache
  if (cacheKey) {
    const cached = compilationCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  try {
    // Compile Elo to JavaScript function
    // Provide runtime dependencies required by Elo for DateTime/Duration.
    // Without these, evaluating expressions can throw errors like:
    //   "undefined is not an object (evaluating 'Duration.isDuration')"
    // even if the user expression doesn't explicitly reference them.
    const compiled = compile(source, {
      runtime: { DateTime, Duration },
    }) as any;

    // Cache the compiled function
    if (cacheKey) {
      compilationCache.set(cacheKey, compiled);
    }

    return (_: EloInput) => {
      try {
        // `compile()` returns a function that takes `_` as its argument.
        // (See docs excerpt in `plans/elo-reference.md`.)
        if (typeof compiled === "function") return compiled(_);

        // Some builds may return an object with an evaluate method.
        if (compiled && typeof compiled.evaluate === "function")
          return compiled.evaluate(_);

        return compiled;
      } catch (e) {
        logger.error(`Elo execution error: ${e}`);
        throw e;
      }
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to compile Elo: ${errorMsg}`);
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
  sourceOverride?: string,
): Promise<EloEvaluationResult> {
  const startTime = Date.now();

  try {
    // Compile the Elo code (or get from cache)
    // If sourceOverride is provided, we don't use the plugin ID as cache key
    // because the rewritten source might change per evaluation.
    const compiledFn = compileElo(
      sourceOverride || plugin.content,
      sourceOverride ? undefined : plugin.id,
    );

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
      if (result instanceof Promise) {
        result.then(
          (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      } else {
        clearTimeout(timer);
        resolve(result);
      }
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * Clamp score to [0, 1] range
 */
function clampScore(value: unknown): number {
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
