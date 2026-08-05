"use client"

import { useCallback, useEffect, useState } from "react"
import { Button, Badge, Dialog, Field, Input, Select, Textarea, Spinner, useToast } from "@myd-org/ui"
import { Plus, RefreshCw } from "lucide-react"
import type { WhatsappTemplate } from "@/lib/inbox-api"

const CATEGORY_OPTIONS = [
  { value: "UTILITY", label: "Utilidad (notificaciones)" },
  { value: "MARKETING", label: "Marketing" },
  { value: "AUTHENTICATION", label: "Autenticación" },
]
const LANGUAGE_OPTIONS = [
  { value: "es_AR", label: "Español (Argentina)" },
  { value: "es_ES", label: "Español (España)" },
  { value: "en_US", label: "Inglés (EE.UU.)" },
  { value: "pt_BR", label: "Portugués (Brasil)" },
]
const NAME_RE = /^[a-z0-9_]{1,512}$/

function statusTone(status: string): "success" | "warning" | "danger" | undefined {
  const s = status.toUpperCase()
  if (s === "APPROVED") return "success"
  if (s === "PENDING" || s === "IN_APPEAL") return "warning"
  if (s === "REJECTED" || s === "DISABLED" || s === "PAUSED") return "danger"
  return undefined
}

const EMPTY_FORM = { name: "", category: "UTILITY", language: "es_AR", body: "" }

export function TemplateManager() {
  const { toast } = useToast()
  const [templates, setTemplates] = useState<WhatsappTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)

  // La lista reconcilia contra Meta en el server (proxy → GET ?reconcile=1), así el estado
  // PENDING→APPROVED se refleja sin webhooks al abrir o tocar "Actualizar". Usado por el
  // botón "Actualizar" y por el refresh post-creación (event handlers, no efectos).
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/templates")
      if (res.ok) setTemplates(await res.json())
      else toast({ title: "No se pudieron cargar las plantillas", tone: "danger" })
    } catch {
      toast({ title: "No se pudieron cargar las plantillas", tone: "danger" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Carga inicial. Inline (no reusa `load`) para no llamar setState de forma sincrónica
  // dentro del efecto (regla react-hooks/set-state-in-effect): `loading` ya arranca en true
  // y solo tocamos estado después del await.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/admin/templates")
        if (cancelled) return
        if (res.ok) setTemplates(await res.json())
        else toast({ title: "No se pudieron cargar las plantillas", tone: "danger" })
      } catch {
        if (!cancelled) toast({ title: "No se pudieron cargar las plantillas", tone: "danger" })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [toast])

  async function handleCreate() {
    const name = form.name.trim()
    if (!NAME_RE.test(name)) {
      toast({ title: "Nombre inválido", description: "Solo minúsculas, números y guión bajo.", tone: "danger" })
      return
    }
    if (!form.body.trim()) {
      toast({ title: "Falta el texto del mensaje", tone: "danger" })
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/admin/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          category: form.category,
          language: form.language,
          components: [{ type: "BODY", text: form.body.trim() }],
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast({ title: "Plantilla enviada a Meta", description: "Queda en revisión (PENDING).", tone: "success" })
        setOpen(false)
        setForm(EMPTY_FORM)
        void load()
      } else if (res.status === 422) {
        // meta_rejected: el detalle de Graph viene anidado; sacamos el mensaje más útil.
        const err = (data?.detail?.error ?? {}) as { error_user_msg?: string; message?: string }
        const detail = err.error_user_msg ?? err.message ?? "Meta rechazó la plantilla."
        toast({ title: "Meta rechazó la plantilla", description: String(detail).slice(0, 200), tone: "danger" })
      } else {
        toast({ title: "No se pudo crear la plantilla", description: String(data?.error ?? `Error ${res.status}`), tone: "danger" })
      }
    } catch {
      toast({ title: "No se pudo crear la plantilla", tone: "danger" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Plantillas de WhatsApp</h1>
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            Mensajes preaprobados por Meta para notificar a tus clientes (pedidos, cotizaciones, etc.).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading} className="flex items-center gap-1.5">
            <RefreshCw size={14} strokeWidth={1.6} /> Actualizar
          </Button>
          <Button size="sm" onClick={() => setOpen(true)} className="flex items-center gap-1.5">
            <Plus size={14} strokeWidth={1.6} /> Nueva plantilla
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center" style={{ borderColor: "var(--border)", color: "var(--ink-soft)" }}>
          <p className="font-medium" style={{ color: "var(--ink)" }}>Todavía no hay plantillas</p>
          <p className="text-sm mt-1">Creá la primera con “Nueva plantilla”.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "var(--ink-soft)" }}>
                <th className="px-3 py-2 font-medium">Nombre</th>
                <th className="px-3 py-2 font-medium">Idioma</th>
                <th className="px-3 py-2 font-medium">Categoría</th>
                <th className="px-3 py-2 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-3 py-2 font-medium" style={{ color: "var(--ink)" }}>{t.name}</td>
                  <td className="px-3 py-2" style={{ color: "var(--ink-soft)" }}>{t.language}</td>
                  <td className="px-3 py-2" style={{ color: "var(--ink-soft)" }}>{t.category}</td>
                  <td className="px-3 py-2">
                    <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                    {t.status.toUpperCase() === "REJECTED" && t.rejectionReason ? (
                      <span className="ml-2 text-xs" style={{ color: "var(--ink-faint)" }}>{t.rejectionReason}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => { if (!o) setOpen(false) }}
        title="Nueva plantilla"
        description="Se envía a Meta para aprobación. Queda en estado PENDING hasta que la revisen (suele tardar minutos)."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={handleCreate} disabled={saving}>{saving ? "Enviando…" : "Crear"}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Nombre (interno)">
            <Input
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }))}
              placeholder="confirmacion_pedido"
            />
          </Field>
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Categoría">
                <Select value={form.category} onValueChange={(v) => setForm((p) => ({ ...p, category: v }))} options={CATEGORY_OPTIONS} />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Idioma">
                <Select value={form.language} onValueChange={(v) => setForm((p) => ({ ...p, language: v }))} options={LANGUAGE_OPTIONS} />
              </Field>
            </div>
          </div>
          <Field label="Mensaje">
            <Textarea
              value={form.body}
              onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
              rows={4}
              placeholder="Hola, tu pedido en Central Led fue confirmado. ¡Gracias por tu compra!"
            />
          </Field>
        </div>
      </Dialog>
    </div>
  )
}
