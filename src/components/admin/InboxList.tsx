"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { MessageSquare, Clock, Bot, User, MessageCircleWarning } from "lucide-react"
import { Tabs, Badge, EmptyState } from "@myd-org/ui"
import type { InboxConversation } from "@/lib/inbox-api"

interface Props {
  initialConversations: InboxConversation[]
  currentUserId: string
}

export function InboxList({ initialConversations, currentUserId }: Props) {
  const [conversations, setConversations] = useState(initialConversations)
  const [tab, setTab] = useState<"all" | "mine">("all")

  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch("/api/admin/inbox/conversations")
      if (res.ok) setConversations(await res.json())
    }, 10_000)
    return () => clearInterval(interval)
  }, [])

  const mineConvs = conversations.filter((c) => c.assigned_operator_id === currentUserId)
  const mineCount = mineConvs.length
  const pendingCount = conversations.filter((c) => c.awaiting_reply).length
  const visible = tab === "mine" ? mineConvs : conversations

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        variant="pill"
        value={tab}
        onValueChange={(v) => setTab(v as "all" | "mine")}
        items={[
          {
            value: "all",
            label: (
              <span className="flex items-center gap-1.5">
                Todos
                {pendingCount > 0 && (
                  <Badge tone="warning" className="text-[10px] px-1.5 py-0">
                    {pendingCount}
                  </Badge>
                )}
              </span>
            ),
          },
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
              className="flex items-center gap-4 px-4 py-3 rounded-[var(--radius)] transition-colors hover:opacity-90 overflow-hidden"
              style={{
                background: conv.awaiting_reply ? "var(--amber-soft)" : "var(--card)",
                border: `1px solid ${conv.awaiting_reply ? "var(--amber)" : "var(--border)"}`,
                borderLeft: `3px solid ${conv.awaiting_reply ? "var(--amber)" : urgencyColor(conv.last_inbound_at)}`,
              }}
            >
              <div className="relative shrink-0">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center"
                  style={{ background: conv.awaiting_reply ? "var(--amber)" : "var(--blue-soft)" }}
                >
                  {conv.awaiting_reply
                    ? <MessageCircleWarning size={16} strokeWidth={1.6} style={{ color: "white" }} />
                    : <MessageSquare size={16} strokeWidth={1.6} style={{ color: "var(--blue)" }} />
                  }
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--ink)" }}>
                    {conv.contact}
                  </p>
                  <ModeChip mode={conv.mode} isAssigned={!!conv.assigned_operator_id} />
                  {conv.awaiting_reply && (
                    <Badge tone="warning" className="flex items-center gap-1 shrink-0">
                      <MessageCircleWarning size={9} />
                      Sin respuesta
                    </Badge>
                  )}
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

function ModeChip({ mode, isAssigned }: { mode: string; isAssigned: boolean }) {
  const isHuman = mode === "human"
  return (
    <Badge tone={isHuman ? "success" : "info"} className="flex items-center gap-1">
      {isHuman ? <User size={9} /> : <Bot size={9} />}
      {isHuman ? (isAssigned ? "Asignado" : "Humano") : "Bot"}
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

function urgencyColor(lastInboundAt: string | null): string {
  if (!lastInboundAt) return "transparent"
  const diffH = (Date.now() - new Date(lastInboundAt).getTime()) / 3_600_000
  if (diffH > 6) return "var(--color-danger)"
  if (diffH > 1) return "var(--color-warning)"
  return "transparent"
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
