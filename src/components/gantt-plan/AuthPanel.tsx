// Login dialog (Ola 3A): public actor picker + shared passcode. Opens on
// demand (header button) and automatically the first time a write receives
// a 401. On success the host refetches /api/auth/me.
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"
import { APP_STRINGS_ES } from "@/lib/i18n-es"

export interface ActorOption {
  id: string
  name: string
  role: "visor" | "editor" | "aprobador"
}

export function AuthPanel({
  open,
  onClose,
  onLoggedIn,
}: {
  open: boolean
  onClose: () => void
  onLoggedIn: (actor: ActorOption) => void
}) {
  const [actors, setActors] = useState<ActorOption[] | null>(null)
  const [actorId, setActorId] = useState<string>("")
  const [passcode, setPasscode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open || actors !== null) return
    let cancelled = false
    fetch("/api/auth/actors")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((rows: ActorOption[]) => {
        if (cancelled) return
        setActors(rows)
        setActorId(rows[0]?.id ?? "")
      })
      .catch(() => {
        if (!cancelled) setError(APP_STRINGS_ES.authLoadError)
      })
    return () => {
      cancelled = true
    }
  }, [open, actors])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!open) return null

  const submit = () => {
    if (!actorId || pending) return
    setPending(true)
    setError(null)
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId, passcode }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const actor = (await res.json()) as ActorOption
        onLoggedIn(actor)
      })
      .catch(() => setError(APP_STRINGS_ES.authInvalid))
      .finally(() => setPending(false))
  }

  return (
    <div
      role="dialog"
      aria-label={APP_STRINGS_ES.authTitle}
      tabIndex={-1}
      data-slot="gantt-auth-panel"
      className="bg-popover text-popover-foreground ring-ring/20 fixed left-1/2 top-24 z-100 w-max min-w-72 max-w-sm -translate-x-1/2 rounded-md py-2 text-xs shadow-md outline-none ring-1"
    >
      <div className="flex items-start justify-between gap-4 px-3 pb-1">
        <span className="font-medium">{APP_STRINGS_ES.authTitle}</span>
        <button
          type="button"
          aria-label={APP_STRINGS_ES.closePanel}
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground -mr-1 rounded-sm p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-2 border-t px-3 pt-2">
        <label className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{APP_STRINGS_ES.authPickActor}</span>
          <select
            data-slot="gantt-auth-actor"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            aria-label={APP_STRINGS_ES.authPickActor}
            disabled={actors === null}
            className="bg-background ring-ring/30 w-40 rounded-md px-1 py-0.5 ring-1 outline-none"
          >
            {(actors ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {APP_STRINGS_ES.roleLabels[a.role]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{APP_STRINGS_ES.authPasscode}</span>
          <input
            ref={inputRef}
            type="password"
            data-slot="gantt-auth-passcode"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
            }}
            aria-label={APP_STRINGS_ES.authPasscode}
            className="bg-background ring-ring/30 focus-visible:ring-ring/50 w-40 rounded-md px-2 py-0.5 ring-1 outline-none focus-visible:ring-2"
          />
        </label>
        {error && <p className="text-destructive">{error}</p>}
        <div className="flex items-center justify-end gap-1.5 pb-0.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {APP_STRINGS_ES.progressCancel}
          </Button>
          <Button
            size="sm"
            data-slot="gantt-auth-submit"
            onClick={submit}
            disabled={!actorId || pending}
          >
            {APP_STRINGS_ES.authSubmit}
          </Button>
        </div>
      </div>
    </div>
  )
}
