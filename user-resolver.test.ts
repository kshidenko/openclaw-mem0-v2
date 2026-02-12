import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  resolveUserId,
  isGroupChat,
  loadIdentityMap,
  saveIdentityMap,
  buildAliasLookup,
  resolveCanonicalUserId,
  addAliasToIdentityMap,
} from "./user-resolver.js";
import type { IdentityMap } from "./types.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// resolveUserId
// ============================================================================

describe("resolveUserId", () => {
  it("parses agent:id:provider:peer format", () => {
    const ctx = { sessionKey: "agent:main:telegram:12345" };
    expect(resolveUserId(ctx)).toBe("telegram:12345");
  });

  it("handles multi-colon peer IDs (e.g. discord:guild:user)", () => {
    const ctx = { sessionKey: "agent:main:discord:guild:user_789" };
    expect(resolveUserId(ctx)).toBe("discord:guild:user_789");
  });

  it("falls back to provider + hash when sessionKey has fewer than 4 parts", () => {
    const ctx = { sessionKey: "short:key", messageProvider: "telegram" };
    const result = resolveUserId(ctx);
    expect(result).toMatch(/^telegram:[0-9a-f]{8}$/);
  });

  it("falls back to session:hash when only sessionKey is available", () => {
    const ctx = { sessionKey: "some-session" };
    const result = resolveUserId(ctx);
    expect(result).toMatch(/^session:[0-9a-f]{8}$/);
  });

  it("returns 'default' when no context is available", () => {
    expect(resolveUserId({})).toBe("default");
  });

  it("uses messageChannel from ToolContext", () => {
    const ctx = { sessionKey: "short:key", messageChannel: "discord" };
    const result = resolveUserId(ctx);
    expect(result).toMatch(/^discord:[0-9a-f]{8}$/);
  });

  it("prefers messageProvider over messageChannel", () => {
    const ctx = {
      sessionKey: "short:key",
      messageProvider: "telegram",
      messageChannel: "discord",
    } as any;
    const result = resolveUserId(ctx);
    expect(result).toMatch(/^telegram:[0-9a-f]{8}$/);
  });

  it("produces deterministic hashes for same input", () => {
    const ctx = { sessionKey: "some-session" };
    const r1 = resolveUserId(ctx);
    const r2 = resolveUserId(ctx);
    expect(r1).toBe(r2);
  });

  it("produces different hashes for different inputs", () => {
    const r1 = resolveUserId({ sessionKey: "session-a" });
    const r2 = resolveUserId({ sessionKey: "session-b" });
    expect(r1).not.toBe(r2);
  });
});

// ============================================================================
// isGroupChat
// ============================================================================

describe("isGroupChat", () => {
  it("detects Telegram group chat (negative ID)", () => {
    expect(
      isGroupChat({ sessionKey: "agent:main:telegram:-100123456" }),
    ).toBe(true);
  });

  it("does not flag Telegram DM", () => {
    expect(
      isGroupChat({ sessionKey: "agent:main:telegram:12345" }),
    ).toBe(false);
  });

  it("detects :group: in session key", () => {
    expect(
      isGroupChat({ sessionKey: "agent:main:discord:group:123" }),
    ).toBe(true);
  });

  it("detects :channel: in session key", () => {
    expect(
      isGroupChat({ sessionKey: "agent:main:discord:channel:456" }),
    ).toBe(true);
  });

  it("returns false for empty session key", () => {
    expect(isGroupChat({})).toBe(false);
  });

  it("returns false for regular DM-like session", () => {
    expect(
      isGroupChat({ sessionKey: "agent:main:discord:user_789" }),
    ).toBe(false);
  });
});

// ============================================================================
// Identity Map (load, save, build, resolve, add)
// ============================================================================

const TEST_DIR = join("/tmp", "openclaw-mem0-test-" + Date.now());

describe("Identity Map", () => {
  const testMapPath = join(TEST_DIR, "identity-map.json");

  const sampleMap: IdentityMap = {
    identities: [
      {
        canonical: "alice",
        aliases: ["telegram:dm:123456", "discord:user_789"],
        label: "Alice",
      },
      {
        canonical: "bob",
        aliases: ["telegram:dm:999"],
      },
    ],
  };

  // Setup/teardown
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("loadIdentityMap returns null for undefined path", () => {
    expect(loadIdentityMap(undefined)).toBeNull();
  });

  it("loadIdentityMap returns null for non-existent file", () => {
    expect(loadIdentityMap("/nonexistent/path.json")).toBeNull();
  });

  it("loadIdentityMap returns null for invalid JSON", () => {
    const invalidPath = join(TEST_DIR, "invalid.json");
    writeFileSync(invalidPath, "not-json", "utf-8");
    expect(loadIdentityMap(invalidPath)).toBeNull();
  });

  it("loadIdentityMap returns null if identities is not an array", () => {
    const badPath = join(TEST_DIR, "bad.json");
    writeFileSync(badPath, JSON.stringify({ identities: "not-array" }), "utf-8");
    expect(loadIdentityMap(badPath)).toBeNull();
  });

  it("saveIdentityMap + loadIdentityMap round-trips correctly", () => {
    saveIdentityMap(testMapPath, sampleMap);
    const loaded = loadIdentityMap(testMapPath);
    expect(loaded).toEqual(sampleMap);
  });

  it("buildAliasLookup returns null for null map", () => {
    expect(buildAliasLookup(null)).toBeNull();
  });

  it("buildAliasLookup creates correct lookup", () => {
    const lookup = buildAliasLookup(sampleMap)!;
    expect(lookup.get("telegram:dm:123456")).toBe("alice");
    expect(lookup.get("discord:user_789")).toBe("alice");
    expect(lookup.get("alice")).toBe("alice");
    expect(lookup.get("telegram:dm:999")).toBe("bob");
    expect(lookup.get("bob")).toBe("bob");
    expect(lookup.get("unknown")).toBeUndefined();
  });

  it("resolveCanonicalUserId maps alias to canonical", () => {
    const lookup = buildAliasLookup(sampleMap);
    expect(resolveCanonicalUserId("telegram:dm:123456", lookup)).toBe("alice");
  });

  it("resolveCanonicalUserId returns raw ID when not mapped", () => {
    const lookup = buildAliasLookup(sampleMap);
    expect(resolveCanonicalUserId("unknown:id", lookup)).toBe("unknown:id");
  });

  it("resolveCanonicalUserId returns raw ID when lookup is null", () => {
    expect(resolveCanonicalUserId("raw-id", null)).toBe("raw-id");
  });
});

// ============================================================================
// addAliasToIdentityMap
// ============================================================================

describe("addAliasToIdentityMap", () => {
  it("adds new alias to existing identity", () => {
    const map: IdentityMap = {
      identities: [{ canonical: "alice", aliases: ["alias1"] }],
    };
    const result = addAliasToIdentityMap(map, "alice", "alias2");
    expect(result.added).toBe(true);
    expect(result.entry.aliases).toContain("alias2");
  });

  it("does not duplicate existing alias on same identity", () => {
    const map: IdentityMap = {
      identities: [{ canonical: "alice", aliases: ["alias1"] }],
    };
    const result = addAliasToIdentityMap(map, "alice", "alias1");
    expect(result.added).toBe(false);
    expect(result.entry.aliases.filter((a) => a === "alias1")).toHaveLength(1);
  });

  it("moves alias from one identity to another", () => {
    const map: IdentityMap = {
      identities: [
        { canonical: "alice", aliases: ["alias1"] },
        { canonical: "bob", aliases: ["alias2"] },
      ],
    };
    const result = addAliasToIdentityMap(map, "alice", "alias2");
    expect(result.added).toBe(true);
    expect(result.entry.canonical).toBe("alice");
    expect(result.entry.aliases).toContain("alias2");
    // alias2 should be removed from bob
    const bob = map.identities.find((e) => e.canonical === "bob")!;
    expect(bob.aliases).not.toContain("alias2");
  });

  it("creates new identity if canonical does not exist", () => {
    const map: IdentityMap = { identities: [] };
    const result = addAliasToIdentityMap(map, "charlie", "alias1", "Charlie");
    expect(result.added).toBe(true);
    expect(result.entry.canonical).toBe("charlie");
    expect(result.entry.label).toBe("Charlie");
    expect(map.identities).toHaveLength(1);
  });
});
