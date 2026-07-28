"use client"

import { useState } from "react"
import { Field, Input, Button, useToast } from "@myd-org/ui"
import type { BotLimits } from "@/lib/inbox-api"

interface Props {
  initial: BotLimits
}

// Editor de topes de uso del bot (solo superadmin). Un campo vacío = sin tope para esa
// dimensión. El backend aplica el tope contra el uso YA registrado, así que el turno que
// cruza el umbral se completa igual (techo blando): conviene setearlo un poco por debajo
// del presupuesto real. Ventanas en UTC.
export function LimitsPanel({ initial }: Props) {
  const { toast } = useToast()
  const [msgs, setMsgs] = useState(initial.messages_per_day != null ? String(initial.messages_per_day) : "")
  const [tokens, setTokens] = useState(initial.tokens_per_month != null ? String(initial.tokens_per_month) : "")
  const [saving, setSaving] = useState(false)

  // "" → null (quitar tope). Valor → entero. Devuelve NaN si es inválido (> validación).
  function parse(v: string): number | null {
    const t = v.trim()
    if (t === "") return null
    const n = Number(t)
    return Number.isInteger(n) && n >= 1 ? n : NaN
  }

  async function save() {
    const messages_per_day = parse(msgs)
    const tokens_per_month = parse(tokens)
    if (Number.isNaN(messages_per_day) || Number.isNaN(tokens_per_month)) {
      toast({ title: "Valores inválidos", description: "Los topes deben ser enteros mayores o iguales a 1 (o vacío para sin tope).", tone: "danger" })
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/admin/inbox/limits", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages_per_day, tokens_per_month }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast({ title: body.error ?? "No se pudieron guardar los topes", tone: "danger" })
        return
      }
      const limits: BotLimits = await res.json()
      setMsgs(limits.messages_per_day != null ? String(limits.messages_per_day) : "")
      setTokens(limits.tokens_per_month != null ? String(limits.tokens_per_month) : "")
      toast({ title: "Topes actualizados", tone: "success" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="rounded-[var(--radius)] p-4 md:p-5 mb-6"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <h2 className="text-sm font-semibold mb-1" style={{ color: "var(--ink)" }}>Topes de uso</h2>
      <p className="text-xs mb-4" style={{ color: "var(--ink-soft)" }}>
        Límite de gasto del asistente por tenant. Dejá el campo vacío para no aplicar tope. Al
        superar el tope, el bot deja de responder y las conversaciones nuevas se derivan a un operador.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 max-w-xl">
        <Field label="Mensajes por día">
          <Input
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="Sin tope"
            value={msgs}
            onChange={(e) => setMsgs(e.currentTarget.value)}
          />
        </Field>
        <Field label="Tokens por mes">
          <Input
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="Sin tope"
            value={tokens}
            onChange={(e) => setTokens(e.currentTarget.value)}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Button loading={saving} onClick={save}>Guardar topes</Button>
      </div>
    </div>
  )
}
