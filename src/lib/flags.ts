import { flag } from "@vercel/flags/next"

// ── Feature flags ──────────────────────────────────────────────────────────
// Proveedor actual: Vercel Flags
// Para cambiar de proveedor: reemplazar solo este archivo manteniendo la misma
// interfaz exportada (cada flag es una función async que devuelve boolean).

export const aiChatEnabled = flag<boolean>({
  key: "ai-chat-enabled",
  defaultValue: false,
  description: "Muestra la burbuja de chat con el agente de soporte post-venta",
  origin: "https://vercel.com/docs/workflow-collaboration/feature-flags",
  decide: () => false,
})
