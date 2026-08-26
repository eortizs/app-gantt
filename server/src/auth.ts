// Session identity (Ola 3A): an HMAC-signed cookie carrying `actorId|issuedAt`.
//
// - No per-user passwords: the login pairs a public actor picker with ONE
//   shared passcode from config (ACTOR_PASSCODE).
// - The cookie is HttpOnly + SameSite=Lax, 12h expiry, signed with
//   SESSION_SECRET. Rotating the secret invalidates every session — the
//   documented trade-off.
// - Roles are a simple ladder: visor < editor < aprobador. GETs stay
//   public (the anonymous demo keeps working); writes demand a session.
import { createHmac, timingSafeEqual } from "node:crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import cookie from "@fastify/cookie"
import type { Pool } from "pg"

export const SESSION_COOKIE = "gantt_session"
/** 12 hours, in seconds (cookie maxAge) and ms (payload expiry). */
const SESSION_TTL_S = 12 * 60 * 60

export type ActorRole = "visor" | "editor" | "aprobador"

const ROLE_RANK: Record<ActorRole, number> = {
  visor: 1,
  editor: 2,
  aprobador: 3,
}

export interface SessionActor {
  id: string
  name: string
  role: ActorRole
}

declare module "fastify" {
  interface FastifyRequest {
    actor: SessionActor | null
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

export function createSessionToken(actorId: string, nowMs: number, secret: string): string {
  const payload = `${actorId}|${nowMs}`
  return `${payload}|${sign(payload, secret)}`
}

export function verifySessionToken(
  raw: string | undefined,
  secret: string,
): { actorId: string } | null {
  if (!raw) return null
  const parts = raw.split("|")
  if (parts.length !== 3) return null
  const [actorId, issuedRaw, sig] = parts as [string, string, string]
  const expected = sign(`${actorId}|${issuedRaw}`, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const issued = Number(issuedRaw)
  if (!Number.isFinite(issued)) return null
  if (Date.now() - issued > SESSION_TTL_S * 1000) return null
  return { actorId }
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" })
}

/**
 * Registers the cookie plugin and a global preHandler that resolves
 * `request.actor` (null when absent/expired/unknown). GETs stay open;
 * everything else flows through `requireRole`.
 */
export async function registerSession(
  app: FastifyInstance,
  pool: Pool,
  secret: string,
): Promise<void> {
  await app.register(cookie)

  // Tiny LRU-ish cache so every request doesn't re-query actors: sessions
  // are short-lived and the directory is static in practice.
  const byId = new Map<string, SessionActor>()

  app.addHook("preHandler", async (req) => {
    req.actor = null
    const parsed = verifySessionToken(req.cookies[SESSION_COOKIE], secret)
    if (!parsed) return
    let actor = byId.get(parsed.actorId) ?? null
    if (!actor) {
      const { rows } = await pool.query<{ name: string; role: ActorRole }>(
        "SELECT name, role FROM actors WHERE id = $1",
        [parsed.actorId],
      )
      const row = rows[0]
      if (!row) return
      actor = { id: parsed.actorId, name: row.name, role: row.role }
      byId.set(actor.id, actor)
    }
    req.actor = actor
  })
}

/**
 * Gate for write routes. Sends the error response itself and returns false
 * when the caller may not proceed: 401 without a session, 403 with an
 * insufficient role — `{ error, actor?, requiredRole }`.
 */
export function requireRole(
  req: FastifyRequest,
  reply: FastifyReply,
  minRole: ActorRole,
): boolean {
  if (!req.actor) {
    void reply.code(401).send({
      error: "session required",
      requiredRole: minRole,
    })
    return false
  }
  if (ROLE_RANK[req.actor.role] < ROLE_RANK[minRole]) {
    void reply.code(403).send({
      error: `role "${req.actor.role}" cannot perform this action`,
      actor: { id: req.actor.id, name: req.actor.name, role: req.actor.role },
      requiredRole: minRole,
    })
    return false
  }
  return true
}
