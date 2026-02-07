/**
 * User resolver for OpenClaw Mem0 v2 plugin.
 *
 * Resolves a unique user ID from the OpenClaw hook context
 * to enable per-user memory isolation across channels
 * (Telegram, Discord, session-based, etc.).
 *
 * Supports Multi-ID resolution: multiple channel-specific IDs
 * (aliases) can map to a single canonical user ID via identity-map.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { IdentityMap, IdentityEntry } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Context available from OpenClaw hooks for user resolution. */
type HookContext = {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

/**
 * Context available from OpenClaw tool factory (OpenClawPluginToolContext).
 * Uses `messageChannel` instead of `messageProvider`.
 */
type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
};

/** Union type: works with both hook and tool contexts. */
type AnyContext = HookContext | ToolContext;

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve a user ID from the hook context.
 *
 * Priority:
 * 1. Extract provider + peer from sessionKey (e.g., "agent:main:telegram:12345" -> "telegram:12345")
 * 2. Use messageProvider + sessionKey hash as fallback
 * 3. Default to "default"
 *
 * Args:
 *     ctx: Hook or tool context from OpenClaw.
 *
 * Returns:
 *     string: Resolved user ID (e.g., "telegram:12345", "discord:user_789", "default").
 */
export function resolveUserId(ctx: AnyContext): string {
  const sessionKey = ctx.sessionKey ?? "";
  const provider =
    ("messageProvider" in ctx ? ctx.messageProvider : undefined) ??
    ("messageChannel" in ctx ? ctx.messageChannel : undefined) ??
    "";

  // Pattern: agent:<agentId>:<provider>:<peerId>
  const sessionParts = sessionKey.split(":");
  if (sessionParts.length >= 4) {
    const providerPart = sessionParts[2];
    const peerPart = sessionParts.slice(3).join(":");
    if (providerPart && peerPart) {
      return `${providerPart}:${peerPart}`;
    }
  }

  // Fallback: provider + session hash
  if (provider && sessionKey) {
    return `${provider}:${simpleHash(sessionKey)}`;
  }

  // Last resort
  if (sessionKey) {
    return `session:${simpleHash(sessionKey)}`;
  }

  return "default";
}

/**
 * Check if the session context indicates a group chat.
 *
 * Args:
 *     ctx: Hook context from OpenClaw.
 *
 * Returns:
 *     boolean: True if this appears to be a group chat.
 */
export function isGroupChat(ctx: HookContext): boolean {
  const sessionKey = ctx.sessionKey ?? "";
  if (sessionKey.includes("telegram:") && sessionKey.includes("-")) {
    const parts = sessionKey.split(":");
    const lastPart = parts[parts.length - 1];
    if (lastPart?.startsWith("-")) return true;
  }
  if (sessionKey.includes(":group:") || sessionKey.includes(":channel:")) {
    return true;
  }
  return false;
}

// ============================================================================
// Identity Map (Multi-ID)
// ============================================================================

/**
 * Load an identity map from a JSON file.
 *
 * Args:
 *     path: Absolute path to identity-map.json.
 *
 * Returns:
 *     IdentityMap | null: Parsed identity map or null on failure.
 */
export function loadIdentityMap(path?: string): IdentityMap | null {
  if (!path) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as IdentityMap;
    if (!Array.isArray(parsed.identities)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save an identity map to a JSON file.
 *
 * Args:
 *     path: Absolute path to identity-map.json.
 *     map: The identity map to persist.
 */
export function saveIdentityMap(path: string, map: IdentityMap): void {
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n", "utf-8");
}

/**
 * Build a fast alias -> canonical lookup map from an IdentityMap.
 *
 * Args:
 *     identityMap: The identity map to index.
 *
 * Returns:
 *     Map<string, string>: Alias to canonical ID lookup.
 */
export function buildAliasLookup(
  identityMap: IdentityMap | null,
): Map<string, string> | null {
  if (!identityMap) return null;
  const lookup = new Map<string, string>();
  for (const entry of identityMap.identities) {
    for (const alias of entry.aliases) {
      lookup.set(alias, entry.canonical);
    }
    lookup.set(entry.canonical, entry.canonical);
  }
  return lookup;
}

/**
 * Resolve a raw user ID to a canonical ID using the identity map.
 *
 * Args:
 *     rawId: The raw user ID from session resolution.
 *     aliasLookup: Pre-built alias -> canonical lookup map.
 *
 * Returns:
 *     string: Canonical user ID or the raw ID if not mapped.
 */
export function resolveCanonicalUserId(
  rawId: string,
  aliasLookup: Map<string, string> | null,
): string {
  if (!aliasLookup) return rawId;
  return aliasLookup.get(rawId) ?? rawId;
}

/**
 * Add an alias to an identity in the map.
 *
 * Args:
 *     map: Current identity map (mutated in place).
 *     canonical: The canonical user ID.
 *     alias: The alias to link.
 *     label: Optional human-readable label for new entries.
 *
 * Returns:
 *     { added: boolean; entry: IdentityEntry }
 */
export function addAliasToIdentityMap(
  map: IdentityMap,
  canonical: string,
  alias: string,
  label?: string,
): { added: boolean; entry: IdentityEntry } {
  for (const entry of map.identities) {
    if (entry.aliases.includes(alias)) {
      if (entry.canonical === canonical) {
        return { added: false, entry };
      }
      entry.aliases = entry.aliases.filter((a) => a !== alias);
      break;
    }
  }

  let targetEntry = map.identities.find((e) => e.canonical === canonical);
  if (!targetEntry) {
    targetEntry = { canonical, aliases: [], label };
    map.identities.push(targetEntry);
  }

  if (!targetEntry.aliases.includes(alias)) {
    targetEntry.aliases.push(alias);
    return { added: true, entry: targetEntry };
  }

  return { added: false, entry: targetEntry };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Simple string hash for generating deterministic short IDs.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, "0").slice(0, 8);
}
