// Manual env loading (no dotenv dependency): server/.env is parsed once at
// boot and only fills variables the environment doesn't already define, so
// systemd's EnvironmentFile wins over the file when both exist. Everything
// missing fails fast — a service that boots half-configured is worse than
// one that refuses to start.
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function loadEnvFile(file: string): void {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export interface ServerConfig {
  databaseUrl: string
  port: number
  host: "127.0.0.1"
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  loadEnvFile(path.join(SERVER_DIR, ".env"))
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (see server/.env.example)")
  }
  const port = Number(env.PORT ?? 4600)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1..65535, got "${env.PORT}"`)
  }
  return { databaseUrl, port, host: "127.0.0.1" }
}
