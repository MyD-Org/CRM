import { mintInboxToken } from "./inbox-token"

// Los mensajes llegan de múltiples canales (WhatsApp, Instagram, Messenger). Nombre
// legible del canal para la UI; si no reconocemos el valor devolvemos lo que venga.
export function channelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case "whatsapp":
      return "WhatsApp"
    case "instagram":
      return "Instagram"
    case "messenger":
      return "Messenger"
    default:
      return channel || "Canal desconocido"
  }
}

export interface InboxConversation {
  id: string
  channel: string
  contact: string
  phone: string | null
  mode: "bot" | "human"
  status: string
  assigned_operator_id: string | null
  // Departamento al que se ruteó el handoff (cola por depto). Ver ADR 0006.
  assigned_department: string | null
  // Nombre del operador asignado, resuelto en el CRM (ai-api solo conoce el UUID opaco).
  assigned_operator_name?: string | null
  last_inbound_at: string | null
  within_window: boolean
  created_at: string
  awaiting_reply: boolean
}

export interface InboxMessage {
  id: string
  role: string
  source: string | null
  text: string
  created_at: string
}

// Una entrada por CONTACTO (persona), no por sesión. La sesión actual aporta mode/asignación.
export interface InboxContact {
  end_user_id: string
  current_conversation_id: string | null
  channel: string
  contact: string
  phone: string | null
  mode: "bot" | "human"
  // Status de la sesión actual (channel_identities.conversationId). Si el operador finalizó y
  // el cliente todavía no volvió a escribir, sigue en "closed" aunque mode ya volvió a "bot".
  status: "active" | "closed"
  assigned_operator_id: string | null
  assigned_operator_name?: string | null
  // Departamento al que el bot ruteó el handoff (cola por depto). Se resuelve en el CRM
  // cruzando con las conversaciones de ai-api; útil para mostrar a qué depto espera.
  assigned_department?: string | null
  last_inbound_at: string | null
  within_window: boolean
  awaiting_reply: boolean
  last_message: string
  last_message_at: string | null
}

// Mensaje dentro del thread mergeado del contacto: trae conversation_id para los divisores.
export interface ContactMessage extends InboxMessage {
  conversation_id: string
}

export interface ContactMessagesPage {
  messages: ContactMessage[]
  next_cursor: number | null
  has_more: boolean
}

async function inboxFetch(
  aiApiUrl: string,
  aiTenantId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await mintInboxToken(aiTenantId)
  return fetch(`${aiApiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      // Solo declaramos JSON cuando realmente mandamos body: un POST sin body (ej.
      // /archive) con content-type JSON hace fallar el parser de Fastify (empty body →
      // 400) y el CRM lo convierte en 500.
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

export async function listConversations(
  aiApiUrl: string,
  aiTenantId: string,
): Promise<InboxConversation[]> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, "/v1/inbox/conversations")
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
  return res.json()
}

export async function getMessages(
  aiApiUrl: string,
  aiTenantId: string,
  conversationId: string,
): Promise<InboxMessage[]> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/conversations/${conversationId}/messages`)
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
  return res.json()
}

// ── Inbox por contacto ────────────────────────────────────────────────────────

export async function listContacts(
  aiApiUrl: string,
  aiTenantId: string,
  scope: "active" | "all" = "active",
): Promise<InboxContact[]> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/contacts?scope=${scope}`)
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
  return res.json()
}

export async function getContact(
  aiApiUrl: string,
  aiTenantId: string,
  endUserId: string,
): Promise<InboxContact> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/contacts/${endUserId}`)
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
  return res.json()
}

export async function getContactMessages(
  aiApiUrl: string,
  aiTenantId: string,
  endUserId: string,
  opts: { before?: number; limit?: number } = {},
): Promise<ContactMessagesPage> {
  const params = new URLSearchParams()
  if (opts.before != null) params.set("before", String(opts.before))
  if (opts.limit != null) params.set("limit", String(opts.limit))
  const qs = params.toString()
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/contacts/${endUserId}/messages${qs ? `?${qs}` : ""}`)
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
  return res.json()
}

// Kill switch global del bot del tenant. Al apagarlo, el bot deja de responder en TODAS
// las conversaciones (los mensajes entrantes se persisten en el inbox pero no se invoca
// el modelo). Estado en tenants.settings.botEnabled del lado de la ai-api.
export async function getBotStatus(aiApiUrl: string, aiTenantId: string): Promise<boolean> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, "/v1/inbox/bot-status")
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
  const body = await res.json()
  return body.botEnabled
}

export async function setBotStatus(aiApiUrl: string, aiTenantId: string, enabled: boolean): Promise<void> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, "/v1/inbox/bot-status", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
}

// Panel de gasto del bot (Feature B). Agrega usage_records del tenant en la ai-api.
export interface UsageTotals {
  botTurns: number
  tokens: number
  costUsd: number
}
export interface DailyUsage extends UsageTotals {
  date: string // 'YYYY-MM-DD'
}
export interface ModelUsage extends UsageTotals {
  model: string
}
export interface UsageSummary {
  today: UsageTotals
  month: UsageTotals
  daily: DailyUsage[]
  byModel: ModelUsage[]
}

export async function getUsageSummary(
  aiApiUrl: string,
  aiTenantId: string,
  days = 30,
): Promise<UsageSummary> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/usage?days=${days}`)
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
  return res.json()
}

export async function setMode(
  aiApiUrl: string,
  aiTenantId: string,
  conversationId: string,
  mode: "bot" | "human",
  operatorName?: string,
): Promise<void> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/conversations/${conversationId}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode, ...(operatorName ? { operatorName } : {}) }),
  })
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
}

// Nota: la asignación de operador YA NO se guarda en ai-api. El CRM es la fuente de verdad
// (tabla conversation_assignments en Neon). Ver lib/assignment.ts y ADR 0006.

export async function archiveConversation(
  aiApiUrl: string,
  aiTenantId: string,
  conversationId: string,
): Promise<void> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/conversations/${conversationId}/archive`, { method: "POST" })
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
}

// Copiloto del operador (ADR 0007). Busca-o-crea el hilo de asistencia del contacto en ai-api y
// devuelve la conversación pre-creada + un session token para que el widget del admin chatee.
export interface AssistSession {
  conversationId: string
  token: string
  agentId: string
  expiresAt: string
}

export async function startAssist(
  aiApiUrl: string,
  aiTenantId: string,
  endUserId: string,
): Promise<{ ok: true; session: AssistSession } | { ok: false; error: string }> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/contacts/${endUserId}/assist`, { method: "POST" })
  if (res.status === 409 || res.status === 404) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, error: body.error ?? "assist_unavailable" }
  }
  if (!res.ok) return { ok: false, error: "assist_failed" }
  const body = await res.json()
  return {
    ok: true,
    session: {
      conversationId: body.conversation_id,
      token: body.token,
      agentId: body.agent_id,
      expiresAt: body.expires_at,
    },
  }
}

export async function sendReply(
  aiApiUrl: string,
  aiTenantId: string,
  conversationId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/conversations/${conversationId}/reply`, {
    method: "POST",
    body: JSON.stringify({ text }),
  })
  if (res.status === 409) {
    const body = await res.json()
    return { ok: false, error: body.error }
  }
  if (!res.ok) return { ok: false, error: "send_failed" }
  return { ok: true }
}
