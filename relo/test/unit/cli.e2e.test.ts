import { afterEach, describe, expect, it } from "bun:test";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nip19 } from "nostr-tools";

const tmpPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relo-cli-test-"));
  tmpPaths.push(dir);
  return dir;
}

async function runCli(
  args: string[],
  options: { stdin?: string; cwd?: string } = {},
) {
  const proc = Bun.spawn(
    ["/usr/bin/env", "bun", "run", "src/bin.ts", ...args],
    {
      cwd: options.cwd ?? join(process.cwd(), "relo"),
      stdin: options.stdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (options.stdin) {
    if (!proc.stdin) {
      throw new Error("Expected stdin pipe to be available");
    }

    await proc.stdin.write(new TextEncoder().encode(options.stdin));
    await proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(
    tmpPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("relo cli end-to-end", () => {
  it("prints top-level help with examples", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: relo <command> [input] [flags]");
    expect(result.stdout).toContain(
      "Use `relo <command> --help` for command-specific flags and examples.",
    );
  });

  it("prints command-specific help for publish", async () => {
    const result = await runCli(["publish", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "publish: Publish a signed Relatr plugin event to one or more Nostr relays.",
    );
    expect(result.stdout).toContain(
      "Usage: relo publish [input] --relay <url> [--relay <url> ...] [flags]",
    );
    expect(result.stdout).toContain(
      "--sec <hex|nsec>           Required for unsigned input unless --bunker is used",
    );
    expect(result.stdout).toContain(
      "--bunker <connection>      Required for unsigned input unless --sec is used",
    );
  });

  it("builds from stdin and writes canonical json to stdout", async () => {
    const result = await runCli(
      ["build", "--name", "activity_notes", "--relatr-version", "^0.1.16"],
      {
        stdin: "plan\n  value = 0\nin\nvalue\n",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as {
      kind: number;
      tags: string[][];
      content: string;
    };

    expect(parsed.kind).toBe(765);
    expect(parsed.tags).toEqual([
      ["n", "activity_notes"],
      ["relatr-version", "^0.1.16"],
    ]);
    expect(parsed.content).toBe("plan\n  value = 0\nin\nvalue\n");
  });

  it("builds to an output file when using --out", async () => {
    const dir = await makeTempDir();
    const sourcePath = join(dir, "plugin.elo");
    const outPath = join(dir, "plugin.json");
    await writeFile(sourcePath, "plan\n  value = 0\nin\nvalue\n", "utf8");

    const result = await runCli(
      [
        "build",
        sourcePath,
        "--name",
        "activity_notes",
        "--relatr-version",
        "^0.1.16",
        "--out",
        outPath,
      ],
      { cwd: join(process.cwd(), "relo") },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    const written = JSON.parse(await readFile(outPath, "utf8")) as {
      tags: string[][];
    };
    expect(written.tags).toEqual([
      ["n", "activity_notes"],
      ["relatr-version", "^0.1.16"],
    ]);
  });

  it("preserves manifest metadata from existing event json during build", async () => {
    const result = await runCli([
      "build",
      "../test-plugins/activity_notes.json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as {
      tags: string[][];
    };

    expect(parsed.tags).toEqual([
      ["n", "activity_notes"],
      ["relatr-version", "^0.2.0"],
      ["title", "Activity score (notes)"],
      [
        "description",
        "Scores higher for more recent notes by targetPubkey.",
      ],
    ]);
  });

  it("signs built events with a hex secret key", async () => {
    const secretHex =
      "1111111111111111111111111111111111111111111111111111111111111111";
    const result = await runCli(
      [
        "build",
        "--name",
        "activity_notes",
        "--relatr-version",
        "^0.1.16",
        "--sec",
        secretHex,
      ],
      {
        stdin: "plan\n  value = 0\nin\nvalue\n",
      },
    );

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      id?: string;
      sig?: string;
      pubkey: string;
    };

    expect(typeof parsed.id).toBe("string");
    expect(typeof parsed.sig).toBe("string");
    expect(parsed.pubkey).toHaveLength(64);
  });

  it("accepts nsec signing input and supports dry-run publish", async () => {
    const secretHex =
      "6ea5d90dbc699920dc587424f3403acfb239f35e63efd67eee62ac56caf784bd";
    const nsec = nip19.nsecEncode(
      Uint8Array.from(Buffer.from(secretHex, "hex")),
    );
    const result = await runCli(
      [
        "publish",
        "--relay",
        "wss://relay.example",
        "--name",
        "activity_notes",
        "--relatr-version",
        "^0.1.16",
        "--sec",
        nsec,
        "--dry-run",
        "--json",
      ],
      {
        stdin: "plan\n  value = 0\nin\nvalue\n",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      event?: { id?: string; sig?: string };
      publish?: { dryRun: boolean; relays: string[]; eventId?: string };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.publish).toEqual({
      dryRun: true,
      relays: ["wss://relay.example"],
      eventId: parsed.event?.id,
    });
    expect(typeof parsed.event?.sig).toBe("string");
  });

  it("fails publish when every relay rejects the event", async () => {
    const result = await runCli(
      [
        "publish",
        "--relay",
        "ws://127.0.0.1:1",
        "--name",
        "activity_notes",
        "--relatr-version",
        "^0.1.16",
        "--sec",
        "1111111111111111111111111111111111111111111111111111111111111111",
        "--json",
      ],
      {
        stdin: "plan\n  value = 0\nin\nvalue\n",
      },
    );

    expect(result.exitCode).toBe(1);

    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      message: string;
      errors: string[];
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("publish");
    expect(parsed.message).toBe("Failed to publish event to any relay");
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("shows actionable usage when publish is missing relay arguments", async () => {
    const result = await runCli([
      "publish",
      "../test-plugins/activity_notes.json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("At least one --relay value is required");
    expect(result.stderr).toContain(
      "Usage: relo publish [input] --relay <url> [--relay <url> ...] [flags]",
    );
    expect(result.stderr).toContain(
      "Repeat --relay for each target relay, for example: --relay ws://localhost:10547",
    );
  });

  it("shows actionable usage when publish is missing every signing method for unsigned input", async () => {
    const result = await runCli(
      [
        "publish",
        "--relay",
        "ws://localhost:10547",
        "--name",
        "activity_notes",
        "--relatr-version",
        "^0.1.16",
        "--dry-run",
      ],
      {
        stdin: "plan\n  value = 0\nin\nvalue\n",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Unsigned events require --sec or --bunker for publishing",
    );
    expect(result.stderr).toContain(
      "--bunker <nostrconnect://...|bunker://...|name@domain>",
    );
  });

  it("rejects invalid bunker input with actionable remote-signing guidance", async () => {
    const result = await runCli(
      [
        "build",
        "--name",
        "activity_notes",
        "--relatr-version",
        "^0.1.16",
        "--bunker",
        "not-a-bunker",
      ],
      {
        stdin: "plan\n  value = 0\nin\nvalue\n",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Remote signing failed");
    expect(result.stderr).toContain(
      "Bunker input must be a nostrconnect:// URI, bunker:// URI, or NIP-05 identifier",
    );
  });
});
