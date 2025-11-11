import { useState, useEffect } from "react";
import { ServerSettings } from "./components/ServerSettings";
import { SocialGraphSettings } from "./components/SocialGraphSettings";
import { StatusIndicator } from "./components/StatusIndicator";
import {
  loadConfig,
  updateConfig,
  getStatus,
  loadExample,
  getExisting,
  deleteConfigVariable,
  type ConfigResponse,
  type StatusResponse,
  type ExampleResponse,
  stringToArray,
  arrayToString,
} from "./api";

function App() {
  const [config, setConfig] = useState<ConfigResponse>({});
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [example, setExample] = useState<ExampleResponse | null>(null);
  const [existingVars, setExistingVars] = useState<
    Record<string, string | undefined>
  >({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load initial data
  useEffect(() => {
    loadInitialData();
    // Poll status every 2 seconds
    const statusInterval = setInterval(() => {
      refreshStatus();
    }, 2000);
    return () => clearInterval(statusInterval);
  }, []);

  async function loadInitialData() {
    try {
      setLoading(true);
      setError(null);
      const [configData, statusData, exampleData, existingData] =
        await Promise.all([
          loadConfig(),
          getStatus(),
          loadExample(),
          getExisting(),
        ]);
      setConfig(configData);
      setStatus(statusData);
      setExample(exampleData);
      setExistingVars(existingData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  async function refreshStatus() {
    try {
      const statusData = await getStatus();
      setStatus(statusData);
    } catch (err) {
      // Silently fail status updates
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);

      // Prepare config object with proper formatting
      const updates: ConfigResponse = {};

      // Get current values from state
      const serverSecretKey = config.SERVER_SECRET_KEY || "";
      const serverRelays = stringToArray(config.SERVER_RELAYS);
      const defaultSourcePubkey = config.DEFAULT_SOURCE_PUBKEY || "";
      const nostrRelays = stringToArray(config.NOSTR_RELAYS);

      // Validate required field only if it doesn't exist in process environment (with a non-empty value)
      if (!hasNonEmptyExistingServerSecretKey && !serverSecretKey.trim()) {
        throw new Error("SERVER_SECRET_KEY is required");
      }

      // Build updates object
      // Only include SERVER_SECRET_KEY if it has a value
      // (If it exists in process env and is empty, we don't update it)
      if (serverSecretKey.trim()) {
        updates.SERVER_SECRET_KEY = serverSecretKey;
      }
      if (serverRelays.length > 0) {
        updates.SERVER_RELAYS = arrayToString(serverRelays);
      }
      if (defaultSourcePubkey.trim()) {
        updates.DEFAULT_SOURCE_PUBKEY = defaultSourcePubkey;
      }
      if (nostrRelays.length > 0) {
        updates.NOSTR_RELAYS = arrayToString(nostrRelays);
      }

      const result = await updateConfig(updates, true);

      if (result.success) {
        // Refresh config and status after a short delay
        setTimeout(() => {
          loadInitialData();
        }, 1000);
      } else {
        throw new Error(result.error || "Failed to save configuration");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save configuration",
      );
    } finally {
      setSaving(false);
    }
  }

  function handleServerSecretKeyChange(value: string) {
    setConfig({ ...config, SERVER_SECRET_KEY: value });
  }

  function handleServerRelaysChange(relays: string[]) {
    setConfig({ ...config, SERVER_RELAYS: arrayToString(relays) });
  }

  function handleDefaultSourcePubkeyChange(value: string) {
    setConfig({ ...config, DEFAULT_SOURCE_PUBKEY: value });
  }

  function handleNostrRelaysChange(relays: string[]) {
    setConfig({ ...config, NOSTR_RELAYS: arrayToString(relays) });
  }

  async function handleServerSecretKeyReset() {
    try {
      setSaving(true);
      setError(null);

      // Delete the SERVER_SECRET_KEY from the .env file
      const result = await deleteConfigVariable("SERVER_SECRET_KEY", true);

      if (result.success) {
        // Refresh config and status after a short delay
        setTimeout(() => {
          loadInitialData();
        }, 1000);
      } else {
        throw new Error(result.error || "Failed to reset SERVER_SECRET_KEY");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to reset SERVER_SECRET_KEY",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="loading-state">Loading configuration...</div>
        </div>
      </div>
    );
  }

  // Use the value from config if set, otherwise use the existing value from process.env
  const serverSecretKey = config.SERVER_SECRET_KEY || existingVars.SERVER_SECRET_KEY || "";
  const serverRelays = stringToArray(config.SERVER_RELAYS);
  const defaultSourcePubkey = config.DEFAULT_SOURCE_PUBKEY || "";
  const nostrRelays = stringToArray(config.NOSTR_RELAYS);

  // Check if the value is actually set in the config file (not just from env)
  // Empty strings should be ignored
  const hasServerSecretKeyInConfig = !!config.SERVER_SECRET_KEY && config.SERVER_SECRET_KEY.trim().length > 0;

  // Check if there's a non-empty existing value in the environment
  const hasNonEmptyExistingServerSecretKey =
    "SERVER_SECRET_KEY" in existingVars &&
    !!existingVars.SERVER_SECRET_KEY &&
    existingVars.SERVER_SECRET_KEY.trim().length > 0;

  return (
    <div className="app">
      <div className="container">
        <header className="app-header">
          <h1>Relatr Configuration</h1>
          <StatusIndicator status={status} loading={loading} />
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="config-form"
        >
          <ServerSettings
            serverSecretKey={serverSecretKey}
            serverRelays={serverRelays}
            onServerSecretKeyChange={handleServerSecretKeyChange}
            onServerRelaysChange={handleServerRelaysChange}
            onServerSecretKeyReset={handleServerSecretKeyReset}
            isServerSecretKeyRequired={
              !hasNonEmptyExistingServerSecretKey && !serverSecretKey.trim()
            }
            serverSecretKeyDescription={
              example?.SERVER_SECRET_KEY?.description ||
              "Server's Nostr private key (hex format)"
            }
            serverRelaysDescription={
              example?.SERVER_RELAYS?.description ||
              "Comma-separated relay URLs for server operations"
            }
            hasExistingServerSecretKey={
              hasNonEmptyExistingServerSecretKey &&
              hasServerSecretKeyInConfig
            }
          />

          <SocialGraphSettings
            defaultSourcePubkey={defaultSourcePubkey}
            nostrRelays={nostrRelays}
            onDefaultSourcePubkeyChange={handleDefaultSourcePubkeyChange}
            onNostrRelaysChange={handleNostrRelaysChange}
            defaultSourcePubkeyDescription={
              example?.DEFAULT_SOURCE_PUBKEY?.description ||
              "Default perspective pubkey for trust calculations (hex or npub format)"
            }
            nostrRelaysDescription={
              example?.NOSTR_RELAYS?.description ||
              "Comma-separated relay URLs for social graph data"
            }
          />

          <div className="form-actions">
            <button
              type="submit"
              className="save-button"
              disabled={
                saving ||
                (!hasNonEmptyExistingServerSecretKey &&
                  !serverSecretKey.trim())
              }
            >
              {saving ? "Saving..." : "Save & Restart"}
            </button>
          </div>
        </form>

        {(error || status?.lastError) && (
          <div className="error-console">
            <pre>{error || status?.lastError}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
