"use client"

import { useState } from "react"
import { Tabs } from "@myd-org/ui"
import { DollarSign, Coins, MessageSquare } from "lucide-react"
import type { UsageSummary, UsageTotals } from "@/lib/inbox-api"

// Costo estimado: números chicos (fracciones de USD). Mostramos más decimales cuando es < 1.
function fmtUsd(n: number): string {
  if (n === 0) return "US$ 0"
  return "US$ " + (n < 1 ? n.toFixed(4) : n.toFixed(2))
}
function fmtInt(n: number): string {
  return n.toLocaleString("es-AR")
}

const RANGES = [
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
  { value: "90", label: "90 días" },
]

interface Props {
  initial: UsageSummary
}

export function UsagePanel({ initial }: Props) {
  const [summary, setSummary] = useState(initial)
  const [days, setDays] = useState("30")
  const [loading, setLoading] = useState(false)

  async function changeRange(next: string) {
    setDays(next)
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/inbox/usage?days=${next}`, { cache: "no-store" })
      if (res.ok) setSummary(await res.json())
    } finally {
      setLoading(false)
    }
  }

  const maxCost = Math.max(...summary.daily.map((d) => d.costUsd), 0)

  return (
    <div className="flex flex-col gap-6">
      {/* Tiles: hoy y mes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PeriodCard title="Hoy" totals={summary.today} />
        <PeriodCard title="Este mes" totals={summary.month} highlight />
      </div>

      {/* Gráfico diario */}
      <div className="rounded-[var(--radius)] border p-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Costo diario</h2>
          <Tabs variant="pill" value={days} onValueChange={changeRange} items={RANGES} />
        </div>

        {summary.daily.length === 0 ? (
          <p className="text-sm py-8 text-center" style={{ color: "var(--ink-soft)" }}>
            Sin actividad en el período.
          </p>
        ) : (
          <div className="flex items-end gap-1 h-32" style={{ opacity: loading ? 0.5 : 1 }}>
            {summary.daily.map((d) => (
              <div
                key={d.date}
                className="flex-1 rounded-t transition-all"
                style={{
                  height: `${maxCost > 0 ? Math.max((d.costUsd / maxCost) * 100, 2) : 2}%`,
                  background: "var(--blue)",
                  minWidth: 2,
                }}
                title={`${d.date} · ${fmtUsd(d.costUsd)} · ${fmtInt(d.tokens)} tokens · ${fmtInt(d.botTurns)} turnos`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Desglose por modelo (mes) */}
      {summary.byModel.length > 0 && (
        <div className="rounded-[var(--radius)] border p-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
          <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--ink)" }}>Gasto del mes por modelo</h2>
          <div className="flex flex-col gap-2">
            {summary.byModel.map((m) => (
              <div key={m.model} className="flex items-center justify-between text-sm py-1.5 border-b last:border-b-0" style={{ borderColor: "var(--border)" }}>
                <span style={{ color: "var(--ink)" }} className="font-mono text-xs">{m.model}</span>
                <span className="flex items-center gap-4" style={{ color: "var(--ink-soft)" }}>
                  <span>{fmtInt(m.tokens)} tokens</span>
                  <span className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{fmtUsd(m.costUsd)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
        Costo <strong>estimado</strong> del modelo Claude (no es la factura real de Anthropic; verificá el total en la
        consola de Anthropic). Los mensajes de plantilla de WhatsApp se facturan aparte por Meta.
      </p>
    </div>
  )
}

function PeriodCard({ title, totals, highlight }: { title: string; totals: UsageTotals; highlight?: boolean }) {
  return (
    <div
      className="rounded-[var(--radius)] border p-4"
      style={{ borderColor: highlight ? "var(--blue)" : "var(--border)", background: "var(--card)" }}
    >
      <p className="text-xs font-medium uppercase tracking-wide mb-3" style={{ color: "var(--ink-soft)" }}>{title}</p>
      <div className="flex items-baseline gap-1.5 mb-3">
        <DollarSign className="w-5 h-5" style={{ color: "var(--blue)" }} />
        <span className="text-2xl font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{fmtUsd(totals.costUsd)}</span>
      </div>
      <div className="flex gap-4 text-sm" style={{ color: "var(--ink-soft)" }}>
        <span className="flex items-center gap-1.5"><Coins className="w-4 h-4" />{fmtInt(totals.tokens)} tokens</span>
        <span className="flex items-center gap-1.5"><MessageSquare className="w-4 h-4" />{fmtInt(totals.botTurns)} turnos</span>
      </div>
    </div>
  )
}
