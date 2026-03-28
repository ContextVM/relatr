import type { SettingsRepository } from "@/database/repositories/SettingsRepository";
import { Logger } from "@/utils/Logger";
import { nowSeconds } from "@/utils/utils";

const logger = new Logger({ service: "Nip05CacheStore" });

type Nip05ResolutionRecord = {
  pubkey: string | null;
  expiresAt: number;
};

const NIP05_RESOLUTION_PREFIX = "nip05:resolution:v1:";

function resolutionKey(nip05: string): string {
  return `${NIP05_RESOLUTION_PREFIX}${nip05}`;
}

function parseResolutionRecord(
  nip05: string,
  raw: string | null,
): Nip05ResolutionRecord | null {
  if (!raw) {
    return null;
  }

  try {
    const record = JSON.parse(raw) as Nip05ResolutionRecord;
    if (typeof record.expiresAt !== "number") {
      return null;
    }

    return record;
  } catch (error) {
    logger.warn(
      `Failed to parse cached NIP-05 resolution for ${nip05}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export class Nip05CacheStore {
  constructor(private settingsRepository: SettingsRepository) {}

  async getResolution(
    nip05: string,
  ): Promise<{ pubkey: string | null } | null> {
    const record = parseResolutionRecord(
      nip05,
      await this.settingsRepository.get(resolutionKey(nip05)),
    );
    if (!record) {
      return null;
    }

    if (record.expiresAt <= nowSeconds()) {
      await this.settingsRepository.delete(resolutionKey(nip05));
      return null;
    }

    return {
      pubkey: typeof record.pubkey === "string" ? record.pubkey : null,
    };
  }

  async getResolutionBatch(
    nip05s: string[],
  ): Promise<Map<string, { pubkey: string | null } | null>> {
    if (nip05s.length === 0) {
      return new Map();
    }

    const now = nowSeconds();
    const rawRecords = await this.settingsRepository.getBatch(
      nip05s.map((nip05) => resolutionKey(nip05)),
    );
    const resolutions = new Map<string, { pubkey: string | null } | null>();
    const expiredKeys: string[] = [];

    for (const nip05 of nip05s) {
      const record = parseResolutionRecord(
        nip05,
        rawRecords.get(resolutionKey(nip05)) ?? null,
      );

      if (!record) {
        resolutions.set(nip05, null);
        continue;
      }

      if (record.expiresAt <= now) {
        expiredKeys.push(resolutionKey(nip05));
        resolutions.set(nip05, null);
        continue;
      }

      resolutions.set(nip05, {
        pubkey: typeof record.pubkey === "string" ? record.pubkey : null,
      });
    }

    await Promise.all(
      expiredKeys.map((key) => this.settingsRepository.delete(key)),
    );

    return resolutions;
  }

  async setResolution(input: {
    nip05: string;
    pubkey: string | null;
    ttlSeconds: number;
  }): Promise<void> {
    const expiresAt = nowSeconds() + input.ttlSeconds;
    const record: Nip05ResolutionRecord = {
      pubkey: input.pubkey,
      expiresAt,
    };
    await this.settingsRepository.set(
      resolutionKey(input.nip05),
      JSON.stringify(record),
    );
  }
}
