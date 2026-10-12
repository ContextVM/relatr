type Nip05NamesResponse = {
  names?: Record<string, string>;
};

export type Nip05ResolveHttpResult = { pubkey: string | null };

/**
 * The NIP-05 domain could not be reached (network or TLS failure, timeout, rate limiting, or a server
 * error). Unlike a definitive `{ pubkey: null }`, this says nothing about whether the name is valid.
 */
export class Nip05TransportError extends Error {
  constructor(
    readonly domain: string,
    message: string,
  ) {
    super(message);
    this.name = "Nip05TransportError";
  }
}

export function splitNormalizedNip05(
  nip05: string,
): { name: string; domain: string } | null {
  const atIndex = nip05.indexOf("@");
  if (atIndex <= 0 || atIndex === nip05.length - 1) {
    return null;
  }

  return {
    name: nip05.slice(0, atIndex),
    domain: nip05.slice(atIndex + 1),
  };
}

/**
 * Resolves a normalized NIP-05 identifier over HTTP.
 *
 * Returns `{ pubkey: null }` when the domain answers definitively that the name does not resolve
 * (unknown name, non-retryable HTTP status, or a malformed document). Throws `Nip05TransportError`
 * when the domain cannot be reached.
 */
export async function resolveNip05WithAbortableFetch(
  formattedNip05: string,
  timeoutMs: number,
): Promise<Nip05ResolveHttpResult> {
  const parsed = splitNormalizedNip05(formattedNip05);
  if (!parsed) {
    return { pubkey: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://${parsed.domain}/.well-known/nostr.json?name=${encodeURIComponent(parsed.name)}`,
      {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json",
        },
      },
    );

    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Bad response: ${response.status}`);
    }
    if (!response.ok) {
      return { pubkey: null };
    }

    let payload: Nip05NamesResponse | null;
    try {
      payload = (await response.json()) as Nip05NamesResponse | null;
    } catch (error) {
      // Only malformed JSON is a definitive negative answer; failed body reads are transport errors.
      if (error instanceof SyntaxError && !controller.signal.aborted) {
        return { pubkey: null };
      }
      throw error;
    }

    const pubkey = payload?.names?.[parsed.name.toLowerCase()];
    return { pubkey: typeof pubkey === "string" ? pubkey : null };
  } catch (error) {
    throw new Nip05TransportError(
      parsed.domain,
      controller.signal.aborted
        ? `Operation timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}
