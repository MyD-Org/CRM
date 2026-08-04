"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { CalendarX2, Plus, Trash2, X } from "lucide-react"
import {
  Button,
  Card,
  Chip,
  DateRangeField,
  EmptyState,
  Field,
  Input,
  Select,
  useToast,
} from "@myd-org/ui"
import {
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  blocksToSchedule,
  scheduleToBlocks,
  type ScheduleException,
  type TimeRange,
  type WeekdayKey,
  type WeeklySchedule,
} from "@/lib/schedule"

export type Schedule = {
  schedule: WeeklySchedule
  exceptions: ScheduleException[]
}

interface Props {
  initialSchedule: Schedule
}

// Estado de edición de una excepción: superset de los dos tipos. Al guardar se serializa
// según `type` (ver draftsToExceptions). Así el usuario puede alternar sin perder lo cargado.
type ExceptionDraft = {
  id: string
  type: "closed" | "special"
  date: string
  to: string
  reason: string
  ranges: TimeRange[]
}

// Estado de edición de un bloque en la UI. Igual que ScheduleBlock pero con id: string
// (evita colisiones de `Date.now()` cuando el usuario apretaba dos veces "Agregar" en el
// mismo tick, que rompía las keys de React).
type BlockDraft = { id: string; days: WeekdayKey[]; ranges: TimeRange[] }

const EXCEPTION_TYPE_OPTIONS = [
  { label: "Cerrado", value: "closed" },
  { label: "Horario especial", value: "special" },
]

// IDs de UI generados a partir de un contador local. No van a la DB — solo son keys de React.
// Se usa un objeto que se cierra por referencia sobre las funciones de "add" del componente.
function makeIdGen() {
  let n = 0
  return () => `ui-${++n}`
}

function defaultBlocks(nextId: () => string): BlockDraft[] {
  return [
    {
      id: nextId(),
      days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      ranges: [{ open: "09:00", close: "18:00" }],
    },
  ]
}

function blocksFromSchedule(schedule: WeeklySchedule, nextId: () => string): BlockDraft[] {
  return scheduleToBlocks(schedule).map((b) => ({
    id: nextId(),
    days: b.days,
    ranges: b.ranges,
  }))
}

function exceptionsToDrafts(exceptions: ScheduleException[], nextId: () => string): ExceptionDraft[] {
  return exceptions.map((e) => ({
    id: nextId(),
    type: e.type,
    date: e.date ?? "",
    to: e.type === "closed" ? (e.to ?? "") : "",
    reason: e.reason ?? "",
    ranges: e.type === "special" ? e.ranges.map((r) => ({ ...r })) : [{ open: "08:00", close: "13:00" }],
  }))
}

function draftsToExceptions(drafts: ExceptionDraft[]): ScheduleException[] {
  return drafts.map((d) => {
    const reason = d.reason.trim() || null
    if (d.type === "closed") {
      return { type: "closed", date: d.date, to: d.to || null, reason }
    }
    return { type: "special", date: d.date, ranges: d.ranges, reason }
  })
}

// Editor de franjas horarias, reutilizado por bloques y por excepciones de horario especial.
function RangeEditor({
  ranges,
  onSet,
  onRemove,
  onAdd,
}: {
  ranges: TimeRange[]
  onSet: (index: number, field: "open" | "close", value: string) => void
  onRemove: (index: number) => void
  onAdd: () => void
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-start">
        {ranges.map((range, ri) => (
          <div
            key={ri}
            className="flex w-full flex-wrap items-center gap-2 rounded-lg border px-2 py-2 sm:w-auto"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            <Input
              type="time"
              value={range.open}
              onChange={(e) => onSet(ri, "open", e.target.value)}
              className="w-full sm:w-44"
            />
            <span className="text-sm" style={{ color: "var(--ink-soft)" }}>
              a
            </span>
            <Input
              type="time"
              value={range.close}
              onChange={(e) => onSet(ri, "close", e.target.value)}
              className="w-full sm:w-44"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onRemove(ri)}
              aria-label="Quitar franja"
              className="ml-auto sm:ml-0"
            >
              <X size={14} />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onAdd} className="self-start">
        <Plus size={14} /> Franja
      </Button>
    </div>
  )
}

export function ScheduleForm({ initialSchedule }: Props) {
  const { toast } = useToast()
  const router = useRouter()
  // Generador de ids estables para keys de React. useState con initializer lazy = se crea
  // una sola vez en el primer render y la closure persiste. Es el patrón recomendado en
  // React 19 (useRef prende el linter cuando se lo lee durante el render).
  const [nextId] = useState(() => makeIdGen())
  const [blocks, setBlocks] = useState<BlockDraft[]>(() => {
    const fromDb = blocksFromSchedule(initialSchedule.schedule, nextId)
    return fromDb.length > 0 ? fromDb : defaultBlocks(nextId)
  })
  const [exceptions, setExceptions] = useState<ExceptionDraft[]>(() =>
    exceptionsToDrafts(initialSchedule.exceptions, nextId),
  )
  const [saving, setSaving] = useState(false)

  // ---- Bloques ----
  const mutateBlocks = (fn: (draft: BlockDraft[]) => void) =>
    setBlocks((prev) => {
      const draft: BlockDraft[] = structuredClone(prev)
      fn(draft)
      return draft
    })

  const addBlock = () =>
    mutateBlocks((b) => {
      b.push({ id: nextId(), days: [], ranges: [{ open: "09:00", close: "18:00" }] })
    })
  const removeBlock = (i: number) => mutateBlocks((b) => b.splice(i, 1))
  const addBlockRange = (i: number) => mutateBlocks((b) => b[i].ranges.push({ open: "09:00", close: "18:00" }))
  const removeBlockRange = (i: number, r: number) => mutateBlocks((b) => b[i].ranges.splice(r, 1))
  const setBlockRange = (i: number, r: number, field: "open" | "close", value: string) =>
    mutateBlocks((b) => {
      b[i].ranges[r][field] = value
    })
  // Un día vive en un solo bloque: lo saco de todos y lo agrego acá si no estaba.
  const toggleDay = (i: number, day: WeekdayKey) =>
    mutateBlocks((b) => {
      const had = b[i].days.includes(day)
      for (const blk of b) blk.days = blk.days.filter((d) => d !== day)
      if (!had) b[i].days.push(day)
    })

  const closedDays = useMemo(() => {
    const assigned = new Set<WeekdayKey>()
    for (const b of blocks) for (const d of b.days) assigned.add(d)
    return WEEKDAY_KEYS.filter((d) => !assigned.has(d))
  }, [blocks])

  // ---- Excepciones ----
  const mutateExceptions = (fn: (draft: ExceptionDraft[]) => void) =>
    setExceptions((prev) => {
      const draft: ExceptionDraft[] = structuredClone(prev)
      fn(draft)
      return draft
    })

  const addException = () =>
    mutateExceptions((ex) => {
      ex.push({
        id: nextId(),
        type: "closed",
        date: "",
        to: "",
        reason: "",
        ranges: [{ open: "08:00", close: "13:00" }],
      })
    })
  const removeException = (i: number) => mutateExceptions((ex) => ex.splice(i, 1))
  const setExceptionField = <K extends keyof ExceptionDraft>(i: number, field: K, value: ExceptionDraft[K]) =>
    mutateExceptions((ex) => {
      ex[i][field] = value
    })
  const addExceptionRange = (i: number) => mutateExceptions((ex) => ex[i].ranges.push({ open: "09:00", close: "13:00" }))
  const removeExceptionRange = (i: number, r: number) => mutateExceptions((ex) => ex[i].ranges.splice(r, 1))
  const setExceptionRange = (i: number, r: number, field: "open" | "close", value: string) =>
    mutateExceptions((ex) => {
      ex[i].ranges[r][field] = value
    })

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/settings/schedule", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule: blocksToSchedule(blocks),
          exceptions: draftsToExceptions(exceptions),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "error desconocido" }))
        throw new Error(err.error ?? `Error ${res.status}`)
      }
      // Invalida el Client Cache de Next (staleTimes: {dynamic: 30} en next.config.ts).
      // Sin esto, salir y volver a /admin/configuracion dentro de 30s te muestra los props
      // viejos (sin la excepción recién guardada) porque Next sirve el árbol RSC cacheado.
      router.refresh()
      toast({ title: "Horarios guardados", tone: "success" })
    } catch (err) {
      toast({
        title: "No se pudo guardar",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 w-full">
      {/* ===== Horario semanal ===== */}
      <Card title="Horario de atención" description="Agrupá los días que comparten el mismo horario. Un día sin franjas queda cerrado.">
        <div className="flex flex-col gap-3">
          {blocks.map((block, i) => (
            <Card key={block.id} className="!p-4" style={{ background: "var(--surface-soft, var(--surface))" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAY_KEYS.map((day) => (
                    <Chip
                      key={day}
                      variant="toggle"
                      selected={block.days.includes(day)}
                      onClick={() => toggleDay(i, day)}
                    >
                      {WEEKDAY_LABELS[day].short}
                    </Chip>
                  ))}
                </div>
                {blocks.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeBlock(i)}
                    aria-label="Quitar este horario"
                  >
                    <Trash2 size={15} />
                  </Button>
                )}
              </div>

              <div className="mt-3.5">
                <RangeEditor
                  ranges={block.ranges}
                  onSet={(r, field, value) => setBlockRange(i, r, field, value)}
                  onRemove={(r) => removeBlockRange(i, r)}
                  onAdd={() => addBlockRange(i)}
                />
              </div>
            </Card>
          ))}

          <Button type="button" variant="secondary" size="sm" className="self-start" onClick={addBlock}>
            <Plus size={15} /> Agregar otro horario
          </Button>

          {closedDays.length > 0 && (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
              Cerrado:{" "}
              <strong style={{ color: "var(--ink)" }}>
                {closedDays.map((d) => WEEKDAY_LABELS[d].long).join(", ")}
              </strong>
            </p>
          )}
        </div>
      </Card>

      {/* ===== Excepciones ===== */}
      <Card
        title="Excepciones"
        description="Feriados, vacaciones o un horario especial en una fecha puntual."
      >
        <div className="flex flex-col gap-3">
          {exceptions.length === 0 ? (
            <EmptyState
              icon={<CalendarX2 size={22} />}
              title="Sin excepciones"
              description="El local usa el horario semanal todos los días."
              action={
                <Button type="button" variant="secondary" size="sm" onClick={addException}>
                  <Plus size={15} /> Agregar excepción
                </Button>
              }
            />
          ) : (
            <>
              {exceptions.map((ex, i) => (
                <Card key={ex.id} className="!p-4" style={{ background: "var(--surface-soft, var(--surface))" }}>
                  <div className="flex items-center gap-3">
                    <div style={{ width: "12rem" }}>
                      <Select
                        options={EXCEPTION_TYPE_OPTIONS}
                        value={ex.type}
                        onValueChange={(v) => setExceptionField(i, "type", v as ExceptionDraft["type"])}
                        aria-label="Tipo de excepción"
                      />
                    </div>
                    <div className="flex-1" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeException(i)}
                      aria-label="Eliminar excepción"
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>

                  <div className="mt-3.5 flex flex-wrap items-start gap-4">
                    {ex.type === "closed" ? (
                      <Field label="Fecha (o rango)">
                        <DateRangeField
                          presets={false}
                          value={{ start: ex.date || undefined, end: ex.to || undefined }}
                          onChange={(v) =>
                            mutateExceptions((draft) => {
                              draft[i].date = v.start ?? ""
                              draft[i].to = v.end ?? ""
                            })
                          }
                          label="Fecha de la excepción"
                        />
                      </Field>
                    ) : (
                      <Field label="Fecha">
                        <Input
                          type="date"
                          value={ex.date}
                          onChange={(e) => setExceptionField(i, "date", e.target.value)}
                        />
                      </Field>
                    )}
                    <Field label="Motivo (opcional)" className="flex-1 min-w-[12rem]">
                      <Input
                        type="text"
                        value={ex.reason}
                        placeholder="Ej: Navidad, vacaciones de verano…"
                        onChange={(e) => setExceptionField(i, "reason", e.target.value)}
                      />
                    </Field>
                  </div>

                  {ex.type === "special" && (
                    <div className="mt-3.5">
                      <p className="mb-2 text-xs font-semibold" style={{ color: "var(--ink-soft)" }}>
                        Horario de ese día
                      </p>
                      <RangeEditor
                        ranges={ex.ranges}
                        onSet={(r, field, value) => setExceptionRange(i, r, field, value)}
                        onRemove={(r) => removeExceptionRange(i, r)}
                        onAdd={() => addExceptionRange(i)}
                      />
                    </div>
                  )}
                </Card>
              ))}

              <Button type="button" variant="secondary" size="sm" className="self-start" onClick={addException}>
                <Plus size={15} /> Agregar excepción
              </Button>
            </>
          )}
        </div>
      </Card>

      <div>
        <Button onClick={handleSave} loading={saving} disabled={saving}>
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  )
}
