"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { MessageSquare, Clock, Bot, User } from "lucide-react"
import { Tabs, Badge, EmptyState } from "@myd-org/ui"
import type { InboxConversation } from "@/lib/inbox-api"

interface Props {
  initialConversations: InboxConversation[]
  currentUserName: string
}

export function InboxList({ initialConversations, currentUserName }: Props) {
  const [conversations, setConversations] = useState(initialConversations)
  const [tab, setTab] = useState<"all" | "mine">("all")

  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch("/api/admin/inbox/conversations")
      if (res.ok) setConversations(await res.json())
    }, 10_000)
    return () => clearInterval(interval)
  }, [])

  const mineCount = conversations.filter((c) => c.assigned_to === currentUserName).length
  const visible = tab === "mine"
    ? conversations.filter((c) => c.assigned_to === currentUserName)
    : conversations

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        variant="pill"
        value={tab}
        onValueChange={(v) => setTab(v as "all" | "mine")}
        items={[
          { value: "all", label: "Todos" },
          {
            value: "mine",
            label: (
              <span className="flex items-center gap-1.5">
                Mis conversaciones
                {mineCount > 0 && (
                  <Badge tone="info" className="text-[10px] px-1.5 py-0">
                    {mineCount}
                  </Badge>
                )}
              </span>
            ),
          },
        ]}
      />

      {!visible.length ? (
        <EmptyState
          icon={<MessageSquare size={28} strokeWidth={1.2} />}
          title={tab === "mine" ? "No tenés conversaciones asignadas" : "No hay conversaciones todavía"}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((conv) => (
            <Link
              key={conv.id}
              href={`/admin/inbox/${conv.id}`}
              className="flex items-center gap-4 px-4 py-3 rounded-[var(--radius)] transition-colors hover:opacity-90"
              style={{ background: "var(--card)", border: "1px solid var(--border)" }}
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "var(--blue-soft)" }}
              >
                <MessageSquare size={16} strokeWidth={1.6} style={{ color: "var(--blue)" }} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--ink)" }}>
                    {conv.contact}
                  </p>
                  <ModeChip mode={conv.mode} assignedTo={conv.assigned_to} />
                </div>
                <p className="text-xs truncate mt-0.5" style={{ color: "var(--ink-soft)" }}>
                  {conv.channel}
                  {conv.phone && conv.phone !== conv.contact ? ` · ${conv.phone}` : ""}
                  {" · "}{conv.last_inbound_at ? formatTime(conv.last_inbound_at) : "—"}
                </p>
              </div>

              <WindowBadge within={conv.within_window} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function ModeChip({ mode, assignedTo }: { mode: string; assignedTo?: string | null }) {
  const isHuman = mode === "human"
  return (
    <Badge tone={isHuman ? "success" : "info"} className="flex items-center gap-1">
      {isHuman ? <User size={9} /> : <Bot size={9} />}
      {isHuman ? (assignedTo ?? "Humano") : "Bot"}
    </Badge>
  )
}

function WindowBadge({ within }: { within: boolean }) {
  return (
    <Badge tone={within ? "success" : "neutral"} className="flex items-center gap-1 shrink-0">
      <Clock size={10} />
      {within ? "Ventana abierta" : "Ventana cerrada"}
    </Badge>
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
