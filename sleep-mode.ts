/**
 * Sleep Mode — Background Memory Maintenance for OpenClaw Mem0 v2.
 *
 * Provides nightly (or on-demand) analysis of conversation logs
 * to extract missed facts, discover patterns, generate digests,
 * and maintain memory quality through deduplication.
 *
 * Architecture:
 * - Phase 1: Raw log collection (append cleaned JSONL in agent_end)
 * - Phase 2: Sleep maintenance job (LLM analysis of unprocessed logs)
 * - Phase 3: Cold search (search through conversation history)
 * - Phase 4: Daily digest generation
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// ============================================================================
// Types
// ============================================================================

/** A single cleaned conversation entry in our JSONL log format. */
export interface LogEntry {
  /** ISO timestamp */
  ts: string;
  /** Canonical user ID */
  user_id: string;
  /** Channel identifier (e.g. "telegram:dm:123456") */
  channel: string;
  /** Session ID for grouping */
  session_id: string;
  /** Cleaned conversation messages */
  messages: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    /** Tool name, if role is "tool" */
    tool_name?: string;
  }>;
}

/** Result of LLM analysis during sleep maintenance. */
export interface SleepAnalysis {
  /** Facts to promote to hot memory (mem0 store). */
  hot_facts: string[];
  /** Behavioral/interaction patterns discovered. */
  patterns: string[];
  /** Self-reflection insights. */
  reflections: string[];
  /** Duplicate memory consolidations. */
  consolidations: Array<{
    merge_ids: string[];
    into: string;
  }>;
  /** One-paragraph daily summary. */
  digest: string;
}

/** Sleep mode configuration. */
export interface SleepConfig {
  /** Enable sleep mode. */
  enabled: boolean;
  /** Directory for our cleaned JSONL logs (relative to plugin dir). */
  logDir: string;
  /** Directory for daily digests. */
  digestDir: string;
  /** Max characters per chunk when sending to LLM. */
  maxChunkChars: number;
  /** Number of days to retain raw logs. */
  retentionDays: number;
  /** Enable daily digest generation. */
  digestEnabled: boolean;
}

/** Default sleep mode configuration. */
export const DEFAULT_SLEEP_CONFIG: SleepConfig = {
  enabled: false,
  logDir: "memory/logs",
  digestDir: "memory/digests",
  maxChunkChars: 4000,
  retentionDays: 365,
  digestEnabled: true,
};

// ============================================================================
// Phase 1: Raw Log Collection
// ============================================================================

/**
 * Append a conversation entry to the daily JSONL log.
 *
 * Called from agent_end hook to persist cleaned conversation data.
 *
 * Args:
 *     logDir: Absolute path to the logs directory.
 *     entry: Cleaned conversation entry to append.
 */
export function appendToLog(logDir: string, entry: LogEntry): void {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const date = entry.ts.split("T")[0]; // "2026-02-07"
  const logFile = join(logDir, `${date}.jsonl`);
  appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Clean raw messages from OpenClaw agent_end hook.
 *
 * Removes noise like base64 data, system prompts, and large tool results.
 * Extracts only user and assistant text content.
 *
 * Args:
 *     messages: Raw messages from the agent_end event.
 *     maxToolResultChars: Max characters for tool result truncation.
 *
 * Returns:
 *     Array of cleaned message objects suitable for JSONL logging.
 */
export function cleanMessages(
  messages: Array<Record<string, unknown>>,
  maxToolResultChars: number = 500,
): LogEntry["messages"] {
  const cleaned: LogEntry["messages"] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    const role = msg.role as string;
    if (!role) continue;

    // Skip system messages
    if (role === "system") continue;

    let textContent = "";
    const content = msg.content;

    if (typeof content === "string") {
      textContent = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;

        if (b.type === "text" && typeof b.text === "string") {
          textContent += (textContent ? "\n" : "") + b.text;
        } else if (b.type === "image_url" || b.type === "image") {
          textContent += (textContent ? "\n" : "") + "[image]";
        }
      }
    }

    if (!textContent) continue;

    // Skip injected memory context
    if (textContent.includes("<relevant-memories>")) continue;

    // Strip base64 data
    textContent = textContent.replace(
      /data:[a-zA-Z]+\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]{100,}/g,
      "[base64-data]",
    );

    // Truncate tool results
    if (role === "tool" && textContent.length > maxToolResultChars) {
      textContent = textContent.substring(0, maxToolResultChars) + " [truncated]";
    }

    // Determine clean role
    const cleanRole: "user" | "assistant" | "tool" =
      role === "user" ? "user" : role === "tool" ? "tool" : "assistant";

    const entry: LogEntry["messages"][number] = {
      role: cleanRole,
      content: textContent,
    };

    // Capture tool name if present
    if (role === "tool" && typeof msg.name === "string") {
      entry.tool_name = msg.name;
    }

    cleaned.push(entry);
  }

  return cleaned;
}

/**
 * Build a LogEntry from agent_end hook data.
 *
 * Args:
 *     messages: Raw messages from agent_end event.
 *     userId: Resolved canonical user ID.
 *     channel: Channel identifier (e.g. "telegram:dm:123456").
 *     sessionId: Session ID for grouping.
 *
 * Returns:
 *     LogEntry ready to be appended to JSONL, or null if no useful content.
 */
export function buildLogEntry(
  messages: Array<Record<string, unknown>>,
  userId: string,
  channel: string,
  sessionId: string,
): LogEntry | null {
  const cleanedMessages = cleanMessages(messages);
  if (cleanedMessages.length === 0) return null;

  return {
    ts: new Date().toISOString(),
    user_id: userId,
    channel,
    session_id: sessionId,
    messages: cleanedMessages,
  };
}

// ============================================================================
// Phase 2: Sleep Maintenance Job
// ============================================================================

/**
 * Get the set of already-processed dates.
 *
 * Args:
 *     logDir: Absolute path to the logs directory.
 *
 * Returns:
 *     Set of date strings (e.g. "2026-02-07") that have been processed.
 */
export function getProcessedDates(logDir: string): Set<string> {
  const processedFile = join(logDir, ".processed");
  if (!existsSync(processedFile)) return new Set();

  try {
    const content = readFileSync(processedFile, "utf-8");
    return new Set(
      content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Mark a date as processed.
 *
 * Args:
 *     logDir: Absolute path to the logs directory.
 *     date: Date string to mark (e.g. "2026-02-07").
 */
export function markProcessed(logDir: string, date: string): void {
  const processedFile = join(logDir, ".processed");
  appendFileSync(processedFile, date + "\n", "utf-8");
}

/**
 * Find unprocessed daily log files.
 *
 * Skips today's log (still being written) and already-processed dates.
 *
 * Args:
 *     logDir: Absolute path to the logs directory.
 *
 * Returns:
 *     Array of { date, path } for unprocessed log files, sorted chronologically.
 */
export function findUnprocessedLogs(
  logDir: string,
): Array<{ date: string; path: string }> {
  if (!existsSync(logDir)) return [];

  const processed = getProcessedDates(logDir);
  const today = new Date().toISOString().split("T")[0];

  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      date: basename(f, ".jsonl"),
      path: join(logDir, f),
    }))
    .filter((f) => f.date !== today && !processed.has(f.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  return files;
}

/**
 * Read and parse a daily JSONL log file.
 *
 * Args:
 *     logPath: Absolute path to a JSONL log file.
 *
 * Returns:
 *     Array of parsed LogEntry objects.
 */
export function readDailyLog(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return [];

  const content = readFileSync(logPath, "utf-8");
  const entries: LogEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Convert log entries into text chunks suitable for LLM analysis.
 *
 * Chunks are split by approximate character limit, respecting
 * conversation boundaries.
 *
 * Args:
 *     entries: Array of log entries for a single day.
 *     maxChunkChars: Maximum characters per chunk.
 *
 * Returns:
 *     Array of text chunks, each a concatenation of conversation turns.
 */
export function chunkForAnalysis(
  entries: LogEntry[],
  maxChunkChars: number = 4000,
): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const entry of entries) {
    // Format a single conversation entry as text
    const lines: string[] = [];
    lines.push(`--- Session: ${entry.session_id} | User: ${entry.user_id} | ${entry.ts} ---`);

    for (const msg of entry.messages) {
      const prefix =
        msg.role === "user"
          ? "USER"
          : msg.role === "tool"
            ? `TOOL(${msg.tool_name || "unknown"})`
            : "ASSISTANT";
      lines.push(`${prefix}: ${msg.content}`);
    }

    const entryText = lines.join("\n") + "\n\n";

    // Check if adding this entry would exceed the chunk limit
    if (currentChunk.length + entryText.length > maxChunkChars && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = entryText;
    } else {
      currentChunk += entryText;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Build the LLM analysis prompt for sleep maintenance.
 *
 * Args:
 *     date: The date being analyzed (e.g. "2026-02-07").
 *     conversationText: Concatenated conversation text for the day.
 *     existingMemories: Optional list of existing hot memories for dedup reference.
 *
 * Returns:
 *     string: The full LLM prompt for analysis.
 */
export function buildSleepAnalysisPrompt(
  date: string,
  conversationText: string,
  existingMemories?: string[],
): string {
  let prompt = `You are performing memory maintenance for a personal AI assistant.
Review the conversation log from ${date} and perform the following tasks:

1. EXTRACT missed facts:
   - Personal details about the user not yet in memory
   - Technical infrastructure mentioned in passing (servers, IPs, services, ports)
   - Decisions, preferences, or patterns
   - Commands, configurations, or technical setup details

2. FIND patterns:
   - Recurring topics or interests
   - Problem-solving patterns
   - Preferences in communication style or workflow

3. SELF-REFLECT:
   - What did the assistant learn about the user today?
   - What could have been done better?
   - What should be remembered for future interactions?

4. CONSOLIDATE:
   - Are there duplicate or conflicting facts?
   - Can multiple related facts be merged into one?

For each finding, classify as:
- HOT: promote to active memory (important fact, will be recalled frequently)
- PATTERN: behavioral or interaction pattern worth noting
- DIGEST: include in daily summary only

`;

  if (existingMemories && existingMemories.length > 0) {
    prompt += `\nExisting memories (for deduplication):\n`;
    for (const mem of existingMemories.slice(0, 50)) {
      prompt += `- ${mem}\n`;
    }
    prompt += `\nDo NOT extract facts that already exist in the list above.\n`;
  }

  prompt += `\nConversation log:\n${conversationText}\n`;

  prompt += `\nReturn a valid JSON object with this structure:
{
  "hot_facts": ["fact1", "fact2"],
  "patterns": ["pattern1"],
  "reflections": ["reflection1"],
  "consolidations": [{"merge_ids": ["id1", "id2"], "into": "merged fact text"}],
  "digest": "One paragraph summary of the day's interactions"
}

IMPORTANT:
- hot_facts should be clear, self-contained statements in third person
- Include ONLY genuinely new and important information
- The digest should be 2-4 sentences summarizing the day
- consolidations may be empty if no duplicates found
- Return ONLY the JSON, no markdown or other formatting`;

  return prompt;
}

/**
 * Parse the LLM's JSON response into a SleepAnalysis object.
 *
 * Handles edge cases like markdown code fences around the JSON.
 *
 * Args:
 *     response: Raw LLM response text.
 *
 * Returns:
 *     SleepAnalysis: Parsed analysis result.
 *
 * Raises:
 *     Error: If the response cannot be parsed as valid JSON.
 */
export function parseSleepAnalysis(response: string): SleepAnalysis {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(cleaned);

  return {
    hot_facts: Array.isArray(parsed.hot_facts) ? parsed.hot_facts : [],
    patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
    reflections: Array.isArray(parsed.reflections) ? parsed.reflections : [],
    consolidations: Array.isArray(parsed.consolidations)
      ? parsed.consolidations.map((c: any) => ({
          merge_ids: Array.isArray(c.merge_ids) ? c.merge_ids : [],
          into: typeof c.into === "string" ? c.into : "",
        }))
      : [],
    digest: typeof parsed.digest === "string" ? parsed.digest : "",
  };
}

// ============================================================================
// Phase 3: Cold Search
// ============================================================================

/**
 * Search through conversation log files for a query string.
 *
 * Simple text-based search across JSONL log files.
 * For production use, this should be replaced with vector search.
 *
 * Args:
 *     logDir: Absolute path to the logs directory.
 *     query: Search query string.
 *     dateFrom: Optional start date filter (inclusive).
 *     dateTo: Optional end date filter (inclusive).
 *     limit: Maximum number of results to return.
 *
 * Returns:
 *     Array of matching log entries with relevance context.
 */
export function searchLogs(
  logDir: string,
  query: string,
  dateFrom?: string,
  dateTo?: string,
  limit: number = 5,
): Array<{ entry: LogEntry; matchContext: string }> {
  if (!existsSync(logDir)) return [];

  const queryLower = query.toLowerCase();
  const results: Array<{ entry: LogEntry; matchContext: string }> = [];

  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ date: basename(f, ".jsonl"), path: join(logDir, f) }))
    .filter((f) => {
      if (dateFrom && f.date < dateFrom) return false;
      if (dateTo && f.date > dateTo) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date)); // newest first

  for (const file of files) {
    if (results.length >= limit) break;

    const entries = readDailyLog(file.path);
    for (const entry of entries) {
      if (results.length >= limit) break;

      // Check if any message contains the query
      for (const msg of entry.messages) {
        if (msg.content.toLowerCase().includes(queryLower)) {
          // Extract a context snippet around the match
          const idx = msg.content.toLowerCase().indexOf(queryLower);
          const start = Math.max(0, idx - 100);
          const end = Math.min(msg.content.length, idx + query.length + 100);
          const matchContext =
            (start > 0 ? "..." : "") +
            msg.content.substring(start, end) +
            (end < msg.content.length ? "..." : "");

          results.push({ entry, matchContext });
          break; // One match per entry is enough
        }
      }
    }
  }

  return results;
}

// ============================================================================
// Phase 4: Daily Digest
// ============================================================================

/**
 * Save a daily digest to a markdown file.
 *
 * Args:
 *     digestDir: Absolute path to the digests directory.
 *     date: Date string (e.g. "2026-02-07").
 *     analysis: The sleep analysis result.
 *     stats: Optional memory statistics.
 */
export function saveDigest(
  digestDir: string,
  date: string,
  analysis: SleepAnalysis,
  stats?: { totalHotMemories?: number; totalColdChunks?: number },
): void {
  if (!existsSync(digestDir)) {
    mkdirSync(digestDir, { recursive: true });
  }

  const lines: string[] = [];
  lines.push(`# Memory Digest — ${date}\n`);

  if (analysis.digest) {
    lines.push(`## Summary\n`);
    lines.push(`${analysis.digest}\n`);
  }

  if (analysis.hot_facts.length > 0) {
    lines.push(`## New Facts Discovered\n`);
    for (const fact of analysis.hot_facts) {
      lines.push(`- ${fact}`);
    }
    lines.push("");
  }

  if (analysis.patterns.length > 0) {
    lines.push(`## Patterns Noticed\n`);
    for (const pattern of analysis.patterns) {
      lines.push(`- ${pattern}`);
    }
    lines.push("");
  }

  if (analysis.reflections.length > 0) {
    lines.push(`## Self-Reflections\n`);
    for (const reflection of analysis.reflections) {
      lines.push(`- ${reflection}`);
    }
    lines.push("");
  }

  if (analysis.consolidations.length > 0) {
    lines.push(`## Memory Consolidations\n`);
    for (const c of analysis.consolidations) {
      lines.push(`- Merged ${c.merge_ids.length} entries into: "${c.into}"`);
    }
    lines.push("");
  }

  if (stats) {
    lines.push(`## Memory Stats\n`);
    if (stats.totalHotMemories != null) {
      lines.push(`- Hot memories: ${stats.totalHotMemories}`);
    }
    if (stats.totalColdChunks != null) {
      lines.push(`- Cold chunks: ${stats.totalColdChunks}`);
    }
    lines.push("");
  }

  const digestPath = join(digestDir, `${date}.md`);
  writeFileSync(digestPath, lines.join("\n"), "utf-8");
}

// ============================================================================
// OpenClaw Native Session Log Reader
// ============================================================================

/**
 * Read messages from OpenClaw native session JSONL files.
 *
 * OpenClaw stores session logs in ~/.openclaw/agents/<agentId>/sessions/*.jsonl
 * with entries of type "message" containing {message: {role, content}}.
 *
 * Args:
 *     sessionsDir: Absolute path to the sessions directory.
 *     since: Optional ISO timestamp; only return messages after this time.
 *
 * Returns:
 *     Array of extracted messages with metadata.
 */
export function readOpenClawSessions(
  sessionsDir: string,
  since?: string,
): Array<{
  sessionId: string;
  timestamp: string;
  role: string;
  content: string;
}> {
  if (!existsSync(sessionsDir)) return [];

  const results: Array<{
    sessionId: string;
    timestamp: string;
    role: string;
    content: string;
  }> = [];

  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl") && !f.includes(".deleted."))
    .sort();

  for (const file of files) {
    const sessionId = basename(file, ".jsonl");
    const content = readFileSync(join(sessionsDir, file), "utf-8");

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed);

        // Only process message entries
        if (entry.type !== "message" || !entry.message) continue;

        // Filter by timestamp if specified
        if (since && entry.timestamp && entry.timestamp < since) continue;

        const msg = entry.message;
        const role = msg.role;
        if (role !== "user" && role !== "assistant") continue;

        // Extract text content
        let textContent = "";
        if (typeof msg.content === "string") {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              textContent += (textContent ? "\n" : "") + block.text;
            }
          }
        }

        if (!textContent || textContent.length < 5) continue;

        // Skip memory context injections
        if (textContent.includes("<relevant-memories>")) continue;

        // Strip base64
        textContent = textContent.replace(
          /data:[a-zA-Z]+\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]{100,}/g,
          "[base64-data]",
        );

        results.push({
          sessionId,
          timestamp: entry.timestamp || new Date().toISOString(),
          role,
          content: textContent,
        });
      } catch {
        // Skip malformed lines
      }
    }
  }

  return results;
}
