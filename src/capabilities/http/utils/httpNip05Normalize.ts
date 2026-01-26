/**
 * Host-side normalization helpers for the `http.nip05_resolve` capability.
 *
 * This is intentionally *not* part of the Elo plugin spec. It's a host policy
 * optimization so that equivalent requests dedupe better (requestKey stability)
 * and caches are more effective.
 */

export function normalizeNip05(nip05: string): string {
  const trimmed = nip05.trim();
  if (trimmed.length === 0) return "";

  // NIP-05 identifiers are case-insensitive for the domain portion.
  // The name part is typically treated case-insensitively in practice as well.
  // We lower-case the entire identifier to maximize dedupe.
  const lower = trimmed.toLowerCase();

  // Ensure proper NIP-05 format: <name>@<domain>. If only domain is provided,
  // use the '_' wildcard name.
  const formatted = lower.includes("@") ? lower : `_@${lower}`;

  // Collapse accidental whitespace around '@'.
  return formatted.replace(/\s*@\s*/g, "@");
}

export function nip05DomainOf(normalizedNip05: string): string | null {
  const at = normalizedNip05.lastIndexOf("@");
  if (at === -1) return null;
  const domain = normalizedNip05.slice(at + 1).trim();
  return domain.length > 0 ? domain : null;
}
