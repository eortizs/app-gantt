// Single pg pool (max 10). Created once per process; the seed and migrate
// CLI scripts create their own and end them explicitly.
import pg from "pg"
import { loadConfig, type ServerConfig } from "../config.ts"

export function createPool(config: ServerConfig = loadConfig()): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
  })
}
