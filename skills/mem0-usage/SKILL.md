---
name: mem0-usage
description: How to use the OpenClaw Mem0 v2 enhanced memory plugin
version: 2.0.0
metadata:
  openclaw:
    requires:
      tools: ["memory_search", "memory_store", "memory_store_raw"]
---

# Using OpenClaw Mem0 v2 Memory

## Available Tools

### memory_search
Search memories by semantic similarity.
- `query` (required): What to search for
- `limit`: Max results (default: 5)
- `userId`: Scope to specific user
- `scope`: "session", "long-term", or "all" (default: "all")
- `category`: Filter by category (e.g. "technical", "infrastructure", "preferences")

### memory_store
Store information with LLM fact extraction.
- `text` (required): Information to remember
- `userId`: User scope
- `longTerm`: true for user-scoped, false for session-scoped

### memory_store_raw
Store verbatim text WITHOUT LLM extraction.
Use for exact quotes, commands, configs, code.
- `text` (required): Exact text to store
- `userId`: User scope
- `category`: Tag (e.g. "infrastructure", "technical")

### memory_get
Retrieve a specific memory by ID.
- `memoryId` (required): Memory ID

### memory_list
List all memories for a user.
- `userId`: User to list memories for
- `scope`: "session", "long-term", or "all"

### memory_forget
Delete a specific memory.
- `memoryId` (required): Memory ID to delete

### memory_search_log (sleep mode only)
Search conversation history logs.
- `query` (required): Search text
- `dateFrom`: Start date filter
- `dateTo`: End date filter
- `limit`: Max results

## Categories

Memories are auto-categorized into:
- **identity**: Name, age, location, occupation
- **preferences**: Likes, dislikes, opinions
- **goals**: Objectives, aspirations
- **projects**: Active projects, status
- **technical**: Tech stack, tools, dev environment
- **decisions**: Important decisions, reasoning
- **infrastructure**: Servers, IPs, services, ports, network config
- **assistant**: Behavior rules, persona, communication style
- **relationships**: People mentioned, their roles
- **routines**: Habits, schedules
- **life_events**: Milestones, changes
- **lessons**: Insights, mistakes
- **work**: Job context, career
- **health**: Wellness info

## Best Practices

1. **Auto-capture handles most storage** — don't manually store what's already in conversation
2. **Use memory_store_raw** for exact data: IP addresses, commands, configs
3. **Use category filter** in memory_search to narrow results
4. **"Remember" keyword** — when user says "remember X", the extraction prompt prioritizes it
5. **Sleep mode** processes old conversations nightly — no need to re-extract from today's chat

## CLI Commands

```bash
openclaw mem0 search "query"          # Search memories
openclaw mem0 stats                   # Memory statistics
openclaw mem0-sleep                   # Run sleep maintenance manually
openclaw mem0-sleep --dry-run         # Preview what would be processed
```
