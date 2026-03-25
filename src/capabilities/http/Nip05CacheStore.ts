import type { SettingsRepository } from "@/database/repositories/SettingsRepository";
import { Logger } from "@/utils/Logger";
import { nowSeconds } from "@/utils/utils";

const logger = new Logger({ service: "Nip05CacheStore" });

type Nip05ResolutionRecord = {
  pubkey: string | null;
  expiresAt: number;
};

type Nip05DomainCooldownRecord = {
  expiresAt: number;
};

const NIP05_RESOLUTION_PREFIX = "nip05:resolution:v1:";
const NIP05_DOMAIN_COOLDOWN_PREFIX = "nip05:domain-cooldown:v1:";

function resolutionKey(nip05: string): string {
  return `${NIP05_RESOLUTION_PREFIX}${nip05}`;
}

function domainCooldownKey(domain: string): string {
  return `${NIP05_DOMAIN_COOLDOWN_PREFIX}${domain}`;
}

export class Nip05CacheStore {
  constructor(private settingsRepository: SettingsRepository) {}

  async getResolution(
    nip05: string,
  ): Promise<{ pubkey: string | null } | null> {
    const raw = await this.settingsRepository.get(resolutionKey(nip05));
    if (!raw) {
      return null;
    }

    try {
      const record = JSON.parse(raw) as Nip05ResolutionRecord;
      if (typeof record.expiresAt !== "number") {
        return null;
      }

      if (record.expiresAt <= nowSeconds()) {
        await this.settingsRepository.delete(resolutionKey(nip05));
        return null;
      }

      return {
        pubkey: typeof record.pubkey === "string" ? record.pubkey : null,
      };
    } catch (error) {
      logger.warn(
        `Failed to parse cached NIP-05 resolution for ${nip05}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
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

  async isDomainCoolingDown(domain: string): Promise<boolean> {
    const raw = await this.settingsRepository.get(domainCooldownKey(domain));
    if (!raw) {
      return false;
    }

    try {
      const record = JSON.parse(raw) as Nip05DomainCooldownRecord;
      if (typeof record.expiresAt !== "number") {
        return false;
      }

      if (record.expiresAt <= nowSeconds()) {
        await this.settingsRepository.delete(domainCooldownKey(domain));
        return false;
      }

      return true;
    } catch (error) {
      logger.warn(
        `Failed to parse NIP-05 cooldown for ${domain}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async markDomainCooldown(domain: string, ttlSeconds: number): Promise<void> {
    const expiresAt = nowSeconds() + ttlSeconds;
    const record: Nip05DomainCooldownRecord = { expiresAt };
    await this.settingsRepository.set(
      domainCooldownKey(domain),
      JSON.stringify(record),
    );
  }
}
