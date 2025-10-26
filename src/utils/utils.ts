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
