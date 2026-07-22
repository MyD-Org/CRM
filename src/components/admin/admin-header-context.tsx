"use client"

import { createContext, useContext } from "react"

// Expone a las páginas hijas lo que necesitan para renderizar el toggle de presencia
// ("Disponible") en su propio encabezado en vez de la fila por defecto del AdminShell.
// Lo usa el inbox para juntar título + Disponible + kill switch en una sola fila (mobile).
export interface AdminHeaderCtx {
  availability: "available" | "away"
  // Guarda antes de ausentarse (conversaciones asignadas sin responder). Vive en AdminShell
  // porque también la usa el logout; la compartimos por contexto para no duplicarla.
  onBeforeAway: () => Promise<boolean>
}

const Ctx = createContext<AdminHeaderCtx | null>(null)

export const AdminHeaderProvider = Ctx.Provider

export function useAdminHeader(): AdminHeaderCtx | null {
  return useContext(Ctx)
}
