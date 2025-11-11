import React, { useState, useEffect } from "react";
import { RelayListInput } from "./RelayListInput";
import { getPublicKey, generateSecretKey } from "nostr-tools";
import { hexToBytes, bytesToHex } from "nostr-tools/utils";

interface ServerSettingsProps {
  serverSecretKey: string;
  serverRelays: string[];
  onServerSecretKeyChange: (value: string) => void;
  onServerRelaysChange: (relays: string[]) => void;
  onServerSecretKeyReset?: () => void;
  isServerSecretKeyRequired?: boolean;
  serverSecretKeyDescription?: string;
  serverRelaysDescription?: string;
  hasExistingServerSecretKey?: boolean;
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
  onServerSecretKeyReset,
  isServerSecretKeyRequired = true,
  serverSecretKeyDescription,
  serverRelaysDescription,
  hasExistingServerSecretKey = false,
}: ServerSettingsProps) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [isDeriving, setIsDeriving] = useState(false);

  const handleGenerateNewKey = () => {
    const secretKeyBytes = generateSecretKey();
    const secretKeyHex = bytesToHex(secretKeyBytes);
    onServerSecretKeyChange(secretKeyHex);
  };

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

  const handleOpenWebApp = () => {
    if (pubkey) {
      const webAppUrl = `https://relatr.xyz/?s=${pubkey}`;
      window.open(webAppUrl, "_blank", "noopener,noreferrer");
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
          {hasExistingServerSecretKey && (
            <div className="alert alert-warning">
              <strong>⚠️ Warning:</strong> A SERVER_SECRET_KEY already exists in
              your environment. Setting a new value will override the existing
              one.
            </div>
          )}
          <div className="input-with-button">
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
            <button
              type="button"
              onClick={handleGenerateNewKey}
              className="generate-button"
              title="Generate new secret key"
            >
              Generate New
            </button>
            {hasExistingServerSecretKey && onServerSecretKeyReset && (
              <button
                type="button"
                onClick={onServerSecretKeyReset}
                className="reset-button"
                title="Reset to use existing SERVER_SECRET_KEY from environment"
              >
                Reset
              </button>
            )}
          </div>
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
              <div className="webapp-link-container">
                <button
                  type="button"
                  onClick={handleOpenWebApp}
                  className="webapp-button"
                  title="Open Relatr web app connected to your server"
                >
                  🚀 Open Relatr Web App
                </button>
                <span className="label-description">
                  Opens relatr.xyz with your server connected
                </span>
              </div>
            </div>
          )}
          {isDeriving &&
            serverSecretKey &&
            serverSecretKey.trim().length > 0 &&
            !pubkey && (
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
