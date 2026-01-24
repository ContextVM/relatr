import { queryProfile } from "nostr-tools/nip05";
import { withTimeout } from "../utils/utils";
import type { CapabilityHandler } from "./CapabilityRegistry";
import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "httpNip05Resolve" });

/**
 * HTTP NIP-05 resolution capability
 * Args: { nip05: string }
 * Returns: { pubkey: string | null }
 */
export const httpNip05Resolve: CapabilityHandler = async (args, _context) => {
  const nip05 = args?.nip05;
  if (!nip05 || typeof nip05 !== "string") {
    return { pubkey: null };
  }

  try {
    // Ensure proper NIP-05 format
    const formattedNip05 = nip05.includes("@") ? nip05 : `_@${nip05}`;

    // Use 10 second timeout for NIP-05 resolution
    const result = await withTimeout(queryProfile(formattedNip05), 10000);

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
    return { pubkey: null };
  }
};
