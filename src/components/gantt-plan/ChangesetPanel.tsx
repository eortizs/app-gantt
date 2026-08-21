import { useSyncExternalStore } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { ChangesetRecorder } from "@/lib/changeset"
import type { UmeJsonEntity } from "@/lib/umejson/schema"

export function ChangesetPanel({
  recorder,
  documentOut,
}: {
  recorder: ChangesetRecorder
  documentOut: UmeJsonEntity | null
}) {
  const ops = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot)

  const copyJson = (text: string) => {
    void navigator.clipboard.writeText(text)
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
