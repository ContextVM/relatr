import type { LruCache } from "@/utils/lru-cache";
import type { NostrProfile } from "@/types";

export interface ValidationRunContext {
  preparedMetadataProfiles?: Map<string, NostrProfile | null>;
  metadataPreparedForPubkeys?: Set<string>;
  nip05PreparedResults?: LruCache<{ pubkey: string | null }>;
  nip05LiveFetchDisabled?: boolean;
}
