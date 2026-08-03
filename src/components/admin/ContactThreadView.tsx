"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { ArrowLeft, Send, CheckCheck, Bot, Sparkles, UserPlus, User, AlertTriangle, RefreshCw, X, Clock } from "lucide-react"
import { Button, Badge, Textarea, Dialog, useToast } from "@myd-org/ui"
import { useRouter } from "next/navigation"
import { channelLabel, type InboxContact, type ContactMessage, type ContactMessagesPage } from "@/lib/inbox-api"
import { AiAssistPanel } from "./AiAssistPanel"
import { subscribeAssistOpen, getAssistOpen, setAssistOpen } from "@/lib/assist-open"

const PAGE_SIZE = 30

interface Props {
  contact: InboxContact
  initialPage: ContactMessagesPage
  currentUserId: string
  botEnabled: boolean
}

export function ContactThreadView({ contact, initialPage, currentUserId, botEnabled }: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const convId = contact.current_conversation_id
  const [messages, setMessages] = useState<ContactMessage[]>(initialPage.messages)
  const [nextCursor, setNextCursor] = useState(initialPage.next_cursor)
  const [hasMore, setHasMore] = useState(initialPage.has_more)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [mode, setMode] = useState<"bot" | "human">(contact.mode)
  // Status de la sesión actual. Local para reflejar en vivo el "Asignarme" (reabre → active) sin recargar.
  const [status, setStatus] = useState<"active" | "closed">(contact.status)
  // Operador asignado (local, para reflejar en vivo el "Asignarme" sin recargar). Cualquiera
  // puede responder cualquier conversación; esto solo permite pasártela a tu nombre para que
  // quede claro (en la lista y en el chip) que ahora la seguís vos.
  const [assignedOperatorId, setAssignedOperatorId] = useState<string | null>(contact.assigned_operator_id)
  const [reply, setReply] = useState("")
  const [sendError, setSendError] = useState("")
  // Presupuesto pendiente de confirmar cuando "Enviar al canal" pisaría un borrador en curso.
  const [pendingBudget, setPendingBudget] = useState<string | null>(null)
  // Sugerencia pendiente de confirmar cuando el "Copiar" del copiloto pisaría un borrador en curso.
  const [pendingSuggestion, setPendingSuggestion] = useState<string | null>(null)
  // Texto original que se insertó desde el copiloto (ver plan copiar-a-draft). Se conserva para
  // comparar al enviar y clasificar el envío como 'as-is' | 'edited'. Es un ref para no
  // dispararle rerenders al operador mientras edita.
  const draftFromCopilot = useRef<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  // Precarga del hilo del copiloto: se dispara al pasar el mouse (o tabular) por el botón.
  const [assistPrefetch, setAssistPrefetch] = useState(false)

  // Si el copiloto quedó abierto, sigue abierto en la próxima conversación (ver assist-open.ts).
  const assistOpen = useSyncExternalStore(subscribeAssistOpen, getAssistOpen, () => false)
  const toggleAssist = setAssistOpen
  // Ancho del panel del copiloto (px), arrastrable desde la barra divisoria. Se recuerda en
  // localStorage. Inicializador lazy (SSR-safe): el panel arranca cerrado, así que no hay mismatch.
  const [assistWidth, setAssistWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 380
    const saved = Number(window.localStorage.getItem("assistWidth"))
    return saved >= 320 && saved <= 760 ? saved : 380
  })
  // Alto del área de escritura (px), arrastrable desde la barra superior del compose. Se recuerda
  // en localStorage. Inicializador lazy (SSR-safe): default ≈ 2 filas.
  const [composeHeight, setComposeHeight] = useState<number>(() => {
    if (typeof window === "undefined") return 56
    const saved = Number(window.localStorage.getItem("composeHeight"))
    return saved >= 56 && saved <= 320 ? saved : 56
  })

  // Arrastre de la barra divisoria: el panel está pegado al borde derecho, así que su ancho es
  // (ancho de ventana − X del mouse). Se acota entre 320 y 760px y se persiste al soltar.
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, 320), 760)
      setAssistWidth(w)
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      setAssistWidth((w) => {
        localStorage.setItem("assistWidth", String(w))
        return w
      })
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  // Arrastre de la barra superior del compose: arrastrar hacia arriba agranda el área de escritura.
  // Como el compose está anclado abajo, el alto es (Y inicial − Y del mouse) + alto inicial. Se acota
  // entre 56 y 320px y se persiste al soltar.
  function startResizeCompose(e: React.MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = composeHeight
    const onMove = (ev: MouseEvent) => {
      const h = Math.min(Math.max(startH + (startY - ev.clientY), 56), 320)
      setComposeHeight(h)
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      setComposeHeight((h) => {
        localStorage.setItem("composeHeight", String(h))
        return h
      })
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // Compose textarea: el copiloto prefila acá el texto de una budget card ("Enviar al canal").
  const replyRef = useRef<HTMLTextAreaElement>(null)
  // Altura previa al prepend de histórico, para restaurar la posición de scroll.
  const prependHeight = useRef<number | null>(null)
  // ¿El usuario está pegado al fondo? Si sí, autoscrolleamos al llegar mensajes nuevos.
  const stickBottom = useRef(true)

  // Merge de mensajes recientes en `prev`, preservando el histórico ya cargado (dedup por id).
  function mergeRecent(prev: ContactMessage[], recent: ContactMessage[]): ContactMessage[] {
    const recentIds = new Set(recent.map((m) => m.id))
    return [...prev.filter((m) => !recentIds.has(m.id)), ...recent]
  }

  // Polling de la primera página (lo reciente) cada 5s.
  useEffect(() => {
    const interval = setInterval(async () => {
      // `no-store`: evita que el navegador sirva del cache el mismo GET en cada poll y deje
      // el thread sin mensajes nuevos hasta un reload.
      const res = await fetch(`/api/admin/inbox/contacts/${contact.end_user_id}/messages?limit=${PAGE_SIZE}`, { cache: "no-store" })
      if (!res.ok) return
      const page: ContactMessagesPage = await res.json()
      setMessages((prev) => mergeRecent(prev, page.messages))
    }, 5_000)
    return () => clearInterval(interval)
  }, [contact.end_user_id])

  // Scroll: preservar posición al prepender histórico; si no, pegarse al fondo.
  useEffect(() => {
    const el = containerRef.current
    if (prependHeight.current != null && el) {
      el.scrollTop = el.scrollHeight - prependHeight.current
      prependHeight.current = null
      return
    }
    if (stickBottom.current) bottomRef.current?.scrollIntoView()
  }, [messages])

  async function loadOlder() {
    if (!hasMore || loadingOlder || nextCursor == null) return
    setLoadingOlder(true)
    try {
      const res = await fetch(`/api/admin/inbox/contacts/${contact.end_user_id}/messages?limit=${PAGE_SIZE}&before=${nextCursor}`)
      if (!res.ok) return
      const page: ContactMessagesPage = await res.json()
      if (containerRef.current) prependHeight.current = containerRef.current.scrollHeight
      setMessages((prev) => [...page.messages, ...prev])
      setNextCursor(page.next_cursor)
      setHasMore(page.has_more)
    } finally {
      setLoadingOlder(false)
    }
  }

  function onScroll() {
    const el = containerRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 60) loadOlder()
  }

  async function toggleMode() {
    if (!convId) return
    const next = mode === "bot" ? "human" : "bot"
    const res = await fetch(`/api/admin/inbox/${convId}/mode`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: next }),
    })
    if (!res.ok) return
    setMode(next)
    // Al tomar la conversación: se reabre la sesión (el back la pasa a 'active') y se
    // asigna al operador actual. Así, si estaba finalizada, el próximo mensaje del cliente
    // sigue en ESTA conversación en vez de arrancar una nueva.
    if (next === "human") {
      setStatus("active")
      setAssignedOperatorId(currentUserId)
      await fetch(`/api/admin/inbox/${convId}/assign`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorId: currentUserId }),
      })
    }
    // Cambió el modo (y quizá el dueño): la copia cacheada de la lista quedó vieja.
    router.refresh()
  }

  // Pasar la conversación a tu nombre aunque ya la tenga otro operador (o esté sin asignar en
  // la cola). No bloquea a nadie —cualquiera puede seguir respondiendo—, solo cambia el dueño
  // visible: al reasignar, el chip pasa a "Asignado a vos" y el operador anterior lo ve.
  async function handleAssignToMe() {
    if (!convId) return
    const res = await fetch(`/api/admin/inbox/${convId}/assign`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorId: currentUserId }),
    })
    if (!res.ok) {
      toast({ title: "No se pudo asignar la conversación", tone: "danger" })
      return
    }
    setAssignedOperatorId(currentUserId)
    setMode("human")
    setStatus("active")
    // Cambió el dueño visible: la copia cacheada de la lista quedó vieja.
    router.refresh()
    toast({ title: "Te asignaste la conversación", tone: "success" })
  }

  async function handleArchive() {
    if (!convId) return
    setArchiving(true)
    try {
      const res = await fetch(`/api/admin/inbox/${convId}/archive`, { method: "POST" })
      if (!res.ok) {
        toast({ title: "No se pudo finalizar la conversación", tone: "danger" })
        return
      }
      toast({ title: "Conversación finalizada", description: "Vuelve a modo bot y queda sin asignar.", tone: "success" })
      // Invalida el Client Cache ANTES de volver: si no, la lista sale de la copia cacheada
      // (staleTimes.dynamic en next.config.ts) y la conversación recién finalizada seguiría
      // apareciendo hasta el próximo poll, como si la acción no se hubiera guardado.
      router.refresh()
      router.push("/admin/inbox")
    } finally {
      setArchiving(false)
    }
  }

  // Prefila el compose con el presupuesto serializado y lo enfoca. NO auto-envía.
  function applyBudgetToCompose(text: string) {
    setReply(text)
    // Un presupuesto NO cuenta para la métrica del copiloto (as-is/edited): esa mide solo las
    // respuestas de texto insertadas desde el "Copiar". Limpiamos por si venía activa.
    draftFromCopilot.current = null
    // El textarea solo existe en modo humano + ventana abierta; el focus se aplica si está montado.
    requestAnimationFrame(() => replyRef.current?.focus())
  }

  // "Enviar al canal" desde una budget card del copiloto (design #66). Si ya hay un borrador en
  // curso, pedimos confirmación (Dialog del design system) antes de pisarlo; si está vacío, entra
  // directo.
  function handleSendToChannel(text: string) {
    if (reply.trim()) {
      setPendingBudget(text)
      return
    }
    applyBudgetToCompose(text)
  }

  // Inserta una sugerencia del copiloto (botón "Copiar") en el compose. Guarda el texto original
  // para clasificar el envío como 'as-is' o 'edited'. Misma UX que "Enviar al canal": si hay algo
  // escrito, pedimos confirmación antes de pisarlo.
  function applySuggestionToCompose(text: string) {
    setReply(text)
    draftFromCopilot.current = text
    requestAnimationFrame(() => replyRef.current?.focus())
  }
  function handleUseSuggestion(text: string) {
    if (reply.trim()) {
      setPendingSuggestion(text)
      return
    }
    applySuggestionToCompose(text)
  }

  // Envío optimista: la burbuja aparece EN EL INSTANTE con estilo "pending" y el textarea se
  // limpia; el POST corre en background. Sale con id real siempre (ai-api persiste el mensaje
  // aunque el envío al canal falle, con delivery_status='failed'): reemplazamos el temp id por
  // el real y, si falló el envío, la burbuja pasa al flujo server-side "no entregado" con los
  // botones Reintentar (/retry) y Cancelar (/dismiss). Sin lockear el botón: cada Enter genera
  // su propio temp id, imposible de duplicar (el textarea se limpia al toque).
  //
  // Los 4xx con `error` (window_closed / no_recipient / channel_not_configured) son
  // deterministas y NO persistieron el mensaje: no hay id → sacamos la burbuja temp y avisamos.
  async function postReply(text: string, tempId: string, suggestion: string | null): Promise<void> {
    try {
      const res = await fetch(`/api/admin/inbox/${convId}/reply`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      })
      const body = await res.json().catch(() => ({} as {
        id?: string
        ok?: boolean
        delivery_status?: string
        error?: string
      }))

      if (res.ok && body.id) {
        const failed = body.delivery_status === "failed"
        setMessages((prev) => prev.map((m) => {
          if (m.id !== tempId) return m
          return { ...m, id: body.id!, pending: false, delivery_status: failed ? "failed" : null }
        }))
        if (failed) {
          toast({ title: "No se entregó al cliente", description: "Podés reintentar desde la burbuja.", tone: "danger" })
          return
        }
        // Telemetría del copiloto: si el mensaje venía del "Copiar", medimos as-is/edited.
        if (suggestion !== null) {
          const outcome = text === suggestion.trim() ? "as-is" : "edited"
          void fetch(`/api/admin/inbox/copilot-draft-events`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversation_id: convId, outcome }),
          })
        }
        return
      }

      // Sin id → el mensaje NO se persistió. Sacamos la burbuja temp y toast con la razón.
      setMessages((prev) => prev.filter((m) => m.id !== tempId))
      if (body.error === "window_closed") {
        toast({ title: "Ventana cerrada", description: "La ventana de 24h de WhatsApp está cerrada. El cliente debe escribirte primero.", tone: "danger" })
      } else {
        toast({ title: "No se pudo enviar", description: "Volvé a escribirlo e intentá de nuevo.", tone: "danger" })
      }
    } catch {
      // Error de red del navegador: no sabemos si ai-api llegó a persistir. Sacamos la burbuja
      // temp (no tenemos id real para reintentar server-side) y avisamos. Si el mensaje SÍ se
      // persistió del otro lado, el próximo poll lo trae con delivery_status='failed' y el
      // operador ve la burbuja con Reintentar/Cancelar normalmente.
      setMessages((prev) => prev.filter((m) => m.id !== tempId))
      toast({ title: "Sin conexión", description: "No se pudo confirmar el envío. Volvé a escribirlo.", tone: "danger" })
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const text = reply.trim()
    if (!text || !convId) return

    // Insert optimista + limpieza inmediata del compose. `stickBottom` fuerza autoscroll para que
    // la burbuja recién agregada quede visible aunque el operador venía scrolleando arriba.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const tempMessage: ContactMessage = {
      id: tempId, conversation_id: convId, role: "assistant", source: "human",
      text, created_at: new Date().toISOString(), delivery_status: null, pending: true,
      client_key: tempId,
    }
    setMessages((prev) => [...prev, tempMessage])
    stickBottom.current = true

    const suggestion = draftFromCopilot.current
    draftFromCopilot.current = null
    setReply("")
    setSendError("")

    void postReply(text, tempId, suggestion)
  }

  async function handleRetry(message: ContactMessage): Promise<boolean> {
    const res = await fetch(`/api/admin/inbox/${message.conversation_id}/messages/${message.id}/retry`, {
      method: "POST",
    })
    if (res.ok) {
      // Entregado: sacamos la marca de "no entregado" de esa burbuja.
      setMessages((prev) => prev.map((m) => m.id === message.id ? { ...m, delivery_status: null, delivery_dismissed_at: null } : m))
      // El flag del inbox depende del backend, refrescamos la ruta para que la lista se
      // reevalue con has_failed_outbound=false. router.refresh() invalida el Client Cache.
      router.refresh()
      toast({ title: "Mensaje reenviado", description: "El cliente ya lo recibió.", tone: "success" })
      return true
    }
    const body = await res.json().catch(() => ({}))
    toast({
      title: "No se pudo reenviar",
      description: body.error === "window_closed"
        ? "La ventana de 24h está cerrada. El cliente debe escribirte primero."
        : "Intentá de nuevo en unos segundos.",
      tone: "danger",
    })
    return false
  }

  // Descarta una burbuja fallida: el operador la da por perdida (p. ej. el cliente ya escribió
  // otra cosa y este mensaje quedó obsoleto). Se marca localmente con delivery_dismissed_at y
  // el badge "Falló envío" del inbox desaparece en el próximo poll (o al refrescar la ruta).
  async function handleDismiss(message: ContactMessage): Promise<boolean> {
    const res = await fetch(`/api/admin/inbox/${message.conversation_id}/messages/${message.id}/dismiss`, {
      method: "POST",
    })
    if (res.ok) {
      const now = new Date().toISOString()
      setMessages((prev) => prev.map((m) => m.id === message.id ? { ...m, delivery_dismissed_at: now } : m))
      router.refresh()
      toast({ title: "Mensaje cancelado", description: "Ya no se va a reintentar.", tone: "success" })
      return true
    }
    toast({ title: "No se pudo cancelar", description: "Intentá de nuevo en unos segundos.", tone: "danger" })
    return false
  }

  return (
    <div className="flex h-full">
      {/* Columna principal: la conversación. Se achica cuando el copiloto está abierto. */}
      <div className="flex flex-col h-full flex-1 min-w-0">
      {/* Header. En mobile envuelve (flex-wrap) para que las acciones bajen a otra línea en vez
          de desbordar, y deja padding-left para el botón hamburguesa flotante del SideNav. */}
      <div
        className="flex items-center gap-3 px-3 md:px-5 py-3 shrink-0 flex-wrap gap-y-2"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)" }}
      >
        <Link href="/admin/inbox">
          <Button variant="ghost" size="icon" aria-label="Volver">
            <ArrowLeft size={16} strokeWidth={1.6} />
          </Button>
        </Link>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--ink)" }}>{contact.contact}</p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            {channelLabel(contact.channel)}
            {contact.phone && contact.phone !== contact.contact
              ? ` · ${contact.phone}`
              : <span style={{ color: "var(--ink-faint)" }}> · sin identificador</span>}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end ml-auto">
          {/* Dueño actual (informativo, va primero): quién tiene asignada la conversación
              cuando la tiene otro operador. El botón para tomarla va con las demás acciones. */}
          {mode === "human" && assignedOperatorId !== currentUserId && contact.assigned_operator_name && (
            <Badge tone="success" className="flex items-center gap-1">
              <User size={9} />
              Asignada a {contact.assigned_operator_name}
            </Badge>
          )}

          {/* Copiloto de IA del operador (ADR 0007): disponible siempre, incluso con la ventana
              cerrada (sirve para preparar un presupuesto antes de que el cliente reescriba). */}
          {/* En mobile mostramos solo el ícono para no reventar el header (que ya tiene back,
              nombre, teléfono y "Finalizar"). En sm+ se ve el label completo. */}
          <Button
            variant={assistOpen ? "primary" : "secondary"}
            size="sm"
            onClick={() => toggleAssist(!assistOpen)}
            onMouseEnter={() => setAssistPrefetch(true)}
            onFocus={() => setAssistPrefetch(true)}
            title="Asistente IA"
            aria-label="Asistente IA"
            className="flex items-center gap-1.5 rounded-full"
          >
            <Sparkles size={11} strokeWidth={1.6} />
            <span className="hidden sm:inline">Asistente IA</span>
          </Button>

          {!contact.within_window && <Badge tone="warning">Ventana cerrada</Badge>}

          {/* Acciones manuales solo en conversaciones activas (dentro de la ventana). Con la
              ventana cerrada no se puede responder, así que se ocultan; las vencidas (+24h)
              las cierra el cron de auto-cierre. */}
          {contact.within_window && (
            <>
              {mode === "bot" && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={toggleMode}
                  disabled={!convId}
                  title={botEnabled ? "Bot activo · Asignarme" : "Sin asignar · Asignarme"}
                  aria-label={botEnabled ? "Asignarme (bot activo)" : "Asignarme (sin asignar)"}
                  className="flex items-center gap-1.5 rounded-full"
                >
                  {botEnabled ? <Bot size={11} /> : <User size={11} />}
                  <span className="hidden sm:inline">
                    {botEnabled ? "Bot activo · Asignarme" : "Sin asignar · Asignarme"}
                  </span>
                  <span className="sm:hidden">Asignarme</span>
                </Button>
              )}

              {/* Modo humano pero la tiene otro operador (o está sin asignar en la cola): se
                  puede pasar a tu nombre. No bloquea a nadie; solo cambia el dueño visible. */}
              {mode === "human" && assignedOperatorId !== currentUserId && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleAssignToMe}
                  disabled={!convId}
                  title="Pasar esta conversación a tu nombre"
                  aria-label="Asignarme"
                  className="flex items-center gap-1.5 rounded-full"
                >
                  <UserPlus size={11} strokeWidth={1.6} />
                  <span className="hidden sm:inline">Asignarme</span>
                </Button>
              )}

              {/* No ofrecemos "Finalizar" sobre una sesión ya finalizada. */}
              {status !== "closed" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleArchive}
                disabled={archiving || !convId}
                title="Finalizar conversación"
                aria-label="Finalizar conversación"
                className="flex items-center gap-1.5 rounded-full"
              >
                <CheckCheck size={11} strokeWidth={1.6} />
                <span className="hidden sm:inline">Finalizar</span>
              </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Mensajes (thread mergeado, con divisores por sesión + scroll infinito) */}
      <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {loadingOlder && (
          <p className="text-[11px] text-center" style={{ color: "var(--ink-faint)" }}>Cargando historial…</p>
        )}
        {!hasMore && messages.length > 0 && (
          <p className="text-[11px] text-center" style={{ color: "var(--ink-faint)" }}>— inicio de la conversación —</p>
        )}
        {messages.map((msg, i) => {
          const prev = messages[i - 1]
          const newSession = !prev || prev.conversation_id !== msg.conversation_id
          return (
            <div key={msg.client_key ?? msg.id} className="flex flex-col gap-3">
              {newSession && <SessionDivider date={msg.created_at} />}
              <MessageBubble message={msg} onRetry={handleRetry} onDismiss={handleDismiss} />
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input de respuesta */}
      <div
        className="shrink-0 px-5 py-3"
        style={{ borderTop: "1px solid var(--border)", background: "var(--bg)" }}
      >
        {mode === "bot" && !botEnabled ? (
          // Kill switch activo: el bot NO está atendiendo. No decimos "el bot responde"
          // (sería engañoso); avisamos que quedó sin atender y hay que tomarla.
          <p className="text-xs text-center py-1" style={{ color: "var(--amber)" }}>
            {contact.within_window
              ? 'El bot está pausado — nadie la está atendiendo. Hacé click en "Asignarme" para responder vos.'
              : "El bot está pausado — esta conversación quedó sin atender."}
          </p>
        ) : mode === "bot" ? (
          <p className="text-xs text-center py-1" style={{ color: "var(--ink-faint)" }}>
            {contact.within_window
              ? 'El bot está respondiendo. Hacé click en "Asignarme" para responder vos.'
              : "El bot está respondiendo esta conversación."}
          </p>
        ) : !contact.within_window ? (
          <p className="text-xs text-center py-1" style={{ color: "var(--amber)" }}>
            Ventana de 24h cerrada — el cliente debe enviarte un mensaje para reabrir la ventana.
          </p>
        ) : (
          <form onSubmit={handleSend} className="flex flex-col -mt-2">
            {/* Barra arrastrable: redimensiona el alto del área de escritura (arrastrar ↕). */}
            <div
              onMouseDown={startResizeCompose}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Redimensionar área de escritura"
              className="flex items-center justify-center cursor-row-resize group max-md:hidden"
              style={{ height: 12 }}
            >
              <div
                className="transition-colors"
                style={{ width: 28, height: 2, borderRadius: 999, background: "var(--border)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ink-faint)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--border)")}
              />
            </div>
            <div className="flex gap-2">
              <Textarea
                ref={replyRef}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Escribí tu respuesta..."
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e as unknown as React.FormEvent) }
                }}
                className="flex-1 resize-none"
                style={{ height: composeHeight }}
              />
              <Button type="submit" size="icon" disabled={!reply.trim()} className="self-end">
                <Send size={16} strokeWidth={1.6} />
              </Button>
            </div>
          </form>
        )}
        {sendError && <p className="text-xs mt-2 text-danger">{sendError}</p>}
      </div>
      </div>

      {/* Barra divisoria arrastrable: redimensiona conversación ↔ copiloto. */}
      {assistOpen && (
        <div
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionar panel del asistente"
          className="shrink-0 cursor-col-resize transition-colors max-md:hidden"
          style={{ width: 5, background: "var(--border)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--blue)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--border)")}
        />
      )}

      {/* Copiloto de IA, en flujo al costado: la conversación se achica, no se tapa. */}
      <AiAssistPanel
        open={assistOpen}
        prefetch={assistPrefetch}
        onClose={() => toggleAssist(false)}
        endUserId={contact.end_user_id}
        contactName={contact.contact}
        width={assistWidth}
        lastInboundAt={contact.last_inbound_at}
        withinWindow={contact.within_window}
        onSendToChannel={handleSendToChannel}
        onUseSuggestion={handleUseSuggestion}
      />

      <Dialog
        open={pendingBudget !== null}
        onOpenChange={(open) => { if (!open) setPendingBudget(null) }}
        size="sm"
        title="Reemplazar el mensaje"
        description="Ya tenés un mensaje escrito en el compose. ¿Querés reemplazarlo por el presupuesto?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingBudget(null)}>Cancelar</Button>
            <Button
              onClick={() => {
                if (pendingBudget !== null) applyBudgetToCompose(pendingBudget)
                setPendingBudget(null)
              }}
            >
              Reemplazar
            </Button>
          </>
        }
      />

      <Dialog
        open={pendingSuggestion !== null}
        onOpenChange={(open) => { if (!open) setPendingSuggestion(null) }}
        size="sm"
        title="Reemplazar el mensaje"
        description="Ya tenés un mensaje escrito en el compose. ¿Querés reemplazarlo por la sugerencia del asistente?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingSuggestion(null)}>Cancelar</Button>
            <Button
              onClick={() => {
                if (pendingSuggestion !== null) applySuggestionToCompose(pendingSuggestion)
                setPendingSuggestion(null)
              }}
            >
              Reemplazar
            </Button>
          </>
        }
      />
    </div>
  )
}

function SessionDivider({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
      <span className="text-[10px] px-2 whitespace-nowrap" suppressHydrationWarning style={{ color: "var(--ink-faint)" }}>
        Sesión · {formatDate(date)}
      </span>
      <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
    </div>
  )
}

function MessageBubble({ message, onRetry, onDismiss }: {
  message: ContactMessage
  onRetry: (m: ContactMessage) => Promise<boolean>
  onDismiss: (m: ContactMessage) => Promise<boolean>
}) {
  const isOutbound = message.role === "assistant"
  const isHuman = message.source === "human"
  const isBot = message.source === "bot"
  // Estados excluyentes (en orden de prioridad):
  //   pending = envío optimista todavía en vuelo (sin respuesta del POST)
  //   dismissed = falla server-side descartada por el operador
  //   failed = falla server-side pendiente de resolver
  const pending = !!message.pending
  const dismissed = message.delivery_status === "failed" && !!message.delivery_dismissed_at && !pending
  const failed = message.delivery_status === "failed" && !dismissed && !pending
  const [retrying, setRetrying] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  async function retry() {
    setRetrying(true)
    try { await onRetry(message) } finally { setRetrying(false) }
  }

  async function dismiss() {
    setDismissing(true)
    try { await onDismiss(message) } finally { setDismissing(false) }
  }

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%] md:max-w-[70%]">
        {isOutbound && (
          <p className="text-[10px] mb-1 text-right" style={{ color: "var(--ink-faint)" }}>
            {isHuman ? "Operador" : isBot ? "Bot" : "Asistente"}
          </p>
        )}
        <div
          className="px-3 py-2 rounded-[var(--radius)] text-sm"
          style={{
            background: dismissed
              ? "var(--card)"
              : isOutbound ? (isHuman ? "var(--green)" : "var(--blue)") : "var(--card)",
            color: dismissed ? "var(--ink-soft)" : isOutbound ? "#fff" : "var(--ink)",
            border: failed
              ? "1px solid var(--color-danger)"
              : dismissed
                ? "1px dashed var(--border)"
                : isOutbound ? "none" : "1px solid var(--border)",
            opacity: pending ? 0.65 : failed ? 0.85 : dismissed ? 0.7 : 1,
            textDecoration: dismissed ? "line-through" : "none",
          }}
        >
          {message.text}
        </div>
        {(pending || (!failed && !dismissed)) ? (
          // Un solo <p> para "Enviando..." y para la hora: solo cambia el contenido. Evita
          // que React desmonte el nodo al pasar de pending a sent (fuente del salto visual).
          <p className="text-[10px] mt-1 flex items-center gap-1" suppressHydrationWarning style={{ color: "var(--ink-faint)", justifyContent: isOutbound ? "flex-end" : "flex-start" }}>
            {pending && <Clock size={10} className="animate-pulse" />}
            {pending ? "Enviando..." : formatTime(message.created_at)}
          </p>
        ) : failed ? (
          <div className="flex items-center gap-2 mt-1 justify-end flex-wrap">
            <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--color-danger)" }}>
              <AlertTriangle size={11} /> No entregado al cliente
            </span>
            <button
              onClick={retry}
              disabled={retrying || dismissing}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors"
              style={{ color: "var(--blue)", background: "var(--blue-soft)" }}
            >
              <RefreshCw size={10} className={retrying ? "animate-spin" : ""} />
              {retrying ? "Reenviando..." : "Reintentar"}
            </button>
            <button
              onClick={dismiss}
              disabled={retrying || dismissing}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors"
              style={{ color: "var(--ink-soft)", background: "var(--border)" }}
              title="Descartar este mensaje sin reintentar"
            >
              <X size={10} />
              {dismissing ? "Cancelando..." : "Cancelar"}
            </button>
          </div>
        ) : dismissed ? (
          <p className="text-[10px] mt-1" style={{ color: "var(--ink-faint)", textAlign: isOutbound ? "right" : "left" }}>
            No entregado · cancelado
          </p>
        ) : null}
      </div>
    </div>
  )
}

// TZ y hour12 pineados: sin esto el server (UTC en Vercel) y el cliente (-03) rendean
// horarios distintos, y el marcador "a. m./p. m." trae U+202F que ICU-node y el browser
// muestran distinto. Cada mismatch por burbuja hace fallback a client-only render y rompe
// la soft-navigation del App Router al entrar/salir de una conversación.
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" })
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" })
}
