import { useState, useSyncExternalStore } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { ChangesetRecorder } from "@/lib/changeset"
import { APP_STRINGS_ES } from "@/lib/i18n-es"
import type { UmeJsonEntity } from "@/lib/umejson/schema"
import type { ChangeOp } from "@/lib/umejson/codec"

export function ChangesetPanel({
  recorder,
  documentOut,
  onPropose,
  canPropose = true,
}: {
  recorder: ChangesetRecorder
  documentOut: UmeJsonEntity | null
  /** Present only online: proposes the recorded ops as a change request. */
  onPropose?: (ops: ChangeOp[], reason?: string) => Promise<void>
  /** False when the session lacks an editor/aprobador role: hides the form. */
  canPropose?: boolean
}) {
  const ops = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot)
  const [reason, setReason] = useState("")
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const copyJson = (text: string) => {
    void navigator.clipboard.writeText(text)
  }

  // The recorder is NOT reset here: the reset arrives with the remount
  // after an apply (see the viewer key by plan revision in App).
  const propose = () => {
    if (!onPropose || ops.length === 0 || pending) return
    setPending(true)
    setNote(null)
    setError(null)
    onPropose(ops, reason.trim() || undefined)
      .then(() => {
        setReason("")
        setNote(APP_STRINGS_ES.crProposedNote)
      })
      .catch((err: unknown) => {
        setError(
          APP_STRINGS_ES.crProposeError(
            err instanceof Error ? err.message : "error",
          ),
        )
      })
      .finally(() => setPending(false))
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Changeset (contrato de API)</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => copyJson(JSON.stringify(ops, null, 2))}
            disabled={ops.length === 0}
          >
            Copiar JSON
          </Button>
        </CardHeader>
        <CardContent>
          {ops.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sin cambios todavía. Arrastra una barra para registrar un update, o
              usa el hint de "Clic para programar" en una fila vacía para crear
              una tarea.
            </p>
          ) : (
            <pre className="text-xs overflow-auto max-h-56 rounded-md bg-muted p-3">
              {JSON.stringify(ops, null, 2)}
            </pre>
          )}
          {ops.some(
            (op) => (op.op === "update" || op.op === "create") && "cause" in op,
          ) && (
            <p className="text-muted-foreground mt-2 text-xs">
              {APP_STRINGS_ES.cascadeCauseLegend}
            </p>
          )}
          {onPropose && canPropose && (
            <div className="mt-3 flex flex-col gap-2" data-slot="gantt-cr-propose">
              <div className="flex items-center gap-2">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={APP_STRINGS_ES.proposeReasonPlaceholder}
                  aria-label={APP_STRINGS_ES.proposeReasonPlaceholder}
                  className="bg-background ring-ring/20 placeholder:text-muted-foreground h-8 min-w-0 flex-1 rounded-md px-2.5 text-xs outline-none ring-1 focus-visible:ring-2"
                />
                <Button
                  size="sm"
                  onClick={propose}
                  disabled={ops.length === 0 || pending}
                >
                  {APP_STRINGS_ES.proposeChangeRequest}
                </Button>
              </div>
              {note && (
                <p className="text-emerald-600 dark:text-emerald-400 text-xs">
                  {note}
                </p>
              )}
              {error && <p className="text-destructive text-xs">{error}</p>}
            </div>
          )}
        </CardContent>
      </Card>
      {documentOut && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle>Documento umeJSON actualizado</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyJson(JSON.stringify(documentOut, null, 2))}
            >
              Copiar JSON
            </Button>
          </CardHeader>
          <CardContent>
            <pre className="text-xs overflow-auto max-h-72 rounded-md bg-muted p-3">
              {JSON.stringify(documentOut, null, 2)}
            </pre>
            <p className="text-muted-foreground mt-2 text-xs">
              <code>updatedAt</code> y <code>timestamp</code> en{" "}
              <code>statusLog</code> están marcados con <code>RESERVED_FOR_SYSTEM</code>:
              los completa el backend al persistir.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
