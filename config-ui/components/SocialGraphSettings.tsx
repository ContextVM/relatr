import { RelayListInput } from "./RelayListInput";

interface SocialGraphSettingsProps {
  defaultSourcePubkey: string;
  nostrRelays: string[];
  onDefaultSourcePubkeyChange: (value: string) => void;
  onNostrRelaysChange: (relays: string[]) => void;
  defaultSourcePubkeyDescription?: string;
  nostrRelaysDescription?: string;
}

export function SocialGraphSettings({
  defaultSourcePubkey,
  nostrRelays,
  onDefaultSourcePubkeyChange,
  onNostrRelaysChange,
  defaultSourcePubkeyDescription,
  nostrRelaysDescription,
}: SocialGraphSettingsProps) {
  const isValidPubkey = (value: string): boolean => {
    if (!value) return true; // Empty is valid (optional field)

    // Check if it's a hex pubkey (64 character hex string)
    if (/^[0-9a-f]{64}$/i.test(value)) {
      return true;
    }

    // Check if it's an npub (starts with npub1 and is bech32 encoded)
    if (value.startsWith("npub1")) {
      try {
        // Try to decode npub - we'll use a simple check for now
        // The actual decoding will happen server-side
        // Just validate it looks like a valid npub (bech32 format)
        return /^npub1[ac-hj-np-z02-9]{58}$/.test(value);
      } catch {
        return false;
      }
    }

    return false;
  };

  const pubkeyError =
    defaultSourcePubkey && !isValidPubkey(defaultSourcePubkey)
      ? "Must be a valid hex pubkey (64 chars) or npub format"
      : null;

  return (
    <section className="settings-section">
      <h2>Social Graph Settings</h2>
      <div className="settings-group">
        <div className="form-field">
          <label htmlFor="default-source-pubkey">
            <span className="label-text">DEFAULT_SOURCE_PUBKEY</span>
            {defaultSourcePubkeyDescription && (
              <span className="label-description">
                {defaultSourcePubkeyDescription}
              </span>
            )}
          </label>
          <input
            id="default-source-pubkey"
            type="text"
            value={defaultSourcePubkey}
            onChange={(e) => onDefaultSourcePubkeyChange(e.target.value)}
            placeholder="Enter default source pubkey (hex or npub format)"
            className={`text-input ${pubkeyError ? "error" : ""}`}
          />
          {pubkeyError && <span className="error-message">{pubkeyError}</span>}
        </div>

        <div className="form-field">
          <RelayListInput
            label="NOSTR_RELAYS"
            value={nostrRelays}
            onChange={onNostrRelaysChange}
            placeholder="wss://relay.example.com"
            description={nostrRelaysDescription}
          />
        </div>
      </div>
    </section>
  );
}
