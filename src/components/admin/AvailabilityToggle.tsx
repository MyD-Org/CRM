"use client"

import { useTransition } from "react"

export type Availability = "available" | "away"

interface Props {
  value: Availability
  // Se llama con el estado siguiente ANTES de hacer el fetch. Devuelve false si el cambio
  // fue rechazado (p. ej. el operador tiene conversaciones pendientes y cancela); en ese caso
  // el padre revierte el optimista y no se llama al backend.
  onChange: (next: Availability) => void
  // Chequeo previo a pasar a "away" (ej. conversaciones asignadas sin responder). Si
  // resuelve false, se aborta el cambio.
  onBeforeAway?: () => Promise<boolean>
  // Modo compacto para el sidebar en rail: solo un dot circular clickeable, sin texto ni switch.
  compact?: boolean
}

// Toggle de presencia del operador (Disponible/Ausente). Mientras está "Disponible" puede
// recibir handoffs; "Ausente" lo saca del pool de asignación. Ver ADR 0006.
//
// Controlado: el state vive en el padre (AdminShell) para que la versión expanded y la
// compact del rail mantengan un único origen de verdad y se mantengan sincronizadas al
// cambiar el modo del sidebar.
export function AvailabilityToggle({ value, onChange, onBeforeAway, compact = false }: Props) {
  const [pending, startTransition] = useTransition()
  const available = value === "available"

  async function toggle() {
    const next: Availability = available ? "away" : "available"
    if (next === "away" && onBeforeAway) {
      const ok = await onBeforeAway()
      if (!ok) return
    }
    onChange(next) // optimista
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/me/availability", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ availability: next }),
        })
        if (!res.ok) onChange(value)
      } catch {
        onChange(value)
      }
    })
  }

  if (compact) {
    // Versión rail: solo un botón circular con el dot de color; hover muestra el estado.
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        role="switch"
        aria-checked={available}
        aria-label={available ? "Disponible" : "Ausente"}
        title={available ? "Disponible — recibiendo conversaciones" : "Ausente — no se te asignan conversaciones"}
        className="flex items-center justify-center h-8 w-8 rounded-full transition-colors disabled:opacity-60 hover:bg-elevated"
      >
        <span
          className="h-3 w-3 rounded-full border border-white/40 shadow"
          style={{ background: available ? "var(--green)" : "var(--subtle, #94a3b8)" }}
          aria-hidden
        />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      role="switch"
      aria-checked={available}
      title={available ? "Estás recibiendo conversaciones" : "No se te asignan conversaciones"}
      className={`flex w-full items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-60 ${
        available ? "text-green" : "text-subtle hover:bg-subtle/10"
      }`}
      style={available ? { background: "var(--green-soft)" } : undefined}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: available ? "var(--green)" : "var(--subtle, #94a3b8)" }}
        aria-hidden
      />
      <span className="flex-1 text-left">{available ? "Disponible" : "Ausente"}</span>
      {/* Riel del switch: verde/knob a la derecha cuando está disponible. */}
      <span
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: available ? "var(--green)" : "color-mix(in srgb, var(--subtle, #94a3b8) 40%, transparent)" }}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
            available ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  )
}
