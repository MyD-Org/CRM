import { mintInboxToken } from "./inbox-token"

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
  assigned_operator_id: string | null
  assigned_operator_name?: string | null
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

export async function assignConversation(
  aiApiUrl: string,
  aiTenantId: string,
  conversationId: string,
  operatorId: string,
): Promise<void> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/conversations/${conversationId}/assign`, {
    method: "POST",
    body: JSON.stringify({ operatorId }),
  })
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
}

export async function archiveConversation(
  aiApiUrl: string,
  aiTenantId: string,
  conversationId: string,
): Promise<void> {
  const res = await inboxFetch(aiApiUrl, aiTenantId, `/v1/inbox/conversations/${conversationId}/archive`, { method: "POST" })
  if (!res.ok) throw new Error(`ai-api error ${res.status}`)
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
