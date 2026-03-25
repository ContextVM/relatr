import { Logger } from "@/utils/Logger";
import type { CapabilityHandler } from "../CapabilityRegistry";
import { nip05DomainOf, normalizeNip05 } from "./utils/httpNip05Normalize";
import { resolveNip05WithAbortableFetch } from "./utils/resolveNip05Http";

const logger = new Logger({ service: "httpNip05Resolve" });

type Nip05ResolveResult = { pubkey: string | null };
type Nip05ResolveArgs = { nip05?: unknown };

function readNip05Arg(args: unknown): string | null {
  if (!args || typeof args !== "object") {
    return null;
  }

  const { nip05 } = args as Nip05ResolveArgs;
  return typeof nip05 === "string" ? nip05 : null;
}

export function shouldMarkNip05DomainBad(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  return [
    "operation timed out",
    "timed out",
    "timeout",
    "fetch failed",
    "network",
    "econnrefused",
    "enotfound",
    "eai_again",
    "tls",
    "certificate",
    "unreachable",
    "refused",
    "bad response",
    "invalid json",
    "404",
    "410",
  ].some((token) => message.includes(token));
}

/**
 * HTTP NIP-05 resolution capability
 * Args: { nip05: string }
 * Returns: { pubkey: string | null }
 */
export const httpNip05Resolve: CapabilityHandler = async (args, context) => {
  const nip05 = readNip05Arg(args);
  if (!nip05) {
    return { pubkey: null };
  }

  try {
    // Ensure proper NIP-05 format and consistent casing for caching.
    const formattedNip05 = normalizeNip05(nip05);
    if (!formattedNip05) {
      return { pubkey: null };
    }

    // Fail-fast for domains that have already failed terminally in this run.
    const domain = nip05DomainOf(formattedNip05);
    const badDomains = context.capRunCache?.nip05BadDomains;
    if (domain && badDomains?.has(domain)) {
      return { pubkey: null };
    }

    const persistentStore = context.nip05CacheStore;
    if (domain && persistentStore) {
      const coolingDown = await persistentStore.isDomainCoolingDown(domain);
      if (coolingDown) {
        badDomains?.set(domain, true);
        return { pubkey: null };
      }
    }

    if (persistentStore) {
      const persisted = await persistentStore.getResolution(formattedNip05);
      if (persisted) {
        return persisted;
      }
    }

    const cache = context.capRunCache?.nip05Resolve;
    if (cache) {
      const cached = cache.get(formattedNip05);
      if (cached) {
        return await cached;
      }
    }

    const preparedResults = context.capRunCache?.nip05PreparedResults;
    if (preparedResults?.has(formattedNip05)) {
      return preparedResults.get(formattedNip05) ?? { pubkey: null };
    }

    if (context.capRunCache?.nip05LiveFetchDisabled) {
      logger.debug(
        `Skipping live NIP-05 fetch for ${formattedNip05} because the current run is using prepared facts`,
      );
      return { pubkey: null };
    }

    const timeoutMs = Math.min(
      context.config.capTimeoutMs,
      context.config.nip05ResolveTimeoutMs,
    );
    const promise = (async (): Promise<Nip05ResolveResult> => {
      try {
        const result = await resolveNip05WithAbortableFetch(
          formattedNip05,
          timeoutMs,
        );

        if (result?.pubkey) {
          if (persistentStore) {
            await persistentStore.setResolution({
              nip05: formattedNip05,
              pubkey: result.pubkey,
              ttlSeconds: context.config.nip05CacheTtlSeconds,
            });
          }
          logger.debug(
            `NIP-05 resolution successful: ${nip05} -> ${result.pubkey}`,
          );
          return { pubkey: result.pubkey };
        }

        if (persistentStore) {
          await persistentStore.setResolution({
            nip05: formattedNip05,
            pubkey: null,
            ttlSeconds: context.config.nip05CacheTtlSeconds,
          });
        }

        return { pubkey: null };
      } catch (error) {
        logger.warn(
          `NIP-05 resolution failed for ${nip05}: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Mark this domain as bad for the remainder of the validation run
        // for clearly terminal or transport-style failures.
        if (domain && badDomains && shouldMarkNip05DomainBad(error)) {
          badDomains.set(domain, true);
        }

        if (domain && persistentStore && shouldMarkNip05DomainBad(error)) {
          await persistentStore.markDomainCooldown(
            domain,
            context.config.nip05DomainCooldownSeconds,
          );
        }

        return { pubkey: null };
      }
    })();

    if (cache) {
      cache.set(formattedNip05, promise);
    }

    return await promise;
  } catch (error) {
    logger.error(
      `Unexpected error resolving NIP-05 for ${nip05}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { pubkey: null };
  }
};
