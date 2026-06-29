"use client"

import { useState, useTransition } from "react"

type Availability = "available" | "away"

// Toggle de presencia del operador (Disponible/Ausente). Mientras está "Disponible" puede
// recibir handoffs; "Ausente" lo saca del pool de asignación. Ver ADR 0006.
export function AvailabilityToggle({ initial }: { initial: Availability }) {
  const [availability, setAvailability] = useState<Availability>(initial)
  const [pending, startTransition] = useTransition()
  const available = availability === "available"

  function toggle() {
    const next: Availability = available ? "away" : "available"
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
      disabled={pending}
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
