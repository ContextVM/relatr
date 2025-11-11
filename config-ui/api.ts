/**
 * API client for process-pastry endpoints
 */

const API_BASE = "/process-pastry/api";

export interface ConfigResponse {
  [key: string]: string;
}

export interface StatusResponse {
  running: boolean;
  lastError: string | null;
  pid: number | null;
}

export interface ExampleResponse {
  [key: string]: {
    description?: string;
    defaultValue?: string;
    commented?: boolean;
  };
}

export interface SaveResponse {
  success: boolean;
  error: string | null;
  restarted: boolean;
  updated?: string[];
}

export interface ExistingResponse {
  variables: string[];
}

/**
 * Load current configuration
 */
export async function loadConfig(): Promise<ConfigResponse> {
  const response = await fetch(`${API_BASE}/config`);
  if (!response.ok) {
    throw new Error(`Failed to load config: ${response.statusText}`);
  }
  return await response.json();
}

/**
 * Update configuration (partial update)
 */
export async function updateConfig(
  config: Partial<ConfigResponse>,
  restart: boolean = true,
): Promise<SaveResponse> {
  const response = await fetch(`${API_BASE}/config`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Restart-Process": restart ? "true" : "false",
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update config: ${error}`);
  }

  return await response.json();
}

/**
 * Get process status
 */
export async function getStatus(): Promise<StatusResponse> {
  const response = await fetch(`${API_BASE}/status`);
  if (!response.ok) {
    throw new Error(`Failed to get status: ${response.statusText}`);
  }
  return await response.json();
}

/**
 * Load schema/example configuration (optional)
 */
export async function loadExample(): Promise<ExampleResponse | null> {
  try {
    const response = await fetch(`${API_BASE}/example`);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Get existing environment variables
 */
export async function getExisting(): Promise<ExistingResponse> {
  try {
    const response = await fetch(`${API_BASE}/existing`);
    if (!response.ok) {
      return { variables: [] };
    }
    return await response.json();
  } catch {
    return { variables: [] };
  }
}

/**
 * Convert comma-separated string to array
 */
export function stringToArray(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Convert array to comma-separated string
 */
export function arrayToString(arr: string[]): string {
  return arr.join(", ");
}

/**
 * Delete a configuration variable by loading config, removing the key, and saving
 */
export async function deleteConfigVariable(
  key: string,
  restart: boolean = true,
): Promise<SaveResponse> {
  // Load current config
  const currentConfig = await loadConfig();

  // Remove the specified key
  delete currentConfig[key];

  // Save the updated config using POST (which replaces the entire config)
  const response = await fetch(`${API_BASE}/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Restart-Process": restart ? "true" : "false",
    },
    body: JSON.stringify(currentConfig),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete config variable: ${error}`);
  }

  return await response.json();
}
