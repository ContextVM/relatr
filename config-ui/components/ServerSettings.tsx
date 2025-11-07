import React, { useState, useEffect } from "react";
import { RelayListInput } from "./RelayListInput";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

interface ServerSettingsProps {
  serverSecretKey: string;
  serverRelays: string[];
  onServerSecretKeyChange: (value: string) => void;
  onServerRelaysChange: (relays: string[]) => void;
  isServerSecretKeyRequired?: boolean;
  serverSecretKeyDescription?: string;
  serverRelaysDescription?: string;
}

// Helper function to derive pubkey from secret key
async function derivePubkey(secretKey: string): Promise<string | null> {
  if (!secretKey || secretKey.trim().length === 0) {
    return null;
  }

  // Validate hex format (64 characters)
  const hexPattern = /^[0-9a-fA-F]{64}$/;
  if (!hexPattern.test(secretKey.trim())) {
    return null;
  }

  try {
    const secretKeyBytes = hexToBytes(secretKey.trim());
    return getPublicKey(secretKeyBytes);
  } catch (error) {
    // If derivation fails, try API endpoint as fallback
    try {
      const response = await fetch("/process-pastry/api/pubkey", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ secretKey: secretKey.trim() }),
      });
      if (response.ok) {
        const data = await response.json();
        return data.pubkey || null;
      }
    } catch (apiError) {
      // Silently fail
    }
    return null;
  }
}

export function ServerSettings({
  serverSecretKey,
  serverRelays,
  onServerSecretKeyChange,
  onServerRelaysChange,
  isServerSecretKeyRequired = true,
  serverSecretKeyDescription,
  serverRelaysDescription,
}: ServerSettingsProps) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [isDeriving, setIsDeriving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function updatePubkey() {
      if (!serverSecretKey || serverSecretKey.trim().length === 0) {
        setPubkey(null);
        return;
      }

      setIsDeriving(true);
      const derivedPubkey = await derivePubkey(serverSecretKey);
      if (!cancelled) {
        setPubkey(derivedPubkey);
        setIsDeriving(false);
      }
    }

    // Debounce the pubkey derivation
    const timeoutId = setTimeout(updatePubkey, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [serverSecretKey]);

  const handleCopyPubkey = () => {
    if (pubkey) {
      navigator.clipboard.writeText(pubkey);
    }
  };

  return (
    <section className="settings-section">
      <h2>Server Settings</h2>
      <div className="settings-group">
        <div className="form-field">
          <label htmlFor="server-secret-key">
            <span className="label-text">SERVER_SECRET_KEY</span>
            {serverSecretKeyDescription && (
              <span className="label-description">
                {serverSecretKeyDescription}
              </span>
            )}
            {isServerSecretKeyRequired && (
              <span className="required-badge">Required</span>
            )}
          </label>
          <input
            id="server-secret-key"
            type="password"
            value={serverSecretKey}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              onServerSecretKeyChange(e.target.value);
            }}
            placeholder="Enter server secret key (hex format)"
            className="text-input"
            required={isServerSecretKeyRequired}
          />
          {pubkey && (
            <div className="pubkey-display">
              <label className="pubkey-label">
                <span className="label-text">Server Pubkey</span>
                <span className="label-description">
                  Use this pubkey in other apps to connect to your server
                </span>
              </label>
              <div className="pubkey-value-container">
                <input
                  type="text"
                  readOnly
                  value={pubkey}
                  className="pubkey-input"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  type="button"
                  onClick={handleCopyPubkey}
                  className="copy-button"
                  title="Copy pubkey to clipboard"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
          {isDeriving && serverSecretKey && serverSecretKey.trim().length > 0 && !pubkey && (
            <div className="pubkey-deriving">
              <span className="label-description">Deriving pubkey...</span>
            </div>
          )}
        </div>

        <div className="form-field">
          <RelayListInput
            label="SERVER_RELAYS"
            value={serverRelays}
            onChange={onServerRelaysChange}
            placeholder="wss://relay.example.com"
            description={serverRelaysDescription}
          />
        </div>
      </div>
    </section>
  );
}
