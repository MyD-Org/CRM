import { flag } from "@vercel/flags/next"

// ── Feature flags ──────────────────────────────────────────────────────────
// Proveedor actual: Vercel Flags
// Para cambiar de proveedor: reemplazar solo este archivo manteniendo la misma
// interfaz exportada (cada flag es una función async que devuelve boolean).

export const shopEnabled = flag<boolean>({
  key: "shop-enabled",
  defaultValue: false,
  description: "Activa el link a la tienda online en el header del portal",
  origin: "https://vercel.com/docs/workflow-collaboration/feature-flags",
  decide: () => process.env.SHOP_ENABLED === "true",
})

export const aiChatEnabled = flag<boolean>({
  key: "ai-chat-enabled",
  defaultValue: false,
  description: "Muestra la burbuja de chat con el agente de soporte post-venta",
  origin: "https://vercel.com/docs/workflow-collaboration/feature-flags",
  // Hasta conectar el adapter de Vercel: se controla por env (true en dev local)
  decide: () => process.env.AI_CHAT_ENABLED === "true",
})
