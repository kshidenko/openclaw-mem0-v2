/**
 * Migration script: v1 (ChromaDB + Python) -> v2 (mem0ai Node SDK).
 *
 * Exports all memories from the v1 plugin's ChromaDB database
 * and re-imports them into the v2 plugin via the mem0ai SDK.
 *
 * Usage:
 *   npx tsx scripts/migrate-v1-to-v2.ts [options]
 *
 * Options:
 *   --v1-db <path>       Path to v1 ChromaDB data dir (default: ~/.openclaw/extensions/mem0-memory/memory/data)
 *   --dry-run             Show what would be migrated without making changes
 *   --user-id <id>       Default user ID for migrated memories (default: default)
 *
 * Notes:
 *   - Requires the v2 plugin to be installed and configured
 *   - Requires Python 3.x with chromadb package for v1 export
 *   - Creates a backup JSON file before migration
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

interface V1Memory {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  errors: string[];
}

// ============================================================================
// V1 Export (via Python + ChromaDB)
// ============================================================================

/**
 * Export memories from v1 ChromaDB collection.
 *
 * Uses a temporary Python script since ChromaDB is a Python library.
 *
 * Args:
 *     dbPath: Path to v1 ChromaDB data directory.
 *
 * Returns:
 *     Array of exported memory objects.
 */
function exportV1Memories(dbPath: string): V1Memory[] {
  const pythonScript = `
import json
import sys
try:
    import chromadb
except ImportError:
    print(json.dumps({"error": "chromadb not installed. Run: pip install chromadb"}))
    sys.exit(1)

db_path = "${dbPath}"
try:
    client = chromadb.PersistentClient(path=db_path)
    collections = client.list_collections()
    
    all_memories = []
    for col in collections:
        results = col.get(include=["documents", "metadatas"])
        for i, doc_id in enumerate(results["ids"]):
            memory = {
                "id": doc_id,
                "text": results["documents"][i] if results["documents"] else "",
                "metadata": results["metadatas"][i] if results["metadatas"] else {},
                "collection": col.name
            }
            all_memories.append(memory)
    
    print(json.dumps({"memories": all_memories, "count": len(all_memories)}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

  try {
    const result = execSync(`python3 -c '${pythonScript.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    const parsed = JSON.parse(result.trim());
    if (parsed.error) {
      throw new Error(parsed.error);
    }

    return parsed.memories as V1Memory[];
  } catch (err) {
    console.error(`Failed to export v1 memories: ${String(err)}`);
    return [];
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let v1DbPath = join(
    process.env.HOME || "~",
    ".openclaw/extensions/mem0-memory/memory/data",
  );
  let dryRun = false;
  let userId = "default";

  // Parse args
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--v1-db":
        v1DbPath = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--user-id":
        userId = args[++i];
        break;
      case "--help":
      case "-h":
        console.log("Usage: npx tsx scripts/migrate-v1-to-v2.ts [options]");
        console.log("");
        console.log("Options:");
        console.log("  --v1-db <path>   Path to v1 ChromaDB data dir");
        console.log("  --dry-run        Show what would be migrated");
        console.log("  --user-id <id>   Default user ID (default: default)");
        process.exit(0);
    }
  }

  console.log("=== Mem0 v1 -> v2 Migration ===\n");
  console.log(`V1 DB path: ${v1DbPath}`);
  console.log(`User ID:    ${userId}`);
  console.log(`Dry run:    ${dryRun}\n`);

  // Check v1 DB exists
  if (!existsSync(v1DbPath)) {
    console.error(`V1 database not found at: ${v1DbPath}`);
    console.error("Use --v1-db to specify the correct path.");
    process.exit(1);
  }

  // Export v1 memories
  console.log("Exporting v1 memories from ChromaDB...");
  const memories = exportV1Memories(v1DbPath);

  if (memories.length === 0) {
    console.log("No memories found in v1 database.");
    process.exit(0);
  }

  console.log(`Found ${memories.length} memories in v1 database.\n`);

  // Save backup
  const backupDir = join(process.cwd(), "migration-backup");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `v1-export-${Date.now()}.json`);
  writeFileSync(backupPath, JSON.stringify(memories, null, 2));
  console.log(`Backup saved to: ${backupPath}\n`);

  if (dryRun) {
    console.log("=== DRY RUN — would migrate these memories ===\n");
    for (const mem of memories.slice(0, 20)) {
      console.log(`  [${mem.id}] ${mem.text.substring(0, 100)}...`);
    }
    if (memories.length > 20) {
      console.log(`  ... and ${memories.length - 20} more`);
    }
    console.log("\nRe-run without --dry-run to perform migration.");
    process.exit(0);
  }

  // Import into v2
  console.log("Importing into v2 via mem0ai SDK...\n");

  const { Memory } = await import("mem0ai/oss");
  const memory = new Memory({ version: "v1.1" });

  const result: MigrationResult = {
    total: memories.length,
    migrated: 0,
    skipped: 0,
    errors: [],
  };

  for (const mem of memories) {
    try {
      const text = mem.text;
      if (!text || text.trim().length < 3) {
        result.skipped++;
        continue;
      }

      await memory.add([{ role: "user", content: text }], {
        userId,
      });

      result.migrated++;

      if (result.migrated % 10 === 0) {
        console.log(`  Progress: ${result.migrated}/${result.total}`);
      }
    } catch (err) {
      result.errors.push(`[${mem.id}] ${String(err)}`);
    }
  }

  console.log("\n=== Migration Complete ===\n");
  console.log(`Total:    ${result.total}`);
  console.log(`Migrated: ${result.migrated}`);
  console.log(`Skipped:  ${result.skipped}`);
  console.log(`Errors:   ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const err of result.errors.slice(0, 10)) {
      console.log(`  - ${err}`);
    }
    if (result.errors.length > 10) {
      console.log(`  ... and ${result.errors.length - 10} more`);
    }
  }
}

main().catch((err) => {
  console.error(`Migration failed: ${String(err)}`);
  process.exit(1);
});
