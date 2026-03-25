export class MetadataRefreshTracker {
  private pendingBootstrapSignature: string | null = null;

  markBootstrapFresh(pubkeys: string[], sourcePubkey?: string): void {
    this.pendingBootstrapSignature = this.buildSignature(pubkeys, sourcePubkey);
  }

  consumeBootstrapCoverage(pubkeys: string[], sourcePubkey?: string): boolean {
    const signature = this.buildSignature(pubkeys, sourcePubkey);
    if (!signature || this.pendingBootstrapSignature !== signature) {
      return false;
    }

    this.pendingBootstrapSignature = null;
    return true;
  }

  private buildSignature(
    pubkeys: string[],
    sourcePubkey?: string,
  ): string | null {
    if (pubkeys.length === 0) {
      return null;
    }

    const normalizedPubkeys = [...pubkeys].sort();
    return `${sourcePubkey ?? ""}::${normalizedPubkeys.join(",")}`;
  }
}
