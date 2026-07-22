"use client"

import { AvailabilityToggle } from "./AvailabilityToggle"
import { useAdminHeader } from "./admin-header-context"

// Renderiza el toggle de presencia dentro del encabezado del inbox (junto al título y al kill
// switch), tomando la presencia inicial y la guarda de "ausentarse" del contexto del AdminShell.
// En el inbox, el AdminShell no muestra su fila propia de "Disponible" (ver AdminShell).
export function InboxAvailabilityToggle() {
  const ctx = useAdminHeader()
  if (!ctx) return null
  return <AvailabilityToggle initial={ctx.availability} onBeforeAway={ctx.onBeforeAway} />
}
