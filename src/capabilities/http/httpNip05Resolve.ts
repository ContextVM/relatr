import { Logger } from "@/utils/Logger";
import { queryProfile } from "nostr-tools/nip05";
import type { CapabilityHandler } from "../CapabilityRegistry";
import { nip05DomainOf, normalizeNip05 } from "./utils/httpNip05Normalize";
import { withTimeout } from "@/utils/utils";

const logger = new Logger({ service: "httpNip05Resolve" });

type Nip05ResolveResult = { pubkey: string | null };

/**
 * HTTP NIP-05 resolution capability
 * Args: { nip05: string }
 * Returns: { pubkey: string | null }
 */
export const httpNip05Resolve: CapabilityHandler = async (args, context) => {
  const nip05 = args?.nip05;
  if (!nip05 || typeof nip05 !== "string") {
    return { pubkey: null };
  }

  try {
    // Ensure proper NIP-05 format and consistent casing for caching.
    const formattedNip05 = normalizeNip05(nip05);
    if (!formattedNip05) {
      return { pubkey: null };
    }

    // Fail-fast for domains that have already timed out in this run.
    const domain = nip05DomainOf(formattedNip05);
    const badDomains = context.capRunCache?.nip05BadDomains;
    if (domain && badDomains?.has(domain)) {
      return { pubkey: null };
    }

    const cache = context.capRunCache?.nip05Resolve;
    if (cache) {
      const cached = cache.get(formattedNip05);
      if (cached) {
        return await cached;
      }
    }

    const timeoutMs = context.config.capTimeoutMs;
    const promise = (async (): Promise<Nip05ResolveResult> => {
      try {
        const result = await withTimeout(
          queryProfile(formattedNip05),
          timeoutMs,
        );

        if (result?.pubkey) {
          logger.debug(
            `NIP-05 resolution successful: ${nip05} -> ${result.pubkey}`,
          );
          return { pubkey: result.pubkey };
        }

        return { pubkey: null };
      } catch (error) {
        logger.warn(
          `NIP-05 resolution failed for ${nip05}: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Mark this domain as bad for the remainder of the validation run,
        // but only for timeout-style failures.
        const msg = error instanceof Error ? error.message : String(error);
        if (domain && badDomains && msg.includes("Operation timed out")) {
          badDomains.set(domain, true);
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
