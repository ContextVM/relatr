import type { NostrProfile } from "../types";

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Helper method to sanitize profile by removing null values
 * @private
 */
export function sanitizeProfile(profile: NostrProfile): NostrProfile {
  const sanitized: NostrProfile = { pubkey: profile.pubkey };

  // Only include non-null, non-undefined string values
  if (profile.name) sanitized.name = profile.name;
  if (profile.display_name) sanitized.display_name = profile.display_name;
  if (profile.picture) sanitized.picture = profile.picture;
  if (profile.nip05) sanitized.nip05 = profile.nip05;
  if (profile.lud16) sanitized.lud16 = profile.lud16;
  if (profile.about) sanitized.about = profile.about;

  return sanitized;
}

/**
 * Unified distance normalization utilities
 * Single source of truth for distance normalization logic
 */

/**
 * Normalize distance using exponential decay formula: e^(-α × distance)
 * @param distance - Social distance in hops
 * @param decayFactor - Decay factor (default: 0.5)
 * @returns Normalized distance value [0,1]
 */
export function normalizeDistance(
  distance: number,
  decayFactor: number = 0.5,
): number {
  if (
    typeof distance !== "number" ||
    distance < 0 ||
    isNaN(distance) ||
    !isFinite(distance)
  ) {
    throw new Error("Distance must be a non-negative finite number");
  }

  if (distance <= 1) {
    // Direct connections (distance 0 or 1) get full trust score
    return 1.0;
  }

  // Special case: distance = 1000 → normalized = 0.0 (unreachable)
  if (distance === 1000) {
    return 0.0;
  }

  // Apply exponential decay: e^(-α × distance)
  const normalized = Math.exp(-decayFactor * distance);

  // Ensure result is in [0,1] range
  return Math.max(0.0, Math.min(1.0, normalized));
}
