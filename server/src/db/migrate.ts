// Minimal migration runner: applies pending `.sql` files from
// server/src/db/migrations in lexical order, recording each one in
// schema_migrations. Idempotent by construction — applied files are
// skipped — and safe to call at boot. No migration framework.
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { Pool } from "pg"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")

export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  const applied = new Set(
    (await pool.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map(
      (r) => r.id,
    ),
  )
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(sql)
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file])
      await client.query("COMMIT")
      ran.push(file)
    } catch (e) {
      await client.query("ROLLBACK")
      throw e
    } finally {
      client.release()
    }
  }
  return ran
}

// CLI entry: `node src/db/migrate.ts`
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { createPool } = await import("./pool.ts")
  const pool = createPool()
  try {
    const ran = await runMigrations(pool)
    console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date")
  } finally {
    await pool.end()
  }
}
