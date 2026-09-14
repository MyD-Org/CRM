"use client"

// Last-visit de las secciones del backoffice, para los badges de "novedades" del sidebar.
// Vive en localStorage del browser: el modelo es POR DISPOSITIVO a propósito (lo que importa
// es "qué viste en ESTA máquina"). Marcar una visita avisa al resto de la app con un evento
// de window, así el badge se limpia al instante sin esperar el próximo poll.

export type BadgeSection = "inbox" | "comprobantes"

const KEYS: Record<BadgeSection, string> = {
  inbox: "crm:last-visit:inbox",
  comprobantes: "crm:last-visit:comprobantes",
}

/** Nombre del evento que dispara markVisited (AdminShell escucha para recargar los badges). */
export const SECTION_VISITED_EVENT = "crm:section-visited"

/** ISO del último visitado de la sección, o null si nunca (sin valor = sin filtro: backlog). */
export function getLastVisit(section: BadgeSection): string | null {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(KEYS[section])
}

/** Registra la visita (now) y notifica: el badge de la sección se recalcula en el acto. */
export function markVisited(section: BadgeSection): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(KEYS[section], new Date().toISOString())
  window.dispatchEvent(new CustomEvent(SECTION_VISITED_EVENT, { detail: { section } }))
}
