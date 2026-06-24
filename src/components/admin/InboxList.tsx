"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { MessageSquare, Clock, Bot, User } from "lucide-react"
import type { InboxConversation } from "@/lib/inbox-api"

interface Props {
  initialConversations: InboxConversation[]
}

export function InboxList({ initialConversations }: Props) {
  const [conversations, setConversations] = useState(initialConversations)

  // Polling cada 10s
  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch("/api/admin/inbox/conversations")
      if (res.ok) setConversations(await res.json())
    }, 10_000)
    return () => clearInterval(interval)
  }, [])

  if (!conversations.length) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-16 rounded-[var(--radius)]"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        <MessageSquare size={32} strokeWidth={1.2} style={{ color: "var(--ink-faint)" }} />
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No hay conversaciones todavía</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {conversations.map((conv) => (
        <Link
          key={conv.id}
          href={`/admin/inbox/${conv.id}`}
          className="flex items-center gap-4 px-4 py-3 rounded-[var(--radius)] transition-colors hover:opacity-90"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          {/* Avatar / canal */}
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ background: "var(--blue-soft)" }}
          >
            <MessageSquare size={16} strokeWidth={1.6} style={{ color: "var(--blue)" }} />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium truncate" style={{ color: "var(--ink)" }}>
                {conv.contact}
              </p>
              <ModeChip mode={conv.mode} />
            </div>
            <p className="text-xs truncate mt-0.5" style={{ color: "var(--ink-soft)" }}>
              {conv.channel} · {conv.last_inbound_at ? formatTime(conv.last_inbound_at) : "—"}
            </p>
          </div>

          {/* Ventana 24h */}
          <WindowBadge within={conv.within_window} />
        </Link>
      ))}
    </div>
  )
}

function ModeChip({ mode }: { mode: string }) {
  const isHuman = mode === "human"
  return (
    <span
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
      style={{
        background: isHuman ? "var(--green-soft)" : "var(--blue-soft)",
        color: isHuman ? "var(--green)" : "var(--blue)",
      }}
    >
      {isHuman ? <User size={9} /> : <Bot size={9} />}
      {isHuman ? "Humano" : "Bot"}
    </span>
  )
}

function WindowBadge({ within }: { within: boolean }) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <Clock size={12} strokeWidth={1.6} style={{ color: within ? "var(--green)" : "var(--ink-faint)" }} />
      <span
        className="text-[10px] font-medium"
        style={{ color: within ? "var(--green)" : "var(--ink-faint)" }}
      >
        {within ? "Ventana abierta" : "Ventana cerrada"}
      </span>
    </div>
  )
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  const diffM = Math.floor(diffMs / 60_000)
  if (diffM < 1) return "ahora"
  if (diffM < 60) return `hace ${diffM}m`
  if (diffH < 24) return `hace ${diffH}h`
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })
}
