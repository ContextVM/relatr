type Nip05NamesResponse = {
  names?: Record<string, string>;
};

export type Nip05ResolveHttpResult = { pubkey: string | null };

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

    if (!response.ok) {
      throw new Error(`Bad response: ${response.status}`);
    }

    const payload = (await response.json()) as Nip05NamesResponse;
    return { pubkey: payload.names?.[parsed.name.toLowerCase()] ?? null };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.message.includes("This operation was aborted"))
    ) {
      throw new Error(`Operation timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
