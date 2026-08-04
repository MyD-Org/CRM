// Modelo canónico del horario de atención del negocio.
//
// Es lo que el ai-api consulta (GET /api/internal/business-hours) y lo que el admin
// carga desde Configuración → Horarios. Forma del contrato con el agente:
//
//   { notes: string | null, schedule: { monday: [{open,close}, ...], ..., sunday: [] } }
//
// - `schedule`: franjas por día. Un día sin franjas = cerrado. Las horas son "HH:MM" 24h.
// - `notes`: texto libre opcional que el agente puede usar para aclaraciones
//   (ej. "cerrado del 20 al 30 de diciembre", "sábados solo con cita previa").

export type TimeRange = { open: string; close: string }

export const WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const

export type WeekdayKey = (typeof WEEKDAY_KEYS)[number]

export type WeeklySchedule = Record<WeekdayKey, TimeRange[]>

// Etiquetas ES + abreviatura para la UI. El orden es el mismo que WEEKDAY_KEYS.
export const WEEKDAY_LABELS: Record<WeekdayKey, { long: string; short: string }> = {
  monday: { long: "Lunes", short: "Lun" },
  tuesday: { long: "Martes", short: "Mar" },
  wednesday: { long: "Miércoles", short: "Mié" },
  thursday: { long: "Jueves", short: "Jue" },
  friday: { long: "Viernes", short: "Vie" },
  saturday: { long: "Sábado", short: "Sáb" },
  sunday: { long: "Domingo", short: "Dom" },
}

export function emptySchedule(): WeeklySchedule {
  return {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function isValidTime(v: unknown): v is string {
  return typeof v === "string" && TIME_RE.test(v)
}

// Normaliza cualquier valor (ej. lo que hay en la DB) a un WeeklySchedule con las 7 claves.
// Descarta silenciosamente lo inválido; usar para LEER, no para validar input del usuario.
export function normalizeSchedule(input: unknown): WeeklySchedule {
  const out = emptySchedule()
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>
    for (const key of WEEKDAY_KEYS) {
      const raw = obj[key]
      if (!Array.isArray(raw)) continue
      out[key] = raw
        .filter(
          (r): r is TimeRange =>
            !!r &&
            typeof r === "object" &&
            isValidTime((r as TimeRange).open) &&
            isValidTime((r as TimeRange).close),
        )
        .map((r) => ({ open: r.open, close: r.close }))
    }
  }
  return out
}

// Valida input del usuario (PUT). Rechaza horas mal formadas, cierres <= aperturas o franjas
// que se pisan dentro del mismo día. Devuelve franjas ordenadas por apertura para que la
// forma serializada sea canónica (scheduleToBlocks agrupa por JSON.stringify).
export function parseSchedule(
  input: unknown,
): { ok: true; schedule: WeeklySchedule } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "schedule debe ser un objeto" }
  }
  const obj = input as Record<string, unknown>
  const out = emptySchedule()
  for (const key of WEEKDAY_KEYS) {
    const raw = obj[key]
    if (raw == null) {
      out[key] = []
      continue
    }
    if (!Array.isArray(raw)) {
      return { ok: false, error: `schedule.${key} debe ser un array de franjas` }
    }
    const parsed = parseRanges(raw, WEEKDAY_LABELS[key].long)
    if (!parsed.ok) return parsed
    out[key] = parsed.ranges
  }
  return { ok: true, schedule: out }
}

// Parsea + valida + ordena un array de franjas. Rechaza si dos franjas se pisan.
// Compartido por parseSchedule (día semanal) y parseExceptions (special).
function parseRanges(
  input: unknown[],
  ctx: string,
): { ok: true; ranges: TimeRange[] } | { ok: false; error: string } {
  const ranges: TimeRange[] = []
  for (const r of input) {
    if (!r || typeof r !== "object") return { ok: false, error: `franja inválida en ${ctx}` }
    const open = (r as TimeRange).open
    const close = (r as TimeRange).close
    if (!isValidTime(open) || !isValidTime(close)) {
      return { ok: false, error: `hora inválida en ${ctx} (formato esperado HH:MM)` }
    }
    if (close <= open) {
      return { ok: false, error: `en ${ctx}, el cierre debe ser posterior a la apertura` }
    }
    ranges.push({ open, close })
  }
  // Ordenar por apertura para tener forma canónica + detectar overlaps con una sola pasada.
  ranges.sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : 0))
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].open < ranges[i - 1].close) {
      return { ok: false, error: `en ${ctx}, las franjas se superponen` }
    }
  }
  return { ok: true, ranges }
}

// ---- Helpers para el editor por "bloques" ----
// La UI agrupa días que comparten las mismas franjas en un bloque (ej. Lun–Vie 9–18).
// Un día vive en un solo bloque. Los días sin franjas quedan fuera de todo bloque = cerrados.

export type ScheduleBlock = { days: WeekdayKey[]; ranges: TimeRange[] }

export function scheduleToBlocks(schedule: WeeklySchedule): ScheduleBlock[] {
  const groups = new Map<string, ScheduleBlock>()
  for (const day of WEEKDAY_KEYS) {
    const ranges = schedule[day] ?? []
    if (ranges.length === 0) continue
    // parseSchedule ya guarda las franjas ordenadas por apertura, así que dos días con el
    // mismo horario tienen exactamente la misma serialización.
    const sig = JSON.stringify(ranges)
    const existing = groups.get(sig)
    if (existing) existing.days.push(day)
    else groups.set(sig, { days: [day], ranges: ranges.map((r) => ({ ...r })) })
  }
  return [...groups.values()]
}

export function blocksToSchedule(blocks: ScheduleBlock[]): WeeklySchedule {
  const out = emptySchedule()
  for (const b of blocks) {
    for (const d of b.days) out[d] = b.ranges.map((r) => ({ ...r }))
  }
  return out
}

// ---- Excepciones (feriados / vacaciones / horario especial) ----
// Se guardan CRM-side en tenants.schedule_exceptions. NO viajan al ai-api todavía
// (el contrato del endpoint interno sigue siendo { notes, schedule }).
//
// - closed: cerrado en `date`, opcionalmente hasta `to` (rango de fechas).
// - special: ese `date` abre con `ranges` distintas al horario semanal.

export type ScheduleException =
  | { type: "closed"; date: string; to: string | null; reason: string | null }
  | { type: "special"; date: string; ranges: TimeRange[]; reason: string | null }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

// Valida input del usuario (PUT). Rechaza fechas/horas mal formadas.
export function parseExceptions(
  input: unknown,
): { ok: true; exceptions: ScheduleException[] } | { ok: false; error: string } {
  if (input == null) return { ok: true, exceptions: [] }
  if (!Array.isArray(input)) return { ok: false, error: "exceptions debe ser un array" }

  const out: ScheduleException[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "excepción inválida" }
    const e = raw as Record<string, unknown>
    const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : null

    if (e.type === "closed") {
      if (!isValidDate(e.date)) return { ok: false, error: "excepción cerrada: fecha inválida (YYYY-MM-DD)" }
      let to: string | null = null
      if (e.to != null && e.to !== "") {
        if (!isValidDate(e.to)) return { ok: false, error: "excepción cerrada: fecha 'hasta' inválida" }
        if (e.to < e.date) return { ok: false, error: "excepción cerrada: 'hasta' no puede ser anterior a la fecha" }
        to = e.to
      }
      out.push({ type: "closed", date: e.date, to, reason })
    } else if (e.type === "special") {
      if (!isValidDate(e.date)) return { ok: false, error: "excepción de horario especial: fecha inválida" }
      if (!Array.isArray(e.ranges) || e.ranges.length === 0) {
        return { ok: false, error: "excepción de horario especial: agregá al menos una franja" }
      }
      const parsed = parseRanges(e.ranges, "excepción de horario especial")
      if (!parsed.ok) return parsed
      out.push({ type: "special", date: e.date, ranges: parsed.ranges, reason })
    } else {
      return { ok: false, error: "tipo de excepción desconocido" }
    }
  }
  return { ok: true, exceptions: out }
}

// Normaliza para LEER (descarta lo inválido en vez de fallar).
export function normalizeExceptions(input: unknown): ScheduleException[] {
  const parsed = parseExceptions(input)
  return parsed.ok ? parsed.exceptions : []
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${d}/${m}/${y}`
}

// Renderiza las excepciones como texto legible para inyectar en el campo `notes` que
// consume el ai-api. Null si no hay ninguna. El agente lee esto y lo comunica al cliente.
export function exceptionsToNotes(exceptions: ScheduleException[]): string | null {
  if (!exceptions.length) return null
  const lines = exceptions.map((e) => {
    const reason = e.reason ? ` (${e.reason})` : ""
    if (e.type === "closed") {
      return e.to
        ? `Cerrado del ${formatDate(e.date)} al ${formatDate(e.to)}${reason}.`
        : `Cerrado el ${formatDate(e.date)}${reason}.`
    }
    const ranges = e.ranges.map((r) => `${r.open} a ${r.close}`).join(" y ")
    return `El ${formatDate(e.date)} abre con horario especial: ${ranges}${reason}.`
  })
  return lines.join("\n")
}
