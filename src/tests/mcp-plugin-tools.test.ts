import { describe, test, expect } from "bun:test";
import { isAdminPubkey } from "@/mcp/server";

describe("MCP plugin tools auth", () => {
  test("admin allowlist check", () => {
    expect(isAdminPubkey("abc", ["abc", "def"])).toBe(true);
    expect(isAdminPubkey("zzz", ["abc", "def"])).toBe(false);
    expect(isAdminPubkey(undefined, ["abc"])).toBe(false);
  });
});
