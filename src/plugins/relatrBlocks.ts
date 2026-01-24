import { Logger } from "../utils/Logger";

const logger = new Logger({ service: "RelatrBlocks" });

export interface ExtractedRelatrBlocks {
  /**
   * Original source with well-formed RELATR blocks removed.
   * Malformed/unclosed blocks are left intact (non-fatal).
   */
  strippedSource: string;
  /** Raw lines between marker pairs, in file order. */
  blocks: string[];
}

/**
 * Extract RELATR blocks delimited by lines that equal `--RELATR` (after trim).
 *
 * Rules:
 * - Only well-formed start/end pairs are removed.
 * - Malformed/unclosed blocks are ignored non-fatally and left in the source.
 */
export function extractRelatrBlocks(source: string): ExtractedRelatrBlocks {
  const lines = source.split(/\r?\n/);

  const blocks: string[] = [];
  const rangesToRemove: Array<{ startLine: number; endLine: number }> = [];

  let openStart: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed !== "--RELATR") continue;

    if (openStart === null) {
      openStart = i;
    } else {
      // Close block.
      const bodyLines = lines.slice(openStart + 1, i);
      blocks.push(bodyLines.join("\n"));
      rangesToRemove.push({ startLine: openStart, endLine: i });
      openStart = null;
    }
  }

  if (openStart !== null) {
    logger.warn(
      `Found unterminated --RELATR block starting at line ${openStart + 1}; leaving source intact for that block`,
    );
  }

  if (rangesToRemove.length === 0) {
    return { strippedSource: source, blocks };
  }

  // Remove ranges in a single pass.
  const removeByLineIndex = new Set<number>();
  for (const r of rangesToRemove) {
    for (let i = r.startLine; i <= r.endLine; i++) removeByLineIndex.add(i);
  }

  const keptLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!removeByLineIndex.has(i)) keptLines.push(lines[i]!);
  }

  return { strippedSource: keptLines.join("\n"), blocks };
}
