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
  /**
   * Identity that stamps CR `requestedBy`/`decidedBy` when no session is
   * present (defensive fallback only — sessions are the real identity).
   */
  defaultActor: string
  /** HMAC key for the `gantt_session` cookie. Rotating it kills sessions. */
  sessionSecret: string
  /** Shared login passcode (one per deployment, not per user). */
  actorPasscode: string
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
  const sessionSecret = env.SESSION_SECRET?.trim() ?? ""
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required (see server/.env.example)")
  }
  const actorPasscode = env.ACTOR_PASSCODE?.trim() ?? ""
  if (!actorPasscode) {
    throw new Error("ACTOR_PASSCODE is required (see server/.env.example)")
  }
  return {
    databaseUrl,
    port,
    host: "127.0.0.1",
    defaultActor: env.DEFAULT_ACTOR?.trim() || "demo-actor",
    sessionSecret,
    actorPasscode,
  }
}
