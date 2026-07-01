"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { Button, Badge } from "@myd-org/ui"
import { ChatPanel } from "@myd-org/ai-widget/preset"
import "@myd-org/ai-widget/styles"

interface Props {
  open: boolean
  onClose: () => void
  endUserId: string
  contactName: string
  /** Ancho del panel en px (arrastrable desde la barra divisoria). Default 380. */
  width?: number
  /** Último mensaje del cliente: de ahí sale el contexto que usa el copiloto (misma sesión). */
  lastInboundAt: string | null
  withinWindow: boolean
}

interface AssistInit {
  conversationId: string
  agentId: string
}

// Copiloto del operador (ADR 0007). Panel lateral (en flujo, NO overlay) con el widget de IA: la
// conversación se achica y quedan lado a lado, sin tapar lo que el operador escribe al cliente.
// El widget arranca con la conversación de asistencia pre-creada; ai-api le inyecta el contexto de
// la charla del cliente por turno. El operador copia la respuesta y la pega en el cuadro de reply.
export function AiAssistPanel({ open, onClose, endUserId, contactName, width = 380, lastInboundAt, withinWindow }: Props) {
  const [init, setInit] = useState<AssistInit | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const startedFor = useRef<string | null>(null)

  // Busca-o-crea el hilo de asistencia y devuelve el payload. El widget usa fetchToken para
  // refrescar el token re-llamando a este endpoint (find-or-create → mismo conversationId).
  const fetchAssist = useCallback(async () => {
    const res = await fetch(`/api/admin/inbox/contacts/${endUserId}/assist`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? "assist_failed")
    }
    return res.json() as Promise<{ conversationId: string; token: string; agentId: string; baseUrl: string }>
  }, [endUserId])

  // Al abrir (o cambiar de contacto) arranca el hilo una sola vez por contacto.
  useEffect(() => {
    if (!open || startedFor.current === endUserId) return
    startedFor.current = endUserId
    setInit(null)
    setLoading(true)
    setError("")
    fetchAssist()
      .then((data) => setInit({ conversationId: data.conversationId, agentId: data.agentId }))
      .catch((e: unknown) => {
        const code = e instanceof Error ? e.message : "assist_failed"
        setError(
          code === "assist_agent_not_configured"
            ? "El copiloto no está configurado para este tenant."
            : "No se pudo abrir el asistente. Intentá de nuevo.",
        )
      })
      .finally(() => setLoading(false))
  }, [open, endUserId, fetchAssist])

  if (!open) return null

  return (
    <aside
      className="flex flex-col h-full shrink-0"
      style={{ width, background: "var(--card)", borderLeft: "1px solid var(--border)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Asistente IA</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-xs truncate" style={{ color: "var(--ink-soft)" }}>
              Contexto: {contactName}{lastInboundAt ? ` · sesión del ${formatSessionDate(lastInboundAt)}` : ""}
            </p>
            {!withinWindow && <Badge tone="warning" className="text-[10px] px-1.5 py-0">Ventana cerrada</Badge>}
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Cerrar" onClick={onClose}>
          <X size={16} strokeWidth={1.6} />
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        {loading && (
          <p className="text-xs text-center py-6" style={{ color: "var(--ink-faint)" }}>Abriendo asistente…</p>
        )}
        {error && <p className="text-xs text-center py-6 px-4 text-danger">{error}</p>}
        {init && (
          <ChatPanel
            config={{
              baseUrl: "/ai-api",
              agentId: init.agentId,
              conversationId: init.conversationId,
              fetchToken: async () => (await fetchAssist()).token,
            }}
            branding={{ title: "Asistente IA", subtitle: "Copiloto de ventas", primaryColor: "#0c3ed6" }}
            showActivity
            enableCopy
          />
        )}
      </div>
    </aside>
  )
}

function formatSessionDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })
}
