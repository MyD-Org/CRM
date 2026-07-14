import { flag, dedupe } from "@vercel/flags/next"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// ── Feature flags ──────────────────────────────────────────────────────────
// Proveedor actual: Vercel Flags
// Para cambiar de proveedor: reemplazar solo este archivo manteniendo la misma
// interfaz exportada (cada flag es una función async que devuelve boolean).

type AdminEntities = { user: { id: string; name: string; email: string } | null }

// Expone el admin logueado como entity `user` para que las reglas del dashboard
// de Vercel Flags puedan targetear por user.id (o name/email si el provider lo soporta).
const identifyAdmin = dedupe(async (): Promise<AdminEntities> => {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return { user: null }
  return { user: { id: session.userId, name: session.name, email: session.email } }
})

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

// Panel de gasto del bot ("Uso del bot") en el admin. Apagado por default: la feature
// va a migrar al proyecto ia-dashboard; queda gateada en el CRM hasta entonces. Activar
// con BOT_USAGE_PANEL_ENABLED=true.
export const botUsagePanelEnabled = flag<boolean>({
  key: "bot-usage-panel-enabled",
  defaultValue: false,
  description: "Muestra el panel de gasto/uso del bot en el admin (migrará a ia-dashboard)",
  origin: "https://vercel.com/docs/workflow-collaboration/feature-flags",
  decide: () => process.env.BOT_USAGE_PANEL_ENABLED === "true",
})

// Gate del toggle global del bot en el inbox del admin.
// En prod: conectar un provider (Edge Config) y armar reglas por user.id en el dashboard.
// En dev/fallback: allowlist local en BOT_KILL_SWITCH_USER_IDS (IDs separados por coma).
export const botKillSwitchVisible = flag<boolean, AdminEntities>({
  key: "bot-kill-switch",
  defaultValue: false,
  description: "Muestra el toggle global del bot en el inbox del admin. Targetable por user.id.",
  origin: "https://vercel.com/docs/workflow-collaboration/feature-flags",
  identify: identifyAdmin,
  decide: ({ entities }) => {
    const allowlist = (process.env.BOT_KILL_SWITCH_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (allowlist.length === 0) return false
    const userId = entities?.user?.id
    return Boolean(userId && allowlist.includes(userId))
  },
})
