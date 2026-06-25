import { mintInboxToken } from "./inbox-token"

export interface InboxConversation {
  id: string
  channel: string
  contact: string
  phone: string | null
  mode: "bot" | "human"
  status: string
  assigned_operator_id: string | null
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

async function inboxFetch(
  aiApiUrl: string,
  aiTenantId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await mintInboxToken(aiTenantId)
  return fetch(`${aiApiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
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
