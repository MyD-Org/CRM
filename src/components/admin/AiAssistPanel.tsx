"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { X } from "lucide-react"
import { Button, Badge } from "@myd-org/ui"
import { ChatPanel } from "@myd-org/ai-widget/preset"
import "@myd-org/ai-widget/styles"

interface Props {
  open: boolean
  /** Arranca el hilo SIN abrir el panel (ej. al pasar el mouse por el botón). El pedido no usa
   *  el modelo —solo busca-o-crea el hilo y devuelve el token—, así que adelantarlo no cuesta
   *  nada y saca la espera del click. Ver el useEffect de abajo. */
  prefetch?: boolean
  onClose: () => void
  endUserId: string
  contactName: string
  /** Ancho del panel en px (arrastrable desde la barra divisoria). Default 380. */
  width?: number
  /** Último mensaje del cliente: de ahí sale el contexto que usa el copiloto (misma sesión). */
  lastInboundAt: string | null
  withinWindow: boolean
  /** Acción "Enviar al canal" de las budget cards: recibe el texto serializado de la card y lo
   *  prefila en el compose de la conversación (no auto-envía). Lo forwardea a <ChatPanel>. */
  onSendToChannel?: (text: string) => void
  /** Acción del botón "Copiar" de cada respuesta del copiloto: en vez de portapapeles, inserta
   *  el texto (ya en formato WhatsApp) en el compose del operador. El label sigue siendo "Copiar"
   *  para no reetiquetar la acción; solo cambia el destino del click. */
  onUseSuggestion?: (text: string) => void
}

interface AssistInit {
  conversationId: string
  agentId: string
}

// Copiloto del operador (ADR 0007). Panel lateral (en flujo, NO overlay) con el widget de IA: la
// conversación se achica y quedan lado a lado, sin tapar lo que el operador escribe al cliente.
// El widget arranca con la conversación de asistencia pre-creada; ai-api le inyecta el contexto de
// la charla del cliente por turno. El operador copia la respuesta y la pega en el cuadro de reply.
export function AiAssistPanel({ open, prefetch = false, onClose, endUserId, contactName, width = 380, lastInboundAt, withinWindow, onSendToChannel, onUseSuggestion }: Props) {
  const [init, setInit] = useState<AssistInit | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const startedFor = useRef<string | null>(null)
  // El primer token viene en la misma respuesta que crea el hilo. Lo consumimos UNA vez por
  // fetchToken (el widget lo pide al mount) para que ese pedido inicial no cueste un round-trip
  // extra. Las siguientes veces —cuando el token expira y el widget pide uno nuevo— sí van a red.
  const initialTokenRef = useRef<string | null>(null)

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

  // Al abrir —o al precargar, o al cambiar de contacto— arranca el hilo una sola vez por
  // contacto. Con `prefetch` esto corre con el panel cerrado: abajo devolvemos null igual, pero
  // cuando el operador hace click el token ya está y el panel aparece sin espera.
  useEffect(() => {
    if ((!open && !prefetch) || startedFor.current === endUserId) return
    startedFor.current = endUserId
    setInit(null)
    setLoading(true)
    setError("")
    fetchAssist()
      .then((data) => {
        initialTokenRef.current = data.token
        setInit({ conversationId: data.conversationId, agentId: data.agentId })
      })
      .catch((e: unknown) => {
        const code = e instanceof Error ? e.message : "assist_failed"
        setError(
          code === "assist_agent_not_configured"
            ? "El copiloto no está configurado para este tenant."
            : "No se pudo abrir el asistente. Intentá de nuevo.",
        )
      })
      .finally(() => setLoading(false))
  }, [open, prefetch, endUserId, fetchAssist])

  // Config estable por hilo: recrearla en cada render haría que el widget recree su cliente
  // y recargue el historial en pleno streaming (borra el mensaje optimista y las cards).
  const chatConfig = useMemo(
    () =>
      init && {
        baseUrl: "/ai-api",
        agentId: init.agentId,
        conversationId: init.conversationId,
        fetchToken: async () => {
          // Primera llamada del widget: usar el token que ya trajimos con el hilo. En las
          // siguientes (renovación tras 401) sí volvemos a /assist.
          const cached = initialTokenRef.current
          if (cached) {
            initialTokenRef.current = null
            return cached
          }
          return (await fetchAssist()).token
        },
      },
    [init, fetchAssist],
  )

  if (!open) return null

  return (
    <aside
      // Desktop (md+): panel lateral en flujo de ancho arrastrable (la conversación se achica).
      // Mobile (< md): overlay full-screen (fixed inset-0) para no aplastar la conversación; el
      //   `!w-full` (con !important) pisa el `width` inline del arrastre, que no aplica al tacto.
      className="flex flex-col h-full shrink-0 max-md:fixed max-md:inset-0 max-md:z-40 max-md:!w-full max-md:border-l-0"
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
        {chatConfig && (
          <ChatPanel
            config={chatConfig}
            branding={{ title: "Asistente IA", subtitle: "Copiloto de ventas", primaryColor: "#0c3ed6" }}
            showActivity
            enableCopy
            onSendToChannel={onSendToChannel}
            onUseMessage={onUseSuggestion}
          />
        )}
      </div>
    </aside>
  )
}

function formatSessionDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })
}
