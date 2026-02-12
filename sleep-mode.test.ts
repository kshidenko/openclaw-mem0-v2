import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  cleanMessages,
  buildLogEntry,
  appendToLog,
  readDailyLog,
  chunkForAnalysis,
  buildSleepAnalysisPrompt,
  parseSleepAnalysis,
  getProcessedDates,
  markProcessed,
  findUnprocessedLogs,
  searchLogs,
  saveDigest,
  DEFAULT_SLEEP_CONFIG,
  type LogEntry,
  type SleepAnalysis,
} from "./sleep-mode.js";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join("/tmp", "openclaw-sleep-test-" + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// cleanMessages
// ============================================================================

describe("cleanMessages", () => {
  it("extracts user and assistant messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const result = cleanMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("skips system messages", () => {
    const messages = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Hello" },
    ];
    const result = cleanMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("skips messages with <relevant-memories> content", () => {
    const messages = [
      { role: "user", content: "<relevant-memories>...</relevant-memories>" },
      { role: "user", content: "Real message" },
    ];
    const result = cleanMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Real message");
  });

  it("strips base64 data", () => {
    const longBase64 = "A".repeat(200);
    const messages = [
      {
        role: "user",
        content: `Look at this: data:image/png;base64,${longBase64} nice`,
      },
    ];
    const result = cleanMessages(messages);
    expect(result[0].content).toContain("[base64-data]");
    expect(result[0].content).not.toContain(longBase64);
  });

  it("truncates long tool results", () => {
    const longContent = "x".repeat(1000);
    const messages = [
      { role: "tool", content: longContent, name: "my_tool" },
    ];
    const result = cleanMessages(messages, 500);
    expect(result[0].content.length).toBeLessThan(600);
    expect(result[0].content).toContain("[truncated]");
    expect(result[0].tool_name).toBe("my_tool");
  });

  it("handles array content blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image_url", image_url: "..." },
          { type: "text", text: "World" },
        ],
      },
    ];
    const result = cleanMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Hello");
    expect(result[0].content).toContain("[image]");
    expect(result[0].content).toContain("World");
  });

  it("skips null/invalid messages", () => {
    const messages = [null, undefined, "string", { role: "user", content: "OK" }];
    const result = cleanMessages(messages as any);
    expect(result).toHaveLength(1);
  });

  it("skips messages with no content", () => {
    const messages = [{ role: "user" }, { role: "user", content: "" }];
    const result = cleanMessages(messages as any);
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// buildLogEntry
// ============================================================================

describe("buildLogEntry", () => {
  it("builds a log entry from valid messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const entry = buildLogEntry(messages, "alice", "telegram:dm:123", "sess-1");
    expect(entry).not.toBeNull();
    expect(entry!.user_id).toBe("alice");
    expect(entry!.channel).toBe("telegram:dm:123");
    expect(entry!.session_id).toBe("sess-1");
    expect(entry!.messages).toHaveLength(2);
    expect(entry!.ts).toBeTruthy();
  });

  it("returns null for empty messages", () => {
    const entry = buildLogEntry([], "alice", "ch", "sess");
    expect(entry).toBeNull();
  });

  it("returns null when all messages are filtered out", () => {
    const messages = [{ role: "system", content: "System prompt" }];
    const entry = buildLogEntry(messages, "alice", "ch", "sess");
    expect(entry).toBeNull();
  });
});

// ============================================================================
// appendToLog + readDailyLog
// ============================================================================

describe("appendToLog + readDailyLog", () => {
  it("appends and reads entries correctly", () => {
    const logDir = join(TEST_DIR, "logs-rw");
    const entry: LogEntry = {
      ts: "2026-02-07T10:00:00.000Z",
      user_id: "alice",
      channel: "telegram:dm:123",
      session_id: "sess-1",
      messages: [{ role: "user", content: "Hello" }],
    };

    appendToLog(logDir, entry);
    appendToLog(logDir, { ...entry, ts: "2026-02-07T11:00:00.000Z" });

    const logPath = join(logDir, "2026-02-07.jsonl");
    expect(existsSync(logPath)).toBe(true);

    const entries = readDailyLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].user_id).toBe("alice");
  });

  it("creates directory if it does not exist", () => {
    const logDir = join(TEST_DIR, "logs-new");
    const entry: LogEntry = {
      ts: "2026-01-01T00:00:00.000Z",
      user_id: "test",
      channel: "test",
      session_id: "test",
      messages: [{ role: "user", content: "test" }],
    };
    appendToLog(logDir, entry);
    expect(existsSync(logDir)).toBe(true);
  });

  it("readDailyLog returns empty for non-existent file", () => {
    expect(readDailyLog("/nonexistent/file.jsonl")).toEqual([]);
  });

  it("readDailyLog skips malformed lines", () => {
    const logDir = join(TEST_DIR, "logs-malformed");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "2026-02-08.jsonl");
    writeFileSync(
      logPath,
      `{"ts":"2026-02-08T00:00:00Z","user_id":"a","channel":"c","session_id":"s","messages":[{"role":"user","content":"ok"}]}\nnot-json\n`,
      "utf-8",
    );
    const entries = readDailyLog(logPath);
    expect(entries).toHaveLength(1);
  });
});

// ============================================================================
// chunkForAnalysis
// ============================================================================

describe("chunkForAnalysis", () => {
  it("groups small entries into a single chunk", () => {
    const entries: LogEntry[] = [
      {
        ts: "2026-02-07T10:00:00Z",
        user_id: "alice",
        channel: "ch",
        session_id: "s1",
        messages: [{ role: "user", content: "Short message" }],
      },
    ];
    const chunks = chunkForAnalysis(entries, 4000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Short message");
  });

  it("splits large entries into multiple chunks", () => {
    const entries: LogEntry[] = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-02-07T${String(i).padStart(2, "0")}:00:00Z`,
      user_id: "alice",
      channel: "ch",
      session_id: `s${i}`,
      messages: [{ role: "user", content: "x".repeat(200) }],
    }));
    const chunks = chunkForAnalysis(entries, 500);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("returns empty array for empty entries", () => {
    expect(chunkForAnalysis([])).toEqual([]);
  });
});

// ============================================================================
// buildSleepAnalysisPrompt
// ============================================================================

describe("buildSleepAnalysisPrompt", () => {
  it("includes the date and conversation text", () => {
    const prompt = buildSleepAnalysisPrompt("2026-02-07", "USER: Hello\nASSISTANT: Hi");
    expect(prompt).toContain("2026-02-07");
    expect(prompt).toContain("USER: Hello");
  });

  it("includes existing memories for dedup when provided", () => {
    const prompt = buildSleepAnalysisPrompt(
      "2026-02-07",
      "conversation text",
      ["User likes Python", "User lives in SF"],
    );
    expect(prompt).toContain("User likes Python");
    expect(prompt).toContain("User lives in SF");
    expect(prompt).toContain("Do NOT extract facts that already exist");
  });

  it("limits existing memories to 50", () => {
    const memories = Array.from({ length: 60 }, (_, i) => `Memory ${i}`);
    const prompt = buildSleepAnalysisPrompt("2026-02-07", "text", memories);
    expect(prompt).toContain("Memory 0");
    expect(prompt).toContain("Memory 49");
    expect(prompt).not.toContain("Memory 50");
  });

  it("does not include dedup section when no existing memories", () => {
    const prompt = buildSleepAnalysisPrompt("2026-02-07", "text");
    expect(prompt).not.toContain("Existing memories");
  });
});

// ============================================================================
// parseSleepAnalysis
// ============================================================================

describe("parseSleepAnalysis", () => {
  it("parses valid JSON response", () => {
    const input = JSON.stringify({
      hot_facts: ["fact1", "fact2"],
      patterns: ["pattern1"],
      reflections: ["reflection1"],
      consolidations: [{ merge_ids: ["id1", "id2"], into: "merged" }],
      digest: "Summary of the day",
    });
    const result = parseSleepAnalysis(input);
    expect(result.hot_facts).toEqual(["fact1", "fact2"]);
    expect(result.patterns).toEqual(["pattern1"]);
    expect(result.reflections).toEqual(["reflection1"]);
    expect(result.consolidations).toHaveLength(1);
    expect(result.consolidations[0].into).toBe("merged");
    expect(result.digest).toBe("Summary of the day");
  });

  it("strips markdown code fences", () => {
    const input = "```json\n" + JSON.stringify({
      hot_facts: ["fact"],
      patterns: [],
      reflections: [],
      consolidations: [],
      digest: "Done",
    }) + "\n```";
    const result = parseSleepAnalysis(input);
    expect(result.hot_facts).toEqual(["fact"]);
  });

  it("handles missing fields gracefully", () => {
    const result = parseSleepAnalysis("{}");
    expect(result.hot_facts).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.reflections).toEqual([]);
    expect(result.consolidations).toEqual([]);
    expect(result.digest).toBe("");
  });

  it("handles invalid consolidation entries", () => {
    const input = JSON.stringify({
      hot_facts: [],
      patterns: [],
      reflections: [],
      consolidations: [{ merge_ids: "not-array", into: 123 }],
      digest: "test",
    });
    const result = parseSleepAnalysis(input);
    expect(result.consolidations[0].merge_ids).toEqual([]);
    expect(result.consolidations[0].into).toBe("");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSleepAnalysis("not json")).toThrow();
  });
});

// ============================================================================
// getProcessedDates + markProcessed
// ============================================================================

describe("getProcessedDates + markProcessed", () => {
  it("returns empty set for missing .processed file", () => {
    const dates = getProcessedDates(join(TEST_DIR, "no-such-dir"));
    expect(dates.size).toBe(0);
  });

  it("marks and retrieves processed dates", () => {
    const logDir = join(TEST_DIR, "logs-processed");
    mkdirSync(logDir, { recursive: true });

    markProcessed(logDir, "2026-02-05");
    markProcessed(logDir, "2026-02-06");

    const dates = getProcessedDates(logDir);
    expect(dates.has("2026-02-05")).toBe(true);
    expect(dates.has("2026-02-06")).toBe(true);
    expect(dates.has("2026-02-07")).toBe(false);
  });
});

// ============================================================================
// findUnprocessedLogs
// ============================================================================

describe("findUnprocessedLogs", () => {
  it("returns empty for non-existent directory", () => {
    expect(findUnprocessedLogs("/nonexistent")).toEqual([]);
  });

  it("finds unprocessed log files, skipping today and processed", () => {
    const logDir = join(TEST_DIR, "logs-find");
    mkdirSync(logDir, { recursive: true });

    // Use a fixed date to avoid midnight boundary issues
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));

    // Create some log files
    writeFileSync(join(logDir, "2026-02-10.jsonl"), "", "utf-8"); // today, should skip
    writeFileSync(join(logDir, "2026-02-01.jsonl"), "", "utf-8");
    writeFileSync(join(logDir, "2026-02-02.jsonl"), "", "utf-8");

    // Mark one as processed
    markProcessed(logDir, "2026-02-01");

    const result = findUnprocessedLogs(logDir);
    expect(result.map((r) => r.date)).toContain("2026-02-02");
    expect(result.map((r) => r.date)).not.toContain("2026-02-01");
    expect(result.map((r) => r.date)).not.toContain("2026-02-10");

    vi.useRealTimers();
  });

  it("sorts results chronologically", () => {
    const logDir = join(TEST_DIR, "logs-sort");
    mkdirSync(logDir, { recursive: true });

    writeFileSync(join(logDir, "2026-02-05.jsonl"), "", "utf-8");
    writeFileSync(join(logDir, "2026-02-03.jsonl"), "", "utf-8");
    writeFileSync(join(logDir, "2026-02-04.jsonl"), "", "utf-8");

    const result = findUnprocessedLogs(logDir);
    expect(result[0].date).toBe("2026-02-03");
    expect(result[1].date).toBe("2026-02-04");
    expect(result[2].date).toBe("2026-02-05");
  });
});

// ============================================================================
// searchLogs
// ============================================================================

describe("searchLogs", () => {
  it("returns empty for non-existent directory", () => {
    expect(searchLogs("/nonexistent", "query")).toEqual([]);
  });

  it("finds matching entries", () => {
    const logDir = join(TEST_DIR, "logs-search");
    mkdirSync(logDir, { recursive: true });

    const entry: LogEntry = {
      ts: "2026-02-07T10:00:00Z",
      user_id: "alice",
      channel: "ch",
      session_id: "s1",
      messages: [
        { role: "user", content: "I love TypeScript programming" },
        { role: "assistant", content: "Great choice!" },
      ],
    };
    writeFileSync(
      join(logDir, "2026-02-07.jsonl"),
      JSON.stringify(entry) + "\n",
      "utf-8",
    );

    const results = searchLogs(logDir, "TypeScript");
    expect(results).toHaveLength(1);
    expect(results[0].matchContext).toContain("TypeScript");
  });

  it("case-insensitive search", () => {
    const logDir = join(TEST_DIR, "logs-search-ci");
    mkdirSync(logDir, { recursive: true });

    const entry: LogEntry = {
      ts: "2026-02-07T10:00:00Z",
      user_id: "alice",
      channel: "ch",
      session_id: "s1",
      messages: [{ role: "user", content: "Python is great" }],
    };
    writeFileSync(
      join(logDir, "2026-02-07.jsonl"),
      JSON.stringify(entry) + "\n",
      "utf-8",
    );

    const results = searchLogs(logDir, "python");
    expect(results).toHaveLength(1);
  });

  it("respects date filters", () => {
    const logDir = join(TEST_DIR, "logs-search-dates");
    mkdirSync(logDir, { recursive: true });

    const makeEntry = (date: string): LogEntry => ({
      ts: `${date}T10:00:00Z`,
      user_id: "alice",
      channel: "ch",
      session_id: "s1",
      messages: [{ role: "user", content: "Search target" }],
    });

    writeFileSync(
      join(logDir, "2026-02-05.jsonl"),
      JSON.stringify(makeEntry("2026-02-05")) + "\n",
      "utf-8",
    );
    writeFileSync(
      join(logDir, "2026-02-07.jsonl"),
      JSON.stringify(makeEntry("2026-02-07")) + "\n",
      "utf-8",
    );
    writeFileSync(
      join(logDir, "2026-02-09.jsonl"),
      JSON.stringify(makeEntry("2026-02-09")) + "\n",
      "utf-8",
    );

    const results = searchLogs(logDir, "target", "2026-02-06", "2026-02-08");
    expect(results).toHaveLength(1);
    expect(results[0].entry.ts).toContain("2026-02-07");
  });

  it("respects limit", () => {
    const logDir = join(TEST_DIR, "logs-search-limit");
    mkdirSync(logDir, { recursive: true });

    const entries = Array.from({ length: 10 }, (_, i): LogEntry => ({
      ts: `2026-02-07T${String(i).padStart(2, "0")}:00:00Z`,
      user_id: "alice",
      channel: "ch",
      session_id: `s${i}`,
      messages: [{ role: "user", content: "findme" }],
    }));
    writeFileSync(
      join(logDir, "2026-02-07.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );

    const results = searchLogs(logDir, "findme", undefined, undefined, 3);
    expect(results).toHaveLength(3);
  });
});

// ============================================================================
// saveDigest
// ============================================================================

describe("saveDigest", () => {
  it("saves a digest markdown file", () => {
    const digestDir = join(TEST_DIR, "digests");
    const analysis: SleepAnalysis = {
      hot_facts: ["User prefers TypeScript"],
      patterns: ["Works late at night"],
      reflections: ["Could have been more detailed"],
      consolidations: [{ merge_ids: ["id1", "id2"], into: "merged fact" }],
      digest: "A productive day of coding.",
    };

    saveDigest(digestDir, "2026-02-07", analysis, {
      totalHotMemories: 42,
      totalColdChunks: 10,
    });

    const digestPath = join(digestDir, "2026-02-07.md");
    expect(existsSync(digestPath)).toBe(true);

    const content = readFileSync(digestPath, "utf-8");
    expect(content).toContain("# Memory Digest — 2026-02-07");
    expect(content).toContain("A productive day of coding.");
    expect(content).toContain("User prefers TypeScript");
    expect(content).toContain("Works late at night");
    expect(content).toContain("Could have been more detailed");
    expect(content).toContain("merged fact");
    expect(content).toContain("Hot memories: 42");
    expect(content).toContain("Cold chunks: 10");
  });

  it("creates digest directory if it does not exist", () => {
    const digestDir = join(TEST_DIR, "digests-new");
    saveDigest(digestDir, "2026-02-08", {
      hot_facts: [],
      patterns: [],
      reflections: [],
      consolidations: [],
      digest: "Nothing happened",
    });
    expect(existsSync(digestDir)).toBe(true);
  });
});

// ============================================================================
// DEFAULT_SLEEP_CONFIG
// ============================================================================

describe("DEFAULT_SLEEP_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_SLEEP_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SLEEP_CONFIG.logDir).toBe("memory/logs");
    expect(DEFAULT_SLEEP_CONFIG.digestDir).toBe("memory/digests");
    expect(DEFAULT_SLEEP_CONFIG.maxChunkChars).toBe(4000);
    expect(DEFAULT_SLEEP_CONFIG.retentionDays).toBe(365);
    expect(DEFAULT_SLEEP_CONFIG.digestEnabled).toBe(true);
  });
});
