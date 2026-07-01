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
      aria-pressed={available}
      title={available ? "Estás recibiendo conversaciones" : "No se te asignan conversaciones"}
      className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text transition-colors hover:bg-subtle/10 disabled:opacity-60"
    >
      <span
        className={`h-2 w-2 rounded-full ${available ? "bg-green-500" : "bg-subtle"}`}
        aria-hidden
      />
      {available ? "Disponible" : "Ausente"}
    </button>
  )
}
