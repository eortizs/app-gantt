import { useSyncExternalStore } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { ChangesetRecorder } from "@/lib/changeset"

export function ChangesetPanel({ recorder }: { recorder: ChangesetRecorder }) {
  const ops = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot)

  const handleCopy = () => {
    void navigator.clipboard.writeText(JSON.stringify(ops, null, 2))
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Changeset (contrato de API)</CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
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
  )
}
