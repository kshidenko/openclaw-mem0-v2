/**
 * Shared types for the OpenClaw Mem0 v2 plugin.
 *
 * Contains identity mapping types and sleep mode configuration.
 */

// ============================================================================
// Identity Mapping
// ============================================================================

/**
 * A single identity entry linking a canonical user ID to channel-specific aliases.
 *
 * Example:
 *     { canonical: "alice", aliases: ["telegram:dm:123456", "discord:user_789"], label: "Alice (owner)" }
 */
export type IdentityEntry = {
  canonical: string;
  aliases: string[];
  label?: string;
};

/**
 * Identity map file structure (identity-map.json).
 *
 * Maps multiple channel-specific IDs (aliases) to a single canonical user ID
 * so that memories from all channels are unified under one identity.
 */
export type IdentityMap = {
  identities: IdentityEntry[];
};
