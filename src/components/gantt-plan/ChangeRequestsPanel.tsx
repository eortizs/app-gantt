import { useMemo, useState } from "react"
import { format } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { APP_STRINGS_ES, LOCALE_ES } from "@/lib/i18n-es"
import type {
  ChangeRequestPayload,
  ChangeRequestStatus,
  UmeChangeRequestEntity,
} from "@/lib/umejson/change-request"
import { cn } from "@/lib/utils"

export interface ChangeRequestItem {
  entity: UmeChangeRequestEntity
  cr: ChangeRequestPayload
}

/** Apply-time 409: the CR is bound to a plan revision that already moved. */
export class RevisionConflictError extends Error {
  readonly currentRevision: number
  readonly crPlanRevision: number

  constructor(currentRevision: number, crPlanRevision: number) {
    super(`plan revision ${currentRevision}, CR bound to ${crPlanRevision}`)
    this.currentRevision = currentRevision
    this.crPlanRevision = crPlanRevision
  }
}

const STATUS_VARIANT: Record<
  ChangeRequestStatus,
  "secondary" | "default" | "destructive" | "outline"
> = {
  proposed: "secondary",
  approved: "default",
  rejected: "destructive",
  applied: "outline",
}

/**
 * Cola de solicitudes de cambio: cada CR con su razón y el resumen del
 * impacto CONGELADO al proponer (N eventos, Σ desliz, costo proyectado
 * labor-burn con signo — verde ahorro / rojo sobrecosto). Aprobar /
 * Rechazar sobre proposed, Aplicar sobre approved; todo viaja al
 * backend, nada se decide localmente. Una CR aprobada anclada a una
 * revisión que ya se movió no es aplicable (queda approved y hay que
 * re-proponerla): el botón se deshabilita y la fila explica el conflicto.
 * Sin estado propio más allá del pending por fila — el estado real
 * vive en el documento.
 */
export function ChangeRequestsPanel({
  requests,
  planRevision,
  onDecision,
  canDecide = true,
}: {
  requests: ChangeRequestItem[]
  planRevision: number
  onDecision: (id: string, to: ChangeRequestStatus) => Promise<void>
  /** False for sessions without the aprobador role: rows render read-only. */
  canDecide?: boolean
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)

  const decide = (id: string, to: ChangeRequestStatus) => {
    if (pending) return
    setPending(`${id}:${to}`)
    setError(null)
    onDecision(id, to)
      .catch((err: unknown) => {
        setError({
          id,
          text:
            err instanceof RevisionConflictError
              ? APP_STRINGS_ES.crRevisionConflict(
                  err.crPlanRevision,
                  err.currentRevision,
                )
              : APP_STRINGS_ES.crDecisionError(
                  err instanceof Error ? err.message : "error",
                ),
        })
      })
      .finally(() => setPending(null))
  }

  return (
    <Card data-slot="gantt-cr-panel">
      <CardHeader>
        <CardTitle className="text-base">{APP_STRINGS_ES.crTitle}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {requests.length === 0 && (
          <p className="text-muted-foreground text-sm">{APP_STRINGS_ES.crEmpty}</p>
        )}
        {requests.map(({ entity, cr }) => (
          <ChangeRequestRow
            key={entity.id}
            entity={entity}
            cr={cr}
            pending={pending?.startsWith(entity.id) ?? false}
            error={error?.id === entity.id ? error.text : null}
            planRevision={planRevision}
            canDecide={canDecide}
            onDecision={decide}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function ChangeRequestRow({
  entity,
  cr,
  pending,
  error,
  planRevision,
  canDecide,
  onDecision,
}: {
  entity: UmeChangeRequestEntity
  cr: ChangeRequestPayload
  pending: boolean
  error: string | null
  planRevision: number
  canDecide: boolean
  onDecision: (id: string, to: ChangeRequestStatus) => void
}) {
  // Aprobada pero anclada a una revisión que ya no es la vigente: el
  // apply del backend la rechazaría con 409 (binding planRevision).
  const stale = cr.status === "approved" && cr.planRevision !== planRevision
  const reason = cr.statusLog.find((entry) => entry.reason)?.reason
  const driftSum = cr.impact.entries.reduce(
    (sum, entry) => sum + (entry.driftDays ?? 0),
    0,
  )
  const cost = cr.impact.costImpact
  const fmt = useMemo(
    () =>
      cost
        ? new Intl.NumberFormat("es-MX", {
            style: "currency",
            currency: cost.currency,
            maximumFractionDigits: 0,
          })
        : null,
    [cost],
  )
  const decidedBy =
    cr.decidedBy && cr.decidedBy !== "RESERVED_FOR_SYSTEM" ? cr.decidedBy : null

  return (
    <div
      data-slot="gantt-cr-row"
      className="bg-muted/40 flex flex-col gap-1.5 rounded-md px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[cr.status]}>
          {APP_STRINGS_ES.crStatusLabels[cr.status]}
        </Badge>
        <span className="text-muted-foreground text-xs tabular-nums">
          {format(entity.lifecycle.createdAt, "d MMM yyyy HH:mm", {
            locale: LOCALE_ES,
          })}
        </span>
        <span className="text-muted-foreground text-xs">
          rev {cr.planRevision} · {cr.ops.length} ops
        </span>
        {decidedBy && (
          <span className="text-muted-foreground text-xs">
            {decidedBy}
          </span>
        )}
        <span className="grow" />
        {canDecide && cr.status === "proposed" && (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => onDecision(entity.id, "approved")}
              data-slot="gantt-cr-approve"
            >
              {APP_STRINGS_ES.crApprove}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onDecision(entity.id, "rejected")}
              data-slot="gantt-cr-reject"
            >
              {APP_STRINGS_ES.crReject}
            </Button>
          </>
        )}
        {canDecide && cr.status === "approved" && (
          <Button
            size="sm"
            disabled={pending || stale}
            onClick={() => onDecision(entity.id, "applied")}
            data-slot="gantt-cr-apply"
          >
            {APP_STRINGS_ES.crApply}
          </Button>
        )}
      </div>
      {reason && <p className="text-sm">{reason}</p>}
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>{APP_STRINGS_ES.crImpactEvents(cr.impact.entries.length)}</span>
        <span
          className={cn(
            "tabular-nums",
            driftSum > 0 && "text-destructive",
            driftSum < 0 && "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {APP_STRINGS_ES.crImpactDrift(driftSum)}
        </span>
        {cost && fmt && (
          <span
            className={cn(
              "tabular-nums",
              cost.projectedExtraCost > 0 && "text-destructive",
              cost.projectedExtraCost < 0 &&
                "text-emerald-600 dark:text-emerald-400",
            )}
          >
            {APP_STRINGS_ES.crProjectedCost}:{" "}
            <span className="text-foreground font-medium">
              {fmt.format(cost.projectedExtraCost)}
            </span>{" "}
            ({APP_STRINGS_ES.crProjectedCostHint})
          </span>
        )}
        {cost && cost.extendedDays > 0 && (
          <span className="tabular-nums">
            {APP_STRINGS_ES.crExtendedDays(cost.extendedDays)}
          </span>
        )}
      </div>
      {stale && (
        <p className="text-destructive text-xs">
          {APP_STRINGS_ES.crRevisionConflict(cr.planRevision, planRevision)}
        </p>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}
