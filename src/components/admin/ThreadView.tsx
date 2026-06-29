"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Send, CheckCheck, Bot, User } from "lucide-react"
import { Button, Badge, Textarea } from "@myd-org/ui"
import { useRouter } from "next/navigation"
import type { InboxConversation, InboxMessage } from "@/lib/inbox-api"

interface Props {
  conversation: InboxConversation
  initialMessages: InboxMessage[]
  currentUserId: string
}

export function ThreadView({ conversation, initialMessages, currentUserId }: Props) {
  const router = useRouter()
  const [messages, setMessages] = useState(initialMessages)
  const [mode, setMode] = useState<"bot" | "human">(conversation.mode)
  const [withinWindow, setWithinWindow] = useState(conversation.within_window)
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState("")
  const [archiving, setArchiving] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch(`/api/admin/inbox/${conversation.id}/messages`)
      if (res.ok) setMessages(await res.json())
    }, 5_000)
    return () => clearInterval(interval)
  }, [conversation.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  async function handleArchive() {
    setArchiving(true)
    try {
      await fetch(`/api/admin/inbox/${conversation.id}/archive`, { method: "POST" })
      router.push("/admin/inbox")
    } finally {
      setArchiving(false)
    }
  }

  async function toggleMode() {
    const next = mode === "bot" ? "human" : "bot"
    const res = await fetch(`/api/admin/inbox/${conversation.id}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: next }),
    })
    if (!res.ok) return
    setMode(next)
    // Al tomar la conversación, asignársela al operador actual.
    if (next === "human") {
      await fetch(`/api/admin/inbox/${conversation.id}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorId: currentUserId }),
      })
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!reply.trim() || sending) return
    setSendError("")
    setSending(true)
    try {
      const res = await fetch(`/api/admin/inbox/${conversation.id}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: reply.trim() }),
      })
      if (res.ok) {
        setReply("")
        const msgRes = await fetch(`/api/admin/inbox/${conversation.id}/messages`)
        if (msgRes.ok) setMessages(await msgRes.json())
      } else {
        const body = await res.json()
        if (body.error === "window_closed") {
          setSendError("La ventana de 24h de WhatsApp está cerrada. El cliente debe enviarte un mensaje primero.")
          setWithinWindow(false)
        } else {
          setSendError("No se pudo enviar el mensaje. Intentá de nuevo.")
        }
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
          <p className="text-sm font-semibold truncate" style={{ color: "var(--ink)" }}>{conversation.contact}</p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>WhatsApp</p>
        </div>

        <div className="flex items-center gap-2">
          {!withinWindow && <Badge tone="warning">Ventana cerrada</Badge>}

          {/* Acciones manuales solo en conversaciones activas (dentro de la ventana). Con la
              ventana cerrada no se puede responder, así que se ocultan; las vencidas (+24h)
              las cierra el cron de auto-cierre. */}
          {withinWindow && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={toggleMode}
                className="flex items-center gap-1.5 rounded-full"
              >
                {mode === "human" ? <User size={11} /> : <Bot size={11} />}
                {mode === "human" ? "Operador · Devolver al bot" : "Bot activo · Tomar"}
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={handleArchive}
                disabled={archiving}
                className="flex items-center gap-1.5 rounded-full"
              >
                <CheckCheck size={11} strokeWidth={1.6} />
                Finalizar
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Mensajes */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input de respuesta */}
      <div
        className="shrink-0 px-5 py-3"
        style={{ borderTop: "1px solid var(--border)", background: "var(--card)" }}
      >
        {mode === "bot" ? (
          <p className="text-xs text-center py-1" style={{ color: "var(--ink-faint)" }}>
            {withinWindow
              ? 'El bot está respondiendo. Hacé click en "Tomar" para responder vos.'
              : "El bot está respondiendo esta conversación."}
          </p>
        ) : !withinWindow ? (
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
            <Button
              type="submit"
              size="icon"
              disabled={!reply.trim() || sending}
              className="self-end"
            >
              <Send size={16} strokeWidth={1.6} />
            </Button>
          </form>
        )}
        {sendError && (
          <p className="text-xs mt-2 text-danger">{sendError}</p>
        )}
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: InboxMessage }) {
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
  const d = new Date(iso)
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
}
