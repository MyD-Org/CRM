"use client"

import { useState, useTransition } from "react"

type Availability = "available" | "away"

interface Props {
  initial: Availability
  // Chequeo previo a pasar a "away" (ej. conversaciones asignadas sin responder). Si
  // resuelve false, se aborta el cambio.
  onBeforeAway?: () => Promise<boolean>
}

// Toggle de presencia del operador (Disponible/Ausente). Mientras está "Disponible" puede
// recibir handoffs; "Ausente" lo saca del pool de asignación. Ver ADR 0006.
export function AvailabilityToggle({ initial, onBeforeAway }: Props) {
  const [availability, setAvailability] = useState<Availability>(initial)
  const [checking, setChecking] = useState(false)
  const [pending, startTransition] = useTransition()
  const available = availability === "available"

  async function toggle() {
    const next: Availability = available ? "away" : "available"
    if (next === "away" && onBeforeAway) {
      setChecking(true)
      const ok = await onBeforeAway()
      setChecking(false)
      if (!ok) return
    }
    const prev = availability
    setAvailability(next) // optimista
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/me/availability", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ availability: next }),
        })
        if (!res.ok) setAvailability(prev)
      } catch {
        setAvailability(prev)
      }
    })
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending || checking}
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
