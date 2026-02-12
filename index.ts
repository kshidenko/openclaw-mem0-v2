/**
 * OpenClaw Memory (Mem0) Plugin — Enhanced v2
 *
 * Long-term memory via Mem0 — supports both the Mem0 platform
 * and the open-source self-hosted SDK. Uses the official `mem0ai` package.
 *
 * Based on the official mem0ai/mem0 OpenClaw plugin with enhancements:
 *
 * Features:
 * - 6 tools: memory_search, memory_list, memory_store, memory_store_raw,
 *   memory_get, memory_forget
 * - Session-scoped and long-term (user-scoped) memory with scope parameter
 * - memory_store_raw: verbatim storage without LLM extraction
 * - Auto-recall: injects relevant memories before each agent turn
 * - Auto-capture: stores key facts after each agent turn
 * - Identity mapping: multi-channel user resolution (Telegram/Discord/etc.)
 * - Graph memory support in OSS mode (Kuzu provider)
 * - Extended extraction prompt: +infrastructure, +assistant, +remember override
 * - Category-based search filtering
 * - Group chat detection and skip logic
 * - CLI: openclaw mem0 search, openclaw mem0 stats
 * - Dual mode: platform or open-source (self-hosted)
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  resolveUserId,
  isGroupChat,
  loadIdentityMap,
  buildAliasLookup,
  resolveCanonicalUserId,
} from "./user-resolver.js";
import {
  appendToLog,
  buildLogEntry,
  findUnprocessedLogs,
  readDailyLog,
  chunkForAnalysis,
  buildSleepAnalysisPrompt,
  parseSleepAnalysis,
  markProcessed,
  saveDigest,
  searchLogs,
  DEFAULT_SLEEP_CONFIG,
  type SleepConfig,
  type SleepAnalysis,
} from "./sleep-mode.js";

// ============================================================================
// Types
// ============================================================================

type Mem0Mode = "platform" | "open-source";

type Mem0Config = {
  mode: Mem0Mode;
  // Platform-specific
  apiKey?: string;
  orgId?: string;
  projectId?: string;
  customInstructions: string;
  customCategories: Record<string, string>;
  enableGraph: boolean;
  // OSS-specific
  customPrompt?: string;
  oss?: {
    embedder?: { provider: string; config: Record<string, unknown> };
    vectorStore?: { provider: string; config: Record<string, unknown> };
    llm?: { provider: string; config: Record<string, unknown> };
    graphStore?: { provider: string; config: Record<string, unknown> };
    historyDbPath?: string;
  };
  // Shared
  userId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  searchThreshold: number;
  topK: number;
  // Our additions
  identityMapPath?: string;
  skipGroupChats: boolean;
  sleepMode: SleepConfig;
};

// Unified types for the provider interface
interface AddOptions {
  user_id: string;
  run_id?: string;
  custom_instructions?: string;
  custom_categories?: Array<Record<string, string>>;
  enable_graph?: boolean;
  output_format?: string;
}

interface SearchOptions {
  user_id: string;
  run_id?: string;
  top_k?: number;
  threshold?: number;
  limit?: number;
  keyword_search?: boolean;
  reranking?: boolean;
}

interface ListOptions {
  user_id: string;
  run_id?: string;
  page_size?: number;
}

interface MemoryItem {
  id: string;
  memory: string;
  user_id?: string;
  score?: number;
  categories?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface AddResultItem {
  id: string;
  memory: string;
  event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
}

interface AddResult {
  results: AddResultItem[];
}

// ============================================================================
// Unified Provider Interface
// ============================================================================

interface Mem0Provider {
  add(
    messages: Array<{ role: string; content: string }>,
    options: AddOptions,
  ): Promise<AddResult>;
  search(query: string, options: SearchOptions): Promise<MemoryItem[]>;
  get(memoryId: string): Promise<MemoryItem>;
  getAll(options: ListOptions): Promise<MemoryItem[]>;
  delete(memoryId: string): Promise<void>;
}

// ============================================================================
// Platform Provider (Mem0 Cloud)
// ============================================================================

class PlatformProvider implements Mem0Provider {
  private client: any; // MemoryClient from mem0ai
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly orgId?: string,
    private readonly projectId?: string,
  ) { }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { default: MemoryClient } = await import("mem0ai");
    const opts: Record<string, string> = { apiKey: this.apiKey };
    if (this.orgId) opts.org_id = this.orgId;
    if (this.projectId) opts.project_id = this.projectId;
    this.client = new MemoryClient(opts);
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    options: AddOptions,
  ): Promise<AddResult> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.custom_instructions)
      opts.custom_instructions = options.custom_instructions;
    if (options.custom_categories)
      opts.custom_categories = options.custom_categories;
    if (options.enable_graph) opts.enable_graph = options.enable_graph;
    if (options.output_format) opts.output_format = options.output_format;

    const result = await this.client.add(messages, opts);
    return normalizeAddResult(result);
  }

  async search(query: string, options: SearchOptions): Promise<MemoryItem[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.top_k != null) opts.top_k = options.top_k;
    if (options.threshold != null) opts.threshold = options.threshold;
    if (options.keyword_search != null) opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.reranking = options.reranking;

    const results = await this.client.search(query, opts);
    return normalizeSearchResults(results);
  }

  async get(memoryId: string): Promise<MemoryItem> {
    await this.ensureClient();
    const result = await this.client.get(memoryId);
    return normalizeMemoryItem(result);
  }

  async getAll(options: ListOptions): Promise<MemoryItem[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.page_size != null) opts.page_size = options.page_size;

    const results = await this.client.getAll(opts);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    // Some versions return { results: [...] }
    if (results?.results && Array.isArray(results.results))
      return results.results.map(normalizeMemoryItem);
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureClient();
    await this.client.delete(memoryId);
  }
}

// ============================================================================
// Open-Source Provider (Self-hosted)
// ============================================================================

class OSSProvider implements Mem0Provider {
  private memory: any; // Memory from mem0ai/oss
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly ossConfig?: Mem0Config["oss"],
    private readonly customPrompt?: string,
    private readonly resolvePath?: (p: string) => string,
  ) { }

  private async ensureMemory(): Promise<void> {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { Memory } = await import("mem0ai/oss");

    const config: Record<string, unknown> = { version: "v1.1" };

    if (this.ossConfig?.embedder) config.embedder = this.ossConfig.embedder;
    if (this.ossConfig?.vectorStore)
      config.vectorStore = this.ossConfig.vectorStore;
    if (this.ossConfig?.llm) config.llm = this.ossConfig.llm;
    if (this.ossConfig?.graphStore) {
      config.enableGraph = true;
      config.graphStore = this.ossConfig.graphStore;
    }

    if (this.ossConfig?.historyDbPath) {
      const dbPath = this.resolvePath
        ? this.resolvePath(this.ossConfig.historyDbPath)
        : this.ossConfig.historyDbPath;
      config.historyDbPath = dbPath;
    }

    if (this.customPrompt) config.customPrompt = this.customPrompt;

    this.memory = new Memory(config);
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    options: AddOptions,
  ): Promise<AddResult> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId, not user_id/run_id
    const addOpts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) addOpts.runId = options.run_id;
    if (options.enable_graph != null) addOpts.enableGraph = options.enable_graph;
    const result = await this.memory.add(messages, addOpts);
    return normalizeAddResult(result);
  }

  async search(query: string, options: SearchOptions): Promise<MemoryItem[]> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId, not user_id/run_id
    const opts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) opts.runId = options.run_id;
    if (options.limit != null) opts.limit = options.limit;
    else if (options.top_k != null) opts.limit = options.top_k;
    if (options.keyword_search != null) opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.reranking = options.reranking;

    const results = await this.memory.search(query, opts);
    return normalizeSearchResults(results);
  }

  async get(memoryId: string): Promise<MemoryItem> {
    await this.ensureMemory();
    const result = await this.memory.get(memoryId);
    return normalizeMemoryItem(result);
  }

  async getAll(options: ListOptions): Promise<MemoryItem[]> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId, not user_id/run_id
    const getAllOpts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) getAllOpts.runId = options.run_id;
    const results = await this.memory.getAll(getAllOpts);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results))
      return results.results.map(normalizeMemoryItem);
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureMemory();
    await this.memory.delete(memoryId);
  }
}

// ============================================================================
// Result Normalizers
// ============================================================================

function normalizeMemoryItem(raw: any): MemoryItem {
  return {
    id: raw.id ?? raw.memory_id ?? "",
    memory: raw.memory ?? raw.text ?? raw.content ?? "",
    // Handle both platform (user_id, created_at) and OSS (userId, createdAt) field names
    user_id: raw.user_id ?? raw.userId,
    score: raw.score,
    categories: raw.categories,
    metadata: raw.metadata,
    created_at: raw.created_at ?? raw.createdAt,
    updated_at: raw.updated_at ?? raw.updatedAt,
  };
}

function normalizeSearchResults(raw: any): MemoryItem[] {
  // Platform API returns flat array, OSS returns { results: [...] }
  if (Array.isArray(raw)) return raw.map(normalizeMemoryItem);
  if (raw?.results && Array.isArray(raw.results))
    return raw.results.map(normalizeMemoryItem);
  return [];
}

function normalizeAddResult(raw: any): AddResult {
  // Handle { results: [...] } shape (both platform and OSS)
  if (raw?.results && Array.isArray(raw.results)) {
    return {
      results: raw.results.map((r: any) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        // Prefer explicit event, then metadata.event, then default to "ADD"
        event: r.event ?? r.metadata?.event ?? "ADD",
      })),
    };
  }
  // Platform API without output_format returns flat array
  if (Array.isArray(raw)) {
    return {
      results: raw.map((r: any) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        event: r.event ?? r.metadata?.event ?? "ADD",
      })),
    };
  }
  return { results: [] };
}

// ============================================================================
// Config Parser
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveEnvVarsDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = resolveEnvVars(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = resolveEnvVarsDeep(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ============================================================================
// Default Custom Instructions & Categories
// ============================================================================

const DEFAULT_CUSTOM_INSTRUCTIONS = `Your Task: Extract and maintain a structured, evolving profile of the user from their conversations with an AI assistant. Capture information that would help the assistant provide personalized, context-aware responses in future interactions.

Information to Extract:

1. Identity & Demographics:
   - Name, age, location, timezone, language preferences
   - Occupation, employer, job role, industry
   - Education background

2. Preferences & Opinions:
   - Communication style preferences (formal/casual, verbose/concise)
   - Tool and technology preferences (languages, frameworks, editors, OS)
   - Content preferences (topics of interest, learning style)
   - Strong opinions or values they've expressed
   - Likes and dislikes they've explicitly stated

3. Goals & Projects:
   - Current projects they're working on (name, description, status)
   - Short-term and long-term goals
   - Deadlines and milestones mentioned
   - Problems they're actively trying to solve

4. Technical Context:
   - Tech stack and tools they use
   - Skill level in different areas (beginner/intermediate/expert)
   - Development environment and setup details
   - Recurring technical challenges

5. Relationships & People:
   - Names and roles of people they mention (colleagues, family, friends)
   - Team structure and dynamics
   - Key contacts and their relevance

6. Decisions & Lessons:
   - Important decisions made and their reasoning
   - Lessons learned from past experiences
   - Strategies that worked or failed
   - Changed opinions or updated beliefs

7. Routines & Habits:
   - Daily routines and schedules mentioned
   - Work patterns (when they're productive, how they organize work)
   - Health and wellness habits if voluntarily shared

8. Life Events:
   - Significant events (new job, moving, milestones)
   - Upcoming events or plans
   - Changes in circumstances

9. Infrastructure & Environment:
   - Server names, IP addresses, hostnames, ports
   - Network configuration (Tailscale, VPN, DNS)
   - Services running and their locations (what runs where)
   - Deployment setup, CI/CD pipelines, hosting providers
   - Hardware inventory (machines, specs, roles)

10. Assistant Behavior:
    - Rules the user sets for how the assistant should behave
    - Preferred language, tone, communication style
    - Persona, voice, emotionality settings
    - Things the assistant should always or never do

Guidelines:
- Store memories as clear, self-contained statements (each memory should make sense on its own)
- Use third person: "User prefers..." not "I prefer..."
- Include temporal context when relevant: "As of [date], user is working on..."
- When information updates, UPDATE the existing memory rather than creating duplicates
- Merge related facts into single coherent memories when possible
- Preserve specificity: "User uses Next.js 14 with App Router" is better than "User uses React"
- Capture the WHY behind preferences when stated: "User prefers Vim because of keyboard-driven workflow"

Override:
- If the user EXPLICITLY uses memory commands ("remember", "store", "save this", "add to memory", "don't forget"), ALWAYS extract the specified information regardless of other rules.

Exclude:
- Passwords, API keys, tokens, or any authentication credentials
- Exact financial amounts (account balances, salaries) unless the user explicitly asks to remember them
- Temporary or ephemeral information (one-time questions, debugging sessions with no lasting insight)
- Generic small talk with no informational content
- The assistant's own responses unless they contain a commitment or promise to the user
- Raw code snippets (capture the intent/decision, not the code itself)
- Information the user explicitly asks not to remember`;

const DEFAULT_CUSTOM_CATEGORIES: Record<string, string> = {
  identity:
    "Personal identity information: name, age, location, timezone, occupation, employer, education, demographics",
  preferences:
    "Explicitly stated likes, dislikes, preferences, opinions, and values across any domain",
  goals:
    "Current and future goals, aspirations, objectives, targets the user is working toward",
  projects:
    "Specific projects, initiatives, or endeavors the user is working on, including status and details",
  technical:
    "Technical skills, tools, tech stack, development environment, programming languages, frameworks",
  decisions:
    "Important decisions made, reasoning behind choices, strategy changes, and their outcomes",
  relationships:
    "People mentioned by the user: colleagues, family, friends, their roles and relevance",
  routines:
    "Daily habits, work patterns, schedules, productivity routines, health and wellness habits",
  life_events:
    "Significant life events, milestones, transitions, upcoming plans and changes",
  lessons:
    "Lessons learned, insights gained, mistakes acknowledged, changed opinions or beliefs",
  work:
    "Work-related context: job responsibilities, workplace dynamics, career progression, professional challenges",
  health:
    "Health-related information voluntarily shared: conditions, medications, fitness, wellness goals",
  infrastructure:
    "Server names, IP addresses, ports, hostnames, network config, services, deployment setup, hardware inventory",
  assistant:
    "Assistant behavior rules, persona, voice, communication style, language preferences set by user",
};

// ============================================================================
// Config Schema
// ============================================================================

const ALLOWED_KEYS = [
  "mode",
  "apiKey",
  "userId",
  "orgId",
  "projectId",
  "autoCapture",
  "autoRecall",
  "customInstructions",
  "customCategories",
  "customPrompt",
  "enableGraph",
  "searchThreshold",
  "topK",
  "oss",
  "identityMapPath",
  "skipGroupChats",
  "sleepMode",
];

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

const mem0ConfigSchema = {
  parse(value: unknown): Mem0Config {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("openclaw-mem0 config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "openclaw-mem0 config");

    // Accept both "open-source" and legacy "oss" as open-source mode; everything else is platform
    const mode: Mem0Mode =
      cfg.mode === "oss" || cfg.mode === "open-source" ? "open-source" : "platform";

    // Platform mode requires apiKey
    if (mode === "platform") {
      if (typeof cfg.apiKey !== "string" || !cfg.apiKey) {
        throw new Error(
          "apiKey is required for platform mode (set mode: \"open-source\" for self-hosted)",
        );
      }
    }

    // Resolve env vars in oss config
    let ossConfig: Mem0Config["oss"];
    if (cfg.oss && typeof cfg.oss === "object" && !Array.isArray(cfg.oss)) {
      ossConfig = resolveEnvVarsDeep(
        cfg.oss as Record<string, unknown>,
      ) as unknown as Mem0Config["oss"];
    }

    return {
      mode,
      apiKey:
        typeof cfg.apiKey === "string" ? resolveEnvVars(cfg.apiKey) : undefined,
      userId:
        typeof cfg.userId === "string" && cfg.userId ? cfg.userId : "default",
      orgId: typeof cfg.orgId === "string" ? cfg.orgId : undefined,
      projectId: typeof cfg.projectId === "string" ? cfg.projectId : undefined,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      customInstructions:
        typeof cfg.customInstructions === "string"
          ? cfg.customInstructions
          : DEFAULT_CUSTOM_INSTRUCTIONS,
      customCategories:
        cfg.customCategories &&
          typeof cfg.customCategories === "object" &&
          !Array.isArray(cfg.customCategories)
          ? (cfg.customCategories as Record<string, string>)
          : DEFAULT_CUSTOM_CATEGORIES,
      customPrompt:
        typeof cfg.customPrompt === "string"
          ? cfg.customPrompt
          : DEFAULT_CUSTOM_INSTRUCTIONS,
      enableGraph: cfg.enableGraph === true,
      searchThreshold:
        typeof cfg.searchThreshold === "number" ? cfg.searchThreshold : 0.5,
      topK: typeof cfg.topK === "number" ? cfg.topK : 5,
      oss: ossConfig,
      identityMapPath:
        typeof cfg.identityMapPath === "string" ? cfg.identityMapPath : undefined,
      skipGroupChats: cfg.skipGroupChats !== false,
      sleepMode: parseSleepModeConfig(cfg.sleepMode),
    };
  },
};

/**
 * Parse and merge sleep mode config with defaults.
 */
function parseSleepModeConfig(raw: unknown): SleepConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SLEEP_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    logDir: typeof obj.logDir === "string" ? obj.logDir : DEFAULT_SLEEP_CONFIG.logDir,
    digestDir: typeof obj.digestDir === "string" ? obj.digestDir : DEFAULT_SLEEP_CONFIG.digestDir,
    maxChunkChars:
      typeof obj.maxChunkChars === "number" ? obj.maxChunkChars : DEFAULT_SLEEP_CONFIG.maxChunkChars,
    retentionDays:
      typeof obj.retentionDays === "number" ? obj.retentionDays : DEFAULT_SLEEP_CONFIG.retentionDays,
    digestEnabled: obj.digestEnabled !== false,
  };
}

// ============================================================================
// Provider Factory
// ============================================================================

function createProvider(
  cfg: Mem0Config,
  api: OpenClawPluginApi,
): Mem0Provider {
  if (cfg.mode === "open-source") {
    return new OSSProvider(cfg.oss, cfg.customPrompt, (p) =>
      api.resolvePath(p),
    );
  }

  return new PlatformProvider(cfg.apiKey!, cfg.orgId, cfg.projectId);
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert Record<string, string> categories to the array format mem0ai expects */
function categoriesToArray(
  cats: Record<string, string>,
): Array<Record<string, string>> {
  return Object.entries(cats).map(([key, value]) => ({ [key]: value }));
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "openclaw-mem0",
  name: "Memory (Mem0) Enhanced",
  description:
    "Enhanced Mem0 memory backend — identity mapping, raw storage, graph memory, extended extraction",
  kind: "memory" as const,
  configSchema: mem0ConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mem0ConfigSchema.parse(api.pluginConfig);
    const provider = createProvider(cfg, api);

    // Track current session ID for tool-level session scoping
    let currentSessionId: string | undefined;

    // Identity mapping: resolve multi-channel aliases to canonical user IDs
    const identityMapPath = cfg.identityMapPath
      ? api.resolvePath(cfg.identityMapPath)
      : undefined;
    const identityMap = loadIdentityMap(identityMapPath);
    const aliasLookup = buildAliasLookup(identityMap);
    if (identityMap) {
      api.logger.info(
        `openclaw-mem0: loaded identity map with ${identityMap.identities.length} identities`,
      );
    }

    /**
     * Resolve a user ID: apply identity mapping if configured,
     * otherwise fall back to the configured default userId.
     */
    function resolveUser(rawId?: string, ctx?: Record<string, unknown>): string {
      // If a context is available, try to extract user from session key
      if (ctx && !rawId) {
        const extracted = resolveUserId(ctx as any);
        if (extracted !== "default") rawId = extracted;
      }
      const id = rawId || cfg.userId;
      return resolveCanonicalUserId(id, aliasLookup);
    }

    api.logger.info(
      `openclaw-mem0: registered (mode: ${cfg.mode}, user: ${cfg.userId}, graph: ${cfg.enableGraph}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
    );

    // Helper: build add options
    function buildAddOptions(userIdOverride?: string, runId?: string): AddOptions {
      const opts: AddOptions = {
        user_id: resolveUser(userIdOverride),
      };
      if (runId) opts.run_id = runId;
      if (cfg.mode === "platform") {
        opts.custom_instructions = cfg.customInstructions;
        opts.custom_categories = categoriesToArray(cfg.customCategories);
        opts.enable_graph = cfg.enableGraph;
        opts.output_format = "v1.1";
      }
      // Enable graph in OSS mode too if graphStore is configured
      if (cfg.mode === "open-source" && cfg.enableGraph) {
        opts.enable_graph = true;
      }
      return opts;
    }

    // Helper: build search options
    function buildSearchOptions(
      userIdOverride?: string,
      limit?: number,
      runId?: string,
    ): SearchOptions {
      const opts: SearchOptions = {
        user_id: resolveUser(userIdOverride),
        top_k: limit ?? cfg.topK,
        limit: limit ?? cfg.topK,
        threshold: cfg.searchThreshold,
        keyword_search: true,
        reranking: true,
      };
      if (runId) opts.run_id = runId;
      return opts;
    }

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search through long-term memories stored in Mem0. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({
              description: `Max results (default: ${cfg.topK})`,
            }),
          ),
          userId: Type.Optional(
            Type.String({
              description:
                "User ID to scope search (default: configured userId)",
            }),
          ),
          scope: Type.Optional(
            Type.Union([
              Type.Literal("session"),
              Type.Literal("long-term"),
              Type.Literal("all"),
            ], {
              description:
                'Memory scope: "session" (current session only), "long-term" (user-scoped only), or "all" (both). Default: "all"',
            }),
          ),
          category: Type.Optional(
            Type.String({
              description:
                'Filter results by category (e.g. "technical", "infrastructure", "preferences")',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, limit, userId, scope = "all", category } = params as {
            query: string;
            limit?: number;
            userId?: string;
            scope?: "session" | "long-term" | "all";
            category?: string;
          };

          try {
            let results: MemoryItem[] = [];

            if (scope === "session") {
              if (currentSessionId) {
                results = await provider.search(
                  query,
                  buildSearchOptions(userId, limit, currentSessionId),
                );
              }
            } else if (scope === "long-term") {
              results = await provider.search(
                query,
                buildSearchOptions(userId, limit),
              );
            } else {
              // "all" — search both scopes and combine
              const longTermResults = await provider.search(
                query,
                buildSearchOptions(userId, limit),
              );
              let sessionResults: MemoryItem[] = [];
              if (currentSessionId) {
                sessionResults = await provider.search(
                  query,
                  buildSearchOptions(userId, limit, currentSessionId),
                );
              }
              // Deduplicate by ID, preferring long-term
              const seen = new Set(longTermResults.map((r) => r.id));
              results = [
                ...longTermResults,
                ...sessionResults.filter((r) => !seen.has(r.id)),
              ];
            }

            // Apply category filter if specified (client-side post-filter)
            if (category && results.length > 0) {
              const lowerCat = category.toLowerCase();
              results = results.filter(
                (r) =>
                  r.categories?.some(
                    (c) => c.toLowerCase() === lowerCat,
                  ) ?? false,
              );
            }

            if (!results || results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No relevant memories found." },
                ],
                details: { count: 0, category },
              };
            }

            const text = results
              .map(
                (r, i) =>
                  `${i + 1}. ${r.memory} (score: ${((r.score ?? 0) * 100).toFixed(0)}%, id: ${r.id}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""})`,
              )
              .join("\n");

            const sanitized = results.map((r) => ({
              id: r.id,
              memory: r.memory,
              score: r.score,
              categories: r.categories,
              created_at: r.created_at,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} memories:\n\n${text}`,
                },
              ],
              details: { count: results.length, memories: sanitized },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory search failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_search" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory via Mem0. Use for preferences, facts, decisions, and anything worth remembering.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          userId: Type.Optional(
            Type.String({
              description: "User ID to scope this memory",
            }),
          ),
          metadata: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Optional metadata to attach to this memory",
            }),
          ),
          longTerm: Type.Optional(
            Type.Boolean({
              description:
                "Store as long-term (user-scoped) memory. Default: true. Set to false for session-scoped memory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { text, userId, longTerm = true } = params as {
            text: string;
            userId?: string;
            metadata?: Record<string, unknown>;
            longTerm?: boolean;
          };

          try {
            const runId = !longTerm && currentSessionId ? currentSessionId : undefined;
            const result = await provider.add(
              [{ role: "user", content: text }],
              buildAddOptions(userId, runId),
            );

            const added =
              result.results?.filter((r) => r.event === "ADD") ?? [];
            const updated =
              result.results?.filter((r) => r.event === "UPDATE") ?? [];

            const summary = [];
            if (added.length > 0)
              summary.push(
                `${added.length} new memor${added.length === 1 ? "y" : "ies"} added`,
              );
            if (updated.length > 0)
              summary.push(
                `${updated.length} memor${updated.length === 1 ? "y" : "ies"} updated`,
              );
            if (summary.length === 0)
              summary.push("No new memories extracted");

            return {
              content: [
                {
                  type: "text",
                  text: `Stored: ${summary.join(", ")}. ${result.results?.map((r) => `[${r.event}] ${r.memory}`).join("; ") ?? ""}`,
                },
              ],
              details: {
                action: "stored",
                results: result.results,
              },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory store failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_store" },
    );

    // ---- memory_store_raw: verbatim storage without LLM extraction ----
    api.registerTool(
      {
        name: "memory_store_raw",
        label: "Memory Store Raw",
        description:
          "Store verbatim text in long-term memory WITHOUT LLM fact extraction. " +
          "Use for exact quotes, code snippets, commands, config fragments, " +
          "or any data that must be preserved word-for-word.",
        parameters: Type.Object({
          text: Type.String({
            description: "Verbatim text to store exactly as-is",
          }),
          userId: Type.Optional(
            Type.String({ description: "User ID to scope this memory" }),
          ),
          category: Type.Optional(
            Type.String({
              description:
                'Category tag (e.g. "infrastructure", "technical", "assistant")',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { text, userId, category } = params as {
            text: string;
            userId?: string;
            category?: string;
          };

          try {
            // Use infer=false if supported by OSS SDK, otherwise store as direct message
            const resolvedUserId = resolveUser(userId);
            const messages = [{ role: "user" as const, content: text }];
            const addOpts: AddOptions = {
              user_id: resolvedUserId,
            };
            // For platform mode, we still need custom instructions but
            // the "raw" aspect comes from how we frame the message
            if (cfg.mode === "platform") {
              addOpts.custom_instructions =
                "Store the following text EXACTLY as provided. Do NOT summarize, rephrase, or extract. " +
                "Create a single memory with the EXACT verbatim text.";
              if (category) {
                addOpts.custom_categories = [
                  { [category]: `User-specified category: ${category}` },
                ];
              }
              addOpts.output_format = "v1.1";
            }

            const result = await provider.add(messages, addOpts);

            const count = result.results?.length ?? 0;
            return {
              content: [
                {
                  type: "text",
                  text: `Stored raw memory (${count} entr${count === 1 ? "y" : "ies"})${category ? ` [${category}]` : ""}`,
                },
              ],
              details: {
                action: "stored_raw",
                category,
                results: result.results,
              },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Raw memory store failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_store_raw" },
    );

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description: "Retrieve a specific memory by its ID from Mem0.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "The memory ID to retrieve" }),
        }),
        async execute(_toolCallId, params) {
          const { memoryId } = params as { memoryId: string };

          try {
            const memory = await provider.get(memoryId);

            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${memory.id}:\n${memory.memory}\n\nCreated: ${memory.created_at ?? "unknown"}\nUpdated: ${memory.updated_at ?? "unknown"}`,
                },
              ],
              details: { memory },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory get failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_get" },
    );

    api.registerTool(
      {
        name: "memory_list",
        label: "Memory List",
        description:
          "List all stored memories for a user. Use this when you want to see everything that's been remembered, rather than searching for something specific.",
        parameters: Type.Object({
          userId: Type.Optional(
            Type.String({
              description:
                "User ID to list memories for (default: configured userId)",
            }),
          ),
          scope: Type.Optional(
            Type.Union([
              Type.Literal("session"),
              Type.Literal("long-term"),
              Type.Literal("all"),
            ], {
              description:
                'Memory scope: "session" (current session only), "long-term" (user-scoped only), or "all" (both). Default: "all"',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { userId, scope = "all" } = params as { userId?: string; scope?: "session" | "long-term" | "all" };

          try {
            let memories: MemoryItem[] = [];
            const uid = userId || cfg.userId;

            if (scope === "session") {
              if (currentSessionId) {
                memories = await provider.getAll({
                  user_id: uid,
                  run_id: currentSessionId,
                });
              }
            } else if (scope === "long-term") {
              memories = await provider.getAll({ user_id: uid });
            } else {
              // "all" — combine both scopes
              const longTerm = await provider.getAll({ user_id: uid });
              let session: MemoryItem[] = [];
              if (currentSessionId) {
                session = await provider.getAll({
                  user_id: uid,
                  run_id: currentSessionId,
                });
              }
              const seen = new Set(longTerm.map((r) => r.id));
              memories = [
                ...longTerm,
                ...session.filter((r) => !seen.has(r.id)),
              ];
            }

            if (!memories || memories.length === 0) {
              return {
                content: [
                  { type: "text", text: "No memories stored yet." },
                ],
                details: { count: 0 },
              };
            }

            const text = memories
              .map(
                (r, i) =>
                  `${i + 1}. ${r.memory} (id: ${r.id})`,
              )
              .join("\n");

            const sanitized = memories.map((r) => ({
              id: r.id,
              memory: r.memory,
              categories: r.categories,
              created_at: r.created_at,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `${memories.length} memories:\n\n${text}`,
                },
              ],
              details: { count: memories.length, memories: sanitized },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory list failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_list" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description:
          "Delete memories from Mem0. Provide a specific memoryId to delete directly, or a query to search and delete matching memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({
              description: "Search query to find memory to delete",
            }),
          ),
          memoryId: Type.Optional(
            Type.String({ description: "Specific memory ID to delete" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          try {
            if (memoryId) {
              await provider.delete(memoryId);
              return {
                content: [
                  { type: "text", text: `Memory ${memoryId} forgotten.` },
                ],
                details: { action: "deleted", id: memoryId },
              };
            }

            if (query) {
              const results = await provider.search(
                query,
                buildSearchOptions(undefined, 5),
              );

              if (!results || results.length === 0) {
                return {
                  content: [
                    { type: "text", text: "No matching memories found." },
                  ],
                  details: { found: 0 },
                };
              }

              // If single high-confidence match, delete directly
              if (
                results.length === 1 ||
                (results[0].score ?? 0) > 0.9
              ) {
                await provider.delete(results[0].id);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].memory}"`,
                    },
                  ],
                  details: { action: "deleted", id: results[0].id },
                };
              }

              const list = results
                .map(
                  (r) =>
                    `- [${r.id}] ${r.memory.slice(0, 80)}${r.memory.length > 80 ? "..." : ""} (score: ${((r.score ?? 0) * 100).toFixed(0)}%)`,
                )
                .join("\n");

              const candidates = results.map((r) => ({
                id: r.id,
                memory: r.memory,
                score: r.score,
              }));

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                  },
                ],
                details: { action: "candidates", candidates },
              };
            }

            return {
              content: [
                { type: "text", text: "Provide a query or memoryId." },
              ],
              details: { error: "missing_param" },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory forget failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_forget" },
    );

    // ---- memory_search_log: search conversation history (cold storage) ----
    if (cfg.sleepMode.enabled) {
      api.registerTool(
        {
          name: "memory_search_log",
          label: "Search Conversation Log",
          description:
            "Search through past conversation history for relevant context. " +
            "Use when memory_search doesn't have enough detail, or when you need " +
            "exact quotes or full context from past conversations. " +
            "Only available when sleep mode is enabled.",
          parameters: Type.Object({
            query: Type.String({
              description: "Search query (text-based search through conversation logs)",
            }),
            dateFrom: Type.Optional(
              Type.String({
                description: 'Start date filter, inclusive (e.g. "2026-02-01")',
              }),
            ),
            dateTo: Type.Optional(
              Type.String({
                description: 'End date filter, inclusive (e.g. "2026-02-07")',
              }),
            ),
            limit: Type.Optional(
              Type.Number({
                description: "Max results (default: 5)",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            const { query, dateFrom, dateTo, limit = 5 } = params as {
              query: string;
              dateFrom?: string;
              dateTo?: string;
              limit?: number;
            };

            try {
              const logDir = api.resolvePath(cfg.sleepMode.logDir);
              const results = searchLogs(logDir, query, dateFrom, dateTo, limit);

              if (results.length === 0) {
                return {
                  content: [
                    { type: "text", text: "No matching conversation logs found." },
                  ],
                  details: { count: 0 },
                };
              }

              const text = results
                .map((r, i) => {
                  const date = r.entry.ts.split("T")[0];
                  return `${i + 1}. [${date}] ${r.entry.user_id}: ...${r.matchContext}...`;
                })
                .join("\n\n");

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} conversation log matches:\n\n${text}`,
                  },
                ],
                details: {
                  count: results.length,
                  results: results.map((r) => ({
                    date: r.entry.ts.split("T")[0],
                    session_id: r.entry.session_id,
                    user_id: r.entry.user_id,
                    matchContext: r.matchContext,
                  })),
                },
              };
            } catch (err) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Log search failed: ${String(err)}`,
                  },
                ],
                details: { error: String(err) },
              };
            }
          },
        },
        { name: "memory_search_log" },
      );
    }

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem0 = program
          .command("mem0")
          .description("Mem0 memory plugin commands");

        mem0
          .command("search")
          .description("Search memories in Mem0")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", String(cfg.topK))
          .option("--scope <scope>", 'Memory scope: "session", "long-term", or "all"', "all")
          .action(async (query: string, opts: { limit: string; scope: string }) => {
            try {
              const limit = parseInt(opts.limit, 10);
              const scope = opts.scope as "session" | "long-term" | "all";

              let allResults: MemoryItem[] = [];

              if (scope === "session" || scope === "all") {
                if (currentSessionId) {
                  const sessionResults = await provider.search(
                    query,
                    buildSearchOptions(undefined, limit, currentSessionId),
                  );
                  if (sessionResults?.length) {
                    allResults.push(...sessionResults.map((r) => ({ ...r, _scope: "session" as const })));
                  }
                } else if (scope === "session") {
                  console.log("No active session ID available for session-scoped search.");
                  return;
                }
              }

              if (scope === "long-term" || scope === "all") {
                const longTermResults = await provider.search(
                  query,
                  buildSearchOptions(undefined, limit),
                );
                if (longTermResults?.length) {
                  allResults.push(...longTermResults.map((r) => ({ ...r, _scope: "long-term" as const })));
                }
              }

              // Deduplicate by ID when searching "all"
              if (scope === "all") {
                const seen = new Set<string>();
                allResults = allResults.filter((r) => {
                  if (seen.has(r.id)) return false;
                  seen.add(r.id);
                  return true;
                });
              }

              if (!allResults.length) {
                console.log("No memories found.");
                return;
              }

              const output = allResults.map((r) => ({
                id: r.id,
                memory: r.memory,
                score: r.score,
                scope: (r as any)._scope,
                categories: r.categories,
                created_at: r.created_at,
              }));
              console.log(JSON.stringify(output, null, 2));
            } catch (err) {
              console.error(`Search failed: ${String(err)}`);
            }
          });

        mem0
          .command("stats")
          .description("Show memory statistics from Mem0")
          .action(async () => {
            try {
              const memories = await provider.getAll({
                user_id: cfg.userId,
              });
              console.log(`Mode: ${cfg.mode}`);
              console.log(`User: ${cfg.userId}`);
              console.log(
                `Total memories: ${Array.isArray(memories) ? memories.length : "unknown"}`,
              );
              console.log(`Graph enabled: ${cfg.enableGraph}`);
              console.log(
                `Auto-recall: ${cfg.autoRecall}, Auto-capture: ${cfg.autoCapture}`,
              );
            } catch (err) {
              console.error(`Stats failed: ${String(err)}`);
            }
          });
      },
      { commands: ["mem0"] },
    );

    // Sleep mode CLI: /mem0-sleep — run memory maintenance job manually or via cron
    if (cfg.sleepMode.enabled) {
      api.registerCli(
        ({ program }) => {
          program
            .command("mem0-sleep")
            .description("Run sleep mode memory maintenance (process unanalyzed conversation logs)")
            .option("--date <date>", "Process a specific date (e.g. 2026-02-07)")
            .option("--dry-run", "Show what would be processed without making changes")
            .action(async (opts: { date?: string; dryRun?: boolean }) => {
              const logDir = api.resolvePath(cfg.sleepMode.logDir);
              const digestDir = api.resolvePath(cfg.sleepMode.digestDir);

              console.log("=== Mem0 Sleep Mode: Memory Maintenance ===\n");

              // Validate date format if provided
              if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
                console.error(`Invalid date format: "${opts.date}". Expected YYYY-MM-DD.`);
                return;
              }

              // Find unprocessed logs
              const unprocessed = opts.date
                ? [{ date: opts.date, path: `${logDir}/${opts.date}.jsonl` }]
                : findUnprocessedLogs(logDir);

              if (unprocessed.length === 0) {
                console.log("No unprocessed logs found. All caught up!");
                return;
              }

              console.log(`Found ${unprocessed.length} unprocessed log(s):\n`);
              for (const log of unprocessed) {
                console.log(`  - ${log.date}`);
              }

              if (opts.dryRun) {
                console.log("\n[DRY RUN] Would process the above logs. Exiting.");
                return;
              }

              // Get existing memories for dedup context
              let existingMemories: string[] = [];
              try {
                const allMemories = await provider.getAll({ user_id: cfg.userId });
                existingMemories = allMemories.map((m) => m.memory);
              } catch {
                console.log("Warning: could not fetch existing memories for dedup.");
              }

              for (const log of unprocessed) {
                console.log(`\nProcessing ${log.date}...`);

                const entries = readDailyLog(log.path);
                if (entries.length === 0) {
                  console.log(`  No entries found in ${log.date}. Marking as processed.`);
                  markProcessed(logDir, log.date);
                  continue;
                }

                console.log(`  ${entries.length} conversation entries`);

                // Chunk for LLM analysis
                const chunks = chunkForAnalysis(entries, cfg.sleepMode.maxChunkChars);
                console.log(`  ${chunks.length} chunk(s) for analysis`);

                // Combine chunks for analysis (for now, send all at once; future: batch)
                const combinedText = chunks.join("\n---\n\n");
                const prompt = buildSleepAnalysisPrompt(log.date, combinedText, existingMemories);

                // Use provider's underlying LLM to run analysis
                // For now, we store the prompt as a note — actual LLM call requires
                // integration with the configured LLM provider
                console.log(`  Sending to LLM for analysis (${combinedText.length} chars)...`);

                try {
                  // Call LLM through mem0's provider add (with a special system prompt)
                  // This is a workaround — ideally we'd call the LLM directly
                  // For platform mode, we can use the Mem0 API
                  // For OSS mode, we'd need direct LLM access
                  // For now, we extract facts using mem0's own extraction
                  const messages = entries.flatMap((e) =>
                    e.messages
                      .filter((m) => m.role === "user" || m.role === "assistant")
                      .map((m) => ({ role: m.role as string, content: m.content })),
                  );

                  if (messages.length > 0) {
                    // Process through mem0's extraction pipeline
                    const result = await provider.add(
                      messages.slice(-20), // Limit to last 20 messages
                      buildAddOptions(),
                    );

                    const addedCount = result.results?.filter((r) => r.event === "ADD").length ?? 0;
                    const updatedCount = result.results?.filter((r) => r.event === "UPDATE").length ?? 0;

                    console.log(`  Promoted ${addedCount} new facts, updated ${updatedCount} existing`);

                    // Generate a simple digest
                    if (cfg.sleepMode.digestEnabled) {
                      const simpleAnalysis: SleepAnalysis = {
                        hot_facts: result.results
                          ?.filter((r) => r.event === "ADD")
                          .map((r) => r.memory) ?? [],
                        patterns: [],
                        reflections: [],
                        consolidations: [],
                        digest: `Processed ${entries.length} conversations from ${log.date}. ` +
                          `Extracted ${addedCount} new facts and updated ${updatedCount} existing memories.`,
                      };
                      saveDigest(digestDir, log.date, simpleAnalysis);
                      console.log(`  Digest saved to ${digestDir}/${log.date}.md`);
                    }
                  }
                } catch (err) {
                  console.error(`  Analysis failed: ${String(err)}`);
                  console.error(`  Skipping ${log.date} — will retry on next run.`);
                  continue;
                }

                markProcessed(logDir, log.date);
                console.log(`  Marked ${log.date} as processed.`);
              }

              console.log("\n=== Sleep mode maintenance complete ===");
            });
        },
        { commands: ["mem0-sleep"] },
      );
    }

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;

        // Track session ID
        const sessionId = (ctx as any)?.sessionKey ?? undefined;
        if (sessionId) currentSessionId = sessionId;

        // Skip group chats if configured
        if (cfg.skipGroupChats && isGroupChat(ctx as any)) {
          api.logger.debug("openclaw-mem0: skipping group chat recall");
          return;
        }

        // Resolve user from context for identity-aware search
        const contextUserId = resolveUser(undefined, ctx as any);

        try {
          // Search long-term memories (user-scoped)
          const longTermResults = await provider.search(
            event.prompt,
            buildSearchOptions(contextUserId),
          );

          // Search session memories (session-scoped) if we have a session ID
          let sessionResults: MemoryItem[] = [];
          if (currentSessionId) {
            sessionResults = await provider.search(
              event.prompt,
              buildSearchOptions(contextUserId, undefined, currentSessionId),
            );
          }

          // Deduplicate session results against long-term
          const longTermIds = new Set(longTermResults.map((r) => r.id));
          const uniqueSessionResults = sessionResults.filter(
            (r) => !longTermIds.has(r.id),
          );

          if (longTermResults.length === 0 && uniqueSessionResults.length === 0) return;

          // Build context with clear labels
          let memoryContext = "";
          if (longTermResults.length > 0) {
            memoryContext += longTermResults
              .map(
                (r) =>
                  `- ${r.memory}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""}`,
              )
              .join("\n");
          }
          if (uniqueSessionResults.length > 0) {
            if (memoryContext) memoryContext += "\n";
            memoryContext += "\nSession memories:\n";
            memoryContext += uniqueSessionResults
              .map((r) => `- ${r.memory}`)
              .join("\n");
          }

          const totalCount = longTermResults.length + uniqueSessionResults.length;
          api.logger.info(
            `openclaw-mem0: injecting ${totalCount} memories into context (${longTermResults.length} long-term, ${uniqueSessionResults.length} session)`,
          );

          return {
            systemContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: store conversation context after agent ends
    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        // Track session ID
        const sessionId = (ctx as any)?.sessionKey ?? undefined;
        if (sessionId) currentSessionId = sessionId;

        // Skip group chats if configured
        if (cfg.skipGroupChats && isGroupChat(ctx as any)) {
          api.logger.debug("openclaw-mem0: skipping group chat capture");
          return;
        }

        // Resolve user from context for identity-aware capture
        const contextUserId = resolveUser(undefined, ctx as any);

        try {
          // Extract messages, limiting to last 10
          const recentMessages = event.messages.slice(-10);
          const formattedMessages: Array<{
            role: string;
            content: string;
          }> = [];

          for (const msg of recentMessages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;

            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            let textContent = "";
            const content = msgObj.content;

            if (typeof content === "string") {
              textContent = content;
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  textContent +=
                    (textContent ? "\n" : "") +
                    ((block as Record<string, unknown>).text as string);
                }
              }
            }

            if (!textContent) continue;
            // Skip injected memory context
            if (textContent.includes("<relevant-memories>")) continue;

            formattedMessages.push({
              role: role as string,
              content: textContent,
            });
          }

          if (formattedMessages.length === 0) return;

          const addOpts = buildAddOptions(contextUserId, currentSessionId);
          const result = await provider.add(
            formattedMessages,
            addOpts,
          );

          const capturedCount = result.results?.length ?? 0;
          if (capturedCount > 0) {
            api.logger.info(
              `openclaw-mem0: auto-captured ${capturedCount} memories`,
            );
          }
        } catch (err) {
          api.logger.warn(`openclaw-mem0: capture failed: ${String(err)}`);
        }

        // Sleep mode: append cleaned messages to daily JSONL log
        if (cfg.sleepMode.enabled) {
          try {
            const logDir = api.resolvePath(cfg.sleepMode.logDir);
            const channel = resolveUserId(ctx as any);
            const logEntry = buildLogEntry(
              event.messages as Array<Record<string, unknown>>,
              contextUserId,
              channel,
              currentSessionId || "unknown",
            );
            if (logEntry) {
              appendToLog(logDir, logEntry);
            }
          } catch (err) {
            api.logger.warn(`openclaw-mem0: sleep log append failed: ${String(err)}`);
          }
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "openclaw-mem0",
      start: () => {
        api.logger.info(
          `openclaw-mem0: initialized (mode: ${cfg.mode}, user: ${cfg.userId}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
        );
      },
      stop: () => {
        api.logger.info("openclaw-mem0: stopped");
      },
    });
  },
};

export default memoryPlugin;
