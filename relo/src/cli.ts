import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  SimplePool,
  verifyEvent,
  type EventTemplate,
} from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";

import {
  buildRelatrPluginEvent,
  classifyRelatrArtifactInput,
  isRelatrPluginEvent,
  stringifyRelatrPluginEvent,
  type RelatrManifest,
  type RelatrPluginEvent,
  validateRelatrPluginEvent,
} from "./artifact";

type CommandName = "build" | "check" | "publish";

type ParsedArgs = {
  command: CommandName | null;
  positionals: string[];
  flags: Map<string, string[]>;
};

type JsonReport = {
  ok: boolean;
  command: CommandName;
  message?: string;
  inputKind?: "source" | "event";
  errors?: string[];
  event?: RelatrPluginEvent;
  publish?: {
    relays: string[];
    eventId?: string;
    dryRun: boolean;
  };
};

type CommandHelp = {
  summary: string;
  usage: string;
  examples: string[];
  flags: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const [commandCandidate, ...rest] = argv;
  const command =
    commandCandidate === "build" ||
    commandCandidate === "check" ||
    commandCandidate === "publish"
      ? commandCandidate
      : null;
  const tokens = command ? rest : argv;
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    const name = rawName.trim();
    const existing = flags.get(name) ?? [];

    if (inlineValue !== undefined) {
      existing.push(inlineValue);
      flags.set(name, existing);
      continue;
    }

    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      existing.push(next);
      flags.set(name, existing);
      index += 1;
      continue;
    }

    existing.push("true");
    flags.set(name, existing);
  }

  return {
    command,
    positionals,
    flags,
  };
}

function getLastFlagValue(args: ParsedArgs, name: string): string | undefined {
  const values = args.flags.get(name);
  return values ? values[values.length - 1] : undefined;
}

function getAllFlagValues(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function resolveInputText(args: ParsedArgs): Promise<string> {
  const stdin = await readStdin();
  if (stdin.trim().length > 0) {
    return stdin;
  }

  const [inputPath] = args.positionals;
  if (!inputPath) {
    return "";
  }

  return readFile(inputPath, "utf8");
}

function toEventTemplate(event: RelatrPluginEvent): EventTemplate {
  return {
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags,
    content: event.content,
  };
}

function isSignedRelatrPluginEvent(
  event: RelatrPluginEvent,
): event is RelatrPluginEvent & {
  id: string;
  sig: string;
} {
  return typeof event.id === "string" && typeof event.sig === "string";
}

function normalizeSecretKey(secret: string): Uint8Array {
  const trimmed = secret.trim();

  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("Expected an nsec secret when using an nsec-encoded key");
    }

    return decoded.data;
  }

  if (!/^[a-f0-9]{64}$/i.test(trimmed)) {
    throw new Error(
      "Secret key must be a 64-character hex string or an nsec value",
    );
  }

  return Uint8Array.from(Buffer.from(trimmed, "hex"));
}

function signRelatrPluginEvent(
  event: RelatrPluginEvent,
  secret: string,
): RelatrPluginEvent {
  const secretKey = normalizeSecretKey(secret);
  const signed = finalizeEvent(toEventTemplate(event), secretKey);

  return buildRelatrPluginEvent({
    event: {
      ...event,
      pubkey: getPublicKey(secretKey),
      id: signed.id,
      sig: signed.sig,
    },
  });
}

async function signRelatrPluginEventRemotely(
  event: RelatrPluginEvent,
  bunkerInput: string,
): Promise<RelatrPluginEvent> {
  const clientSecretKey = generateSecretKey();
  const trimmed = bunkerInput.trim();

  if (!trimmed) {
    throw new Error("Bunker connection string must not be empty");
  }

  const signer = trimmed.startsWith("nostrconnect://")
    ? await BunkerSigner.fromURI(clientSecretKey, trimmed)
    : await (async () => {
        const bunkerPointer = await parseBunkerInput(trimmed);
        if (!bunkerPointer) {
          throw new Error(
            "Bunker input must be a nostrconnect:// URI, bunker:// URI, or NIP-05 identifier",
          );
        }

        const bunkerSigner = BunkerSigner.fromBunker(
          clientSecretKey,
          bunkerPointer,
        );
        await bunkerSigner.connect();
        return bunkerSigner;
      })();

  try {
    const signed = await signer.signEvent(toEventTemplate(event));
    const pubkey = await signer.getPublicKey();

    return buildRelatrPluginEvent({
      event: {
        ...event,
        pubkey,
        id: signed.id,
        sig: signed.sig,
      },
    });
  } finally {
    await signer.close();
  }
}

async function signRelatrPluginEventWithArgs(
  event: RelatrPluginEvent,
  args: ParsedArgs,
  command: Extract<CommandName, "build" | "publish">,
  json: boolean,
): Promise<RelatrPluginEvent> {
  const secret = getLastFlagValue(args, "sec");
  const bunker =
    getLastFlagValue(args, "bunker") ?? getLastFlagValue(args, "remote");

  if (secret && bunker) {
    failWithUsage(
      command,
      "Choose only one signing method: --sec or --bunker/--remote",
      json,
      [
        "Use --sec <hex|nsec> for local signing, or --bunker <nostrconnect://...|bunker://...|name@domain> for NIP-46 signing.",
      ],
    );
  }

  if (secret) {
    return signRelatrPluginEvent(event, secret);
  }

  if (bunker) {
    try {
      return await signRelatrPluginEventRemotely(event, bunker);
    } catch (error) {
      failWithUsage(command, "Remote signing failed", json, [
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }

  return event;
}

function formatErrors(errors: string[]): string {
  return errors.map((error) => `- ${error}`).join("\n");
}

function commandHelp(command: CommandName): CommandHelp {
  switch (command) {
    case "build":
      return {
        summary:
          "Build a canonical Relatr plugin event from source or existing event JSON.",
        usage:
          "relo build [input] --name <plugin-name> --relatr-version <range> [flags]",
        flags: [
          "--name <plugin-name>       Required when building from raw source input",
          "--relatr-version <range>   Required when building from raw source input",
          "--title <text>             Optional manifest title",
          "--description <text>       Optional manifest description",
          "--weight <number>          Optional manifest weight",
          "--sec <hex|nsec>           Sign the built event",
          "--bunker <connection>      Sign the built event via NIP-46 remote signer",
          "--remote <connection>      Alias for --bunker",
          "--out <path>               Write JSON output to a file",
          "--json                     Emit a JSON success/failure report",
        ],
        examples: [
          "relo build plugin.elo --name activity_notes --relatr-version ^0.1.16",
          "relo build plugin.elo --name activity_notes --relatr-version ^0.1.16 --bunker bunker://<pubkey>?relay=wss://relay.example",
          "cat plugin.elo | relo build --name activity_notes --relatr-version ^0.1.16 --out plugin.json",
        ],
      };
    case "check":
      return {
        summary:
          "Validate raw source or an existing Relatr plugin event JSON artifact.",
        usage: "relo check [input] [--json]",
        flags: ["--json                     Emit a JSON validation report"],
        examples: [
          "relo check plugin.json",
          "cat plugin.json | relo check --json",
        ],
      };
    case "publish":
      return {
        summary:
          "Publish a signed Relatr plugin event to one or more Nostr relays.",
        usage: "relo publish [input] --relay <url> [--relay <url> ...] [flags]",
        flags: [
          "--relay <url>              Required; may be repeated",
          "--sec <hex|nsec>           Required for unsigned input unless --bunker is used",
          "--bunker <connection>      Required for unsigned input unless --sec is used",
          "--remote <connection>      Alias for --bunker",
          "--name <plugin-name>       Required for raw source input",
          "--relatr-version <range>   Required for raw source input",
          "--title <text>             Optional manifest title",
          "--description <text>       Optional manifest description",
          "--weight <number>          Optional manifest weight",
          "--dry-run                  Validate and sign without publishing",
          "--json                     Emit a JSON success/failure report",
        ],
        examples: [
          "relo publish plugin.json --relay ws://localhost:10547",
          "relo publish plugin.json --relay ws://localhost:10547 --bunker bunker://<pubkey>?relay=wss://relay.example",
          "cat plugin.elo | relo publish --relay ws://localhost:10547 --name activity_notes --relatr-version ^0.1.16 --sec <hex>",
        ],
      };
  }
}

function formatCommandHelp(command: CommandName): string {
  const help = commandHelp(command);
  return [
    `${command}: ${help.summary}`,
    "",
    `Usage: ${help.usage}`,
    "",
    "Flags:",
    ...help.flags.map((flag) => `  ${flag}`),
    "",
    "Examples:",
    ...help.examples.map((example) => `  ${example}`),
  ].join("\n");
}

function failWithUsage(
  command: CommandName,
  message: string,
  json: boolean,
  errors?: string[],
): never {
  if (json) {
    reportJson({
      ok: false,
      command,
      message,
      errors,
    });
  }

  process.stderr.write(`${message}\n\n${formatCommandHelp(command)}\n`);
  if (errors && errors.length > 0) {
    process.stderr.write(`\n${formatErrors(errors)}\n`);
  }
  process.exit(1);
}

function isSuccessfulPublishResult(
  result: PromiseSettledResult<string>,
): boolean {
  if (result.status !== "fulfilled") {
    return false;
  }

  return !(
    result.value === "duplicate url" ||
    result.value === "connection skipped by allowConnectingToRelay" ||
    result.value.startsWith("connection failure:")
  );
}

function manifestFromArgs(args: ParsedArgs): Partial<RelatrManifest> {
  const weightValue = getLastFlagValue(args, "weight");
  const manifest: Partial<RelatrManifest> = {};
  const name = getLastFlagValue(args, "name");
  const title = getLastFlagValue(args, "title");
  const description = getLastFlagValue(args, "description");
  const relatrVersion = getLastFlagValue(args, "relatr-version");

  if (name !== undefined) {
    manifest.name = name;
  }

  if (title !== undefined) {
    manifest.title = title;
  }

  if (description !== undefined) {
    manifest.description = description;
  }

  if (relatrVersion !== undefined) {
    manifest.relatrVersion = relatrVersion;
  }

  if (weightValue !== undefined) {
    manifest.weight = Number(weightValue);
  }

  return manifest;
}

function reportJson(report: JsonReport): never {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

function fail(
  command: CommandName,
  message: string,
  json: boolean,
  errors?: string[],
): never {
  if (json) {
    reportJson({
      ok: false,
      command,
      message,
      errors,
    });
  }

  process.stderr.write(`${message}\n`);
  if (errors && errors.length > 0) {
    process.stderr.write(`${formatErrors(errors)}\n`);
  }
  process.exit(1);
}

async function writeMaybeToFile(
  args: ParsedArgs,
  content: string,
): Promise<void> {
  const outPath = getLastFlagValue(args, "out");
  if (!outPath) {
    process.stdout.write(content);
    return;
  }

  await writeFile(outPath, content, "utf8");
}

async function buildCommand(args: ParsedArgs): Promise<void> {
  const rawInput = await resolveInputText(args);
  const json = hasFlag(args, "json");
  const manifest = manifestFromArgs(args);
  const input = rawInput.trim() ? classifyRelatrArtifactInput(rawInput) : null;
  const event =
    input?.kind === "event"
      ? buildRelatrPluginEvent({ event: input.event, manifest })
      : buildRelatrPluginEvent({
          source: input?.kind === "source" ? input.source : undefined,
          manifest,
        });
  const finalEvent = await signRelatrPluginEventWithArgs(
    event,
    args,
    "build",
    json,
  );
  const validation = validateRelatrPluginEvent(finalEvent);

  if (!validation.ok) {
    fail(
      "build",
      "Build failed validation",
      json,
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
    );
  }

  const output = stringifyRelatrPluginEvent(finalEvent);
  await writeMaybeToFile(args, output);

  if (json) {
    reportJson({ ok: true, command: "build", event: finalEvent });
  }
}

async function checkCommand(args: ParsedArgs): Promise<void> {
  const rawInput = await resolveInputText(args);
  const json = hasFlag(args, "json");

  if (!rawInput.trim()) {
    failWithUsage("check", "No input provided", json, [
      "Pass a file path as the positional input or pipe content on stdin.",
    ]);
  }

  const input = classifyRelatrArtifactInput(rawInput);
  const event =
    input.kind === "event"
      ? input.event
      : buildRelatrPluginEvent({ source: input.source });
  const validation = validateRelatrPluginEvent(event);

  if (json) {
    reportJson({
      ok: validation.ok,
      command: "check",
      inputKind: input.kind,
      event,
      errors: validation.issues.map(
        (issue) => `${issue.path}: ${issue.message}`,
      ),
    });
  }

  if (!validation.ok) {
    fail(
      "check",
      "Validation failed",
      false,
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
    );
  }

  process.stdout.write(`valid ${input.kind}\n`);
}

async function publishCommand(args: ParsedArgs): Promise<void> {
  const rawInput = await resolveInputText(args);
  const json = hasFlag(args, "json");
  const relays = getAllFlagValues(args, "relay");
  const manifest = manifestFromArgs(args);

  if (relays.length === 0) {
    failWithUsage("publish", "At least one --relay value is required", json, [
      "Repeat --relay for each target relay, for example: --relay ws://localhost:10547",
    ]);
  }

  if (!rawInput.trim()) {
    failWithUsage("publish", "No input provided", json, [
      "Pass a file path as the positional input or pipe content on stdin.",
    ]);
  }

  const input = classifyRelatrArtifactInput(rawInput);
  let event =
    input.kind === "event"
      ? buildRelatrPluginEvent({ event: input.event, manifest })
      : buildRelatrPluginEvent({ source: input.source, manifest });

  if (!event.id || !event.sig) {
    const secret = getLastFlagValue(args, "sec");
    const bunker =
      getLastFlagValue(args, "bunker") ?? getLastFlagValue(args, "remote");

    if (!secret && !bunker) {
      failWithUsage(
        "publish",
        "Unsigned events require --sec or --bunker for publishing",
        json,
        [
          "Provide --sec <hex|nsec> for local signing, or --bunker <nostrconnect://...|bunker://...|name@domain> for remote signing.",
        ],
      );
    }

    event = await signRelatrPluginEventWithArgs(event, args, "publish", json);
  }

  if (!isRelatrPluginEvent(event) || !isSignedRelatrPluginEvent(event)) {
    fail("publish", "Signed event verification failed", json);
  }

  if (!verifyEvent(event)) {
    fail("publish", "Signed event verification failed", json);
  }

  const validation = validateRelatrPluginEvent(event);
  if (!validation.ok) {
    fail(
      "publish",
      "Publish input failed validation",
      json,
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
    );
  }

  const dryRun = hasFlag(args, "dry-run");
  if (dryRun) {
    if (json) {
      reportJson({
        ok: true,
        command: "publish",
        event,
        publish: { relays, eventId: event.id, dryRun: true },
      });
    }

    process.stdout.write(`dry-run ${event.id}\n`);
    return;
  }

  const pool = new SimplePool();
  try {
    const relayPublishes = pool.publish(relays, event);
    const relayResults = await Promise.allSettled(relayPublishes);
    const atLeastOneSuccess = relayResults.some(isSuccessfulPublishResult);

    if (!atLeastOneSuccess) {
      fail(
        "publish",
        "Failed to publish event to any relay",
        json,
        relayResults.map((result, index) => {
          const relay = relays[index] ?? "unknown-relay";
          if (result.status === "rejected") {
            return `${relay}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
          }

          return `${relay}: ${result.value}`;
        }),
      );
    }
  } finally {
    pool.close(relays);
  }

  if (json) {
    reportJson({
      ok: true,
      command: "publish",
      event,
      publish: { relays, eventId: event.id, dryRun: false },
    });
  }

  process.stdout.write(`published ${event.id}\n`);
}

function usage(): string {
  return [
    "Usage: relo <command> [input] [flags]",
    "",
    "Commands:",
    "  build    Build a canonical plugin artifact",
    "  check    Validate source or plugin event JSON",
    "  publish  Publish a signed plugin event to relays",
    "",
    "Examples:",
    "  relo build plugin.elo --name activity_notes --relatr-version ^0.1.16",
    "  relo check plugin.json",
    "  relo publish plugin.json --relay ws://localhost:10547",
    "  relo publish plugin.json --relay ws://localhost:10547 --bunker bunker://<pubkey>?relay=wss://relay.example",
    "",
    "Use `relo <command> --help` for command-specific flags and examples.",
  ].join("\n");
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);

  if (!args.command && (argv.includes("--help") || argv.includes("-h"))) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  if (!args.command) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  if (hasFlag(args, "help") || hasFlag(args, "h")) {
    process.stdout.write(`${formatCommandHelp(args.command)}\n`);
    process.exit(0);
  }

  switch (args.command) {
    case "build":
      await buildCommand(args);
      return;
    case "check":
      await checkCommand(args);
      return;
    case "publish":
      await publishCommand(args);
      return;
  }
}

export async function runCliFromProcess(): Promise<void> {
  await runCli(process.argv.slice(2));
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runCliFromProcess().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
