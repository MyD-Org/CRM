"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Bot, User, Send } from "lucide-react"
import type { InboxConversation, InboxMessage } from "@/lib/inbox-api"

interface Props {
  conversation: InboxConversation
  initialMessages: InboxMessage[]
}

export function ThreadView({ conversation, initialMessages }: Props) {
  const [messages, setMessages] = useState(initialMessages)
  const [mode, setMode] = useState<"bot" | "human">(conversation.mode)
  const [withinWindow, setWithinWindow] = useState(conversation.within_window)
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)

  // Polling cada 5s
  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch(`/api/admin/inbox/${conversation.id}/messages`)
      if (res.ok) setMessages(await res.json())
    }, 5_000)
    return () => clearInterval(interval)
  }, [conversation.id])

  // Scroll al último mensaje
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  async function toggleMode() {
    const next = mode === "bot" ? "human" : "bot"
    await fetch(`/api/admin/inbox/${conversation.id}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: next }),
    })
    setMode(next)
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

  const canReply = mode === "human" && withinWindow

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-5 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--card)" }}
      >
        <Link
          href="/admin/inbox"
          className="flex items-center justify-center w-7 h-7 rounded-full transition-colors hover:bg-[var(--bg)]"
          style={{ color: "var(--ink-soft)" }}
        >
          <ArrowLeft size={16} strokeWidth={1.6} />
        </Link>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--ink)" }}>{conversation.contact}</p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>WhatsApp</p>
        </div>

        {/* Modo badge + toggle */}
        <div className="flex items-center gap-2">
          {!withinWindow && (
            <span
              className="text-xs px-2 py-1 rounded-full"
              style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
            >
              Ventana cerrada
            </span>
          )}
          <button
            onClick={toggleMode}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{
              background: mode === "human" ? "var(--green-soft)" : "var(--blue-soft)",
              color: mode === "human" ? "var(--green)" : "var(--blue)",
              border: `1px solid ${mode === "human" ? "var(--green-soft)" : "var(--blue-soft)"}`,
            }}
          >
            {mode === "human" ? <User size={11} /> : <Bot size={11} />}
            {mode === "human" ? "Tomo yo · Devolver al bot" : "Bot activo · Tomar"}
          </button>
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
            El bot está respondiendo. Hacé click en "Tomar" para responder vos.
          </p>
        ) : !withinWindow ? (
          <p className="text-xs text-center py-1" style={{ color: "var(--amber)" }}>
            Ventana de 24h cerrada — el cliente debe enviarte un mensaje para reabrir la ventana.
          </p>
        ) : (
          <form onSubmit={handleSend} className="flex gap-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Escribí tu respuesta..."
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e as unknown as React.FormEvent) }
              }}
              className="flex-1 px-3 py-2 rounded-[var(--radius)] text-sm resize-none outline-none"
              style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
            />
            <button
              type="submit"
              disabled={!reply.trim() || sending}
              className="flex items-center justify-center w-10 h-10 self-end rounded-full text-white transition-opacity disabled:opacity-40"
              style={{ background: "var(--blue)" }}
            >
              <Send size={16} strokeWidth={1.6} />
            </button>
          </form>
        )}
        {sendError && (
          <p className="text-xs mt-2" style={{ color: "var(--red)" }}>{sendError}</p>
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
            background: isOutbound
              ? isHuman ? "var(--green)" : "var(--blue)"
              : "var(--card)",
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
