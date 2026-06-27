"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Bot, User, Send, CheckCheck } from "lucide-react"
import { Button, Badge, Textarea } from "@myd-org/ui"
import { useRouter } from "next/navigation"
import type { InboxContact, ContactMessage, ContactMessagesPage } from "@/lib/inbox-api"

const PAGE_SIZE = 30

interface Props {
  contact: InboxContact
  initialPage: ContactMessagesPage
  currentUserId: string
}

export function ContactThreadView({ contact, initialPage, currentUserId }: Props) {
  const router = useRouter()
  const convId = contact.current_conversation_id
  const [messages, setMessages] = useState<ContactMessage[]>(initialPage.messages)
  const [nextCursor, setNextCursor] = useState(initialPage.next_cursor)
  const [hasMore, setHasMore] = useState(initialPage.has_more)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [mode, setMode] = useState<"bot" | "human">(contact.mode)
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState("")
  const [archiving, setArchiving] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
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
      const res = await fetch(`/api/admin/inbox/contacts/${contact.end_user_id}/messages?limit=${PAGE_SIZE}`)
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
    // Al tomar la conversación, asignársela al operador actual.
    if (next === "human") {
      await fetch(`/api/admin/inbox/${convId}/assign`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorId: currentUserId }),
      })
    }
  }

  async function handleArchive() {
    if (!convId) return
    setArchiving(true)
    try {
      await fetch(`/api/admin/inbox/${convId}/archive`, { method: "POST" })
      router.push("/admin/inbox")
    } finally {
      setArchiving(false)
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!reply.trim() || sending || !convId) return
    setSendError("")
    setSending(true)
    try {
      const res = await fetch(`/api/admin/inbox/${convId}/reply`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: reply.trim() }),
      })
      if (res.ok) {
        setReply("")
        stickBottom.current = true
        const msgRes = await fetch(`/api/admin/inbox/contacts/${contact.end_user_id}/messages?limit=${PAGE_SIZE}`)
        if (msgRes.ok) {
          const page: ContactMessagesPage = await msgRes.json()
          setMessages((prev) => mergeRecent(prev, page.messages))
        }
      } else {
        const body = await res.json().catch(() => ({}))
        setSendError(body.error === "window_closed"
          ? "La ventana de 24h de WhatsApp está cerrada. El cliente debe enviarte un mensaje primero."
          : "No se pudo enviar el mensaje. Intentá de nuevo.")
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-5 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--card)" }}
      >
        <Link href="/admin/inbox">
          <Button variant="ghost" size="icon" aria-label="Volver">
            <ArrowLeft size={16} strokeWidth={1.6} />
          </Button>
        </Link>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--ink)" }}>{contact.contact}</p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            WhatsApp{contact.phone && contact.phone !== contact.contact ? ` · ${contact.phone}` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!contact.within_window && <Badge tone="warning">Ventana cerrada</Badge>}

          <Button
            variant="secondary"
            size="sm"
            onClick={toggleMode}
            disabled={!convId}
            className="flex items-center gap-1.5 rounded-full"
          >
            {mode === "human" ? <User size={11} /> : <Bot size={11} />}
            {mode === "human" ? "Operador · Devolver al bot" : "Bot activo · Tomar"}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleArchive}
            disabled={archiving || !convId}
            className="flex items-center gap-1.5 rounded-full"
          >
            <CheckCheck size={11} strokeWidth={1.6} />
            Finalizar
          </Button>
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
            <div key={msg.id} className="flex flex-col gap-3">
              {newSession && <SessionDivider date={msg.created_at} />}
              <MessageBubble message={msg} />
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input de respuesta */}
      <div
        className="shrink-0 px-5 py-3"
        style={{ borderTop: "1px solid var(--border)", background: "var(--card)" }}
      >
        {mode === "bot" ? (
          <p className="text-xs text-center py-1" style={{ color: "var(--ink-faint)" }}>
            El bot está respondiendo. Hacé click en &quot;Tomar&quot; para responder vos.
          </p>
        ) : !contact.within_window ? (
          <p className="text-xs text-center py-1" style={{ color: "var(--amber)" }}>
            Ventana de 24h cerrada — el cliente debe enviarte un mensaje para reabrir la ventana.
          </p>
        ) : (
          <form onSubmit={handleSend} className="flex gap-2">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Escribí tu respuesta..."
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e as unknown as React.FormEvent) }
              }}
              className="flex-1 resize-none"
            />
            <Button type="submit" size="icon" disabled={!reply.trim() || sending} className="self-end">
              <Send size={16} strokeWidth={1.6} />
            </Button>
          </form>
        )}
        {sendError && <p className="text-xs mt-2 text-danger">{sendError}</p>}
      </div>
    </div>
  )
}

function SessionDivider({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
      <span className="text-[10px] px-2 whitespace-nowrap" style={{ color: "var(--ink-faint)" }}>
        Sesión · {formatDate(date)}
      </span>
      <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
    </div>
  )
}

function MessageBubble({ message }: { message: ContactMessage }) {
  const isOutbound = message.role === "assistant"
  const isHuman = message.source === "human"
  const isBot = message.source === "bot"

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[70%]">
        {isOutbound && (
          <p className="text-[10px] mb-1 text-right" style={{ color: "var(--ink-faint)" }}>
            {isHuman ? "Operador" : isBot ? "Bot" : "Asistente"}
          </p>
        )}
        <div
          className="px-3 py-2 rounded-[var(--radius)] text-sm"
          style={{
            background: isOutbound ? (isHuman ? "var(--green)" : "var(--blue)") : "var(--card)",
            color: isOutbound ? "#fff" : "var(--ink)",
            border: isOutbound ? "none" : "1px solid var(--border)",
          }}
        >
          {message.text}
        </div>
        <p className="text-[10px] mt-1" style={{ color: "var(--ink-faint)", textAlign: isOutbound ? "right" : "left" }}>
          {formatTime(message.created_at)}
        </p>
      </div>
    </div>
  )
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })
}
