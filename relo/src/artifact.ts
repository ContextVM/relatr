import { validateRelatrPluginProgram } from "./wrappers.js";

export const RELATR_PLUGIN_KIND = 765;

const MANIFEST_TAG_ORDER = [
  "n",
  "relatr-version",
  "title",
  "description",
  "weight",
] as const;

export type RelatrManifest = {
  name: string;
  relatrVersion: string;
  title?: string | null;
  description?: string | null;
  weight?: number | null;
};

export type RelatrPluginEvent = {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id?: string;
  sig?: string;
};

export type RelatrArtifactInput =
  | { kind: "source"; source: string }
  | { kind: "event"; event: RelatrPluginEvent };

export type RelatrArtifactValidationIssue = {
  path: string;
  message: string;
};

export type RelatrArtifactValidationResult = {
  ok: boolean;
  issues: RelatrArtifactValidationIssue[];
};

export type BuildRelatrArtifactOptions = {
  source?: string;
  event?: Partial<RelatrPluginEvent>;
  manifest?: Partial<RelatrManifest>;
  pubkey?: string;
  createdAt?: number;
  keepCreatedAt?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function compareManifestTags(left: string[], right: string[]): number {
  const leftIndex = MANIFEST_TAG_ORDER.indexOf(
    left[0] as (typeof MANIFEST_TAG_ORDER)[number],
  );
  const rightIndex = MANIFEST_TAG_ORDER.indexOf(
    right[0] as (typeof MANIFEST_TAG_ORDER)[number],
  );
  const normalizedLeftIndex =
    leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
  const normalizedRightIndex =
    rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

  if (normalizedLeftIndex !== normalizedRightIndex) {
    return normalizedLeftIndex - normalizedRightIndex;
  }

  return left[0].localeCompare(right[0]);
}

export function isRelatrPluginEvent(
  value: unknown,
): value is RelatrPluginEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.kind === "number" &&
    typeof value.pubkey === "string" &&
    typeof value.created_at === "number" &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((part) => typeof part === "string"),
    ) &&
    typeof value.content === "string"
  );
}

export function classifyRelatrArtifactInput(raw: string): RelatrArtifactInput {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRelatrPluginEvent(parsed)) {
      throw new Error(
        "Input looks like JSON, but it is not a valid Relatr plugin event object",
      );
    }

    return {
      kind: "event",
      event: parsed,
    };
  }

  return {
    kind: "source",
    source: raw,
  };
}

export function parseRelatrManifestTags(tags: string[][]): RelatrManifest {
  const manifest: RelatrManifest = {
    name: "",
    relatrVersion: "",
  };

  for (const tag of tags) {
    if (tag.length < 2) {
      continue;
    }

    const [key, value] = tag;

    switch (key) {
      case "n":
        manifest.name = value ?? "";
        break;
      case "relatr-version":
        manifest.relatrVersion = value ?? "";
        break;
      case "title":
        manifest.title = value ?? null;
        break;
      case "description":
        manifest.description = value ?? null;
        break;
      case "weight":
        manifest.weight =
          value !== undefined && value !== "" ? Number(value) : null;
        break;
    }
  }

  return manifest;
}

export function buildRelatrManifestTags(
  manifest: Partial<RelatrManifest>,
): string[][] {
  const tags: string[][] = [];

  if (manifest.name) {
    tags.push(["n", manifest.name]);
  }

  if (manifest.relatrVersion) {
    tags.push(["relatr-version", manifest.relatrVersion]);
  }

  if (manifest.title) {
    tags.push(["title", manifest.title]);
  }

  if (manifest.description) {
    tags.push(["description", manifest.description]);
  }

  if (manifest.weight !== undefined && manifest.weight !== null) {
    tags.push(["weight", String(manifest.weight)]);
  }

  return tags;
}

function isKnownManifestTag(tag: string[]): boolean {
  const [key] = tag;
  return (
    key === "n" ||
    key === "relatr-version" ||
    key === "title" ||
    key === "description" ||
    key === "weight"
  );
}

export function validateRelatrManifest(
  manifest: RelatrManifest,
): RelatrArtifactValidationResult {
  const issues: RelatrArtifactValidationIssue[] = [];

  if (!manifest.name.trim()) {
    issues.push({
      path: "tags.n",
      message: "Manifest must include an 'n' tag",
    });
  } else if (!/^[a-z0-9_-]+$/.test(manifest.name)) {
    issues.push({
      path: "tags.n",
      message:
        "Plugin name must be lowercase alphanumeric with hyphens or underscores only",
    });
  }

  if (!manifest.relatrVersion.trim()) {
    issues.push({
      path: "tags.relatr-version",
      message: "Manifest must include a 'relatr-version' tag",
    });
  } else if (!/^\^?\d+\.\d+\.\d+$/.test(manifest.relatrVersion.trim())) {
    issues.push({
      path: "tags.relatr-version",
      message: "relatr-version must be an exact semver or caret semver range",
    });
  }

  if (manifest.weight !== undefined && manifest.weight !== null) {
    if (!Number.isFinite(manifest.weight)) {
      issues.push({
        path: "tags.weight",
        message: "weight must be a finite number",
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function canonicalizeRelatrPluginEvent(
  event: RelatrPluginEvent,
): RelatrPluginEvent {
  const sortedTags = [...event.tags]
    .map((tag) => [...tag])
    .sort(compareManifestTags);

  const normalized: RelatrPluginEvent = {
    kind: event.kind,
    pubkey: event.pubkey,
    created_at: event.created_at,
    tags: sortedTags,
    content: normalizeContent(event.content),
  };

  if (event.id) {
    normalized.id = event.id;
  }

  if (event.sig) {
    normalized.sig = event.sig;
  }

  return normalized;
}

export function buildRelatrPluginEvent(
  options: BuildRelatrArtifactOptions = {},
): RelatrPluginEvent {
  const baseEvent = options.event;
  const source = normalizeContent(
    options.source ?? baseEvent?.content ?? scaffoldRelatrPluginSource(),
  );
  const currentManifest = parseRelatrManifestTags(baseEvent?.tags ?? []);
  const extraTags = (baseEvent?.tags ?? []).filter(
    (tag) => !isKnownManifestTag(tag),
  );
  const mergedManifest: Partial<RelatrManifest> = {
    ...currentManifest,
    ...options.manifest,
  };

  return canonicalizeRelatrPluginEvent({
    kind: RELATR_PLUGIN_KIND,
    pubkey: options.pubkey ?? baseEvent?.pubkey ?? ZERO_PUBKEY,
    created_at:
      options.createdAt ??
      (options.keepCreatedAt ? baseEvent?.created_at : undefined) ??
      Math.floor(Date.now() / 1000),
    tags: [
      ...buildRelatrManifestTags(mergedManifest),
      ...extraTags.map((tag) => [...tag]),
    ],
    content: source,
    id: baseEvent?.id,
    sig: baseEvent?.sig,
  });
}

export function validateRelatrPluginEvent(
  event: RelatrPluginEvent,
): RelatrArtifactValidationResult {
  const issues: RelatrArtifactValidationIssue[] = [];

  if (event.kind !== RELATR_PLUGIN_KIND) {
    issues.push({
      path: "kind",
      message: `Relatr plugin events must use kind ${RELATR_PLUGIN_KIND}`,
    });
  }

  if (!/^[a-f0-9]{64}$/i.test(event.pubkey)) {
    issues.push({
      path: "pubkey",
      message: "pubkey must be a 64-character hex string",
    });
  }

  if (!Number.isInteger(event.created_at) || event.created_at < 0) {
    issues.push({
      path: "created_at",
      message: "created_at must be a non-negative integer",
    });
  }

  const manifestValidation = validateRelatrManifest(
    parseRelatrManifestTags(event.tags),
  );
  issues.push(...manifestValidation.issues);

  const validation = validateRelatrPluginProgram(event.content);
  issues.push(
    ...validation.diagnostics.map((diagnostic, index) => ({
      path: `content[${index}]`,
      message: diagnostic.message,
    })),
  );

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function stringifyRelatrPluginEvent(event: RelatrPluginEvent): string {
  return `${JSON.stringify(canonicalizeRelatrPluginEvent(event), null, 2)}\n`;
}

export function scaffoldRelatrPluginSource(): string {
  return "plan\n  value = 0\nin\nvalue\n";
}

export const ZERO_PUBKEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
