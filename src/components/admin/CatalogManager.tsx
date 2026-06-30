"use client"

import { useState, useRef, useEffect } from "react"
import { Trash2, Package, Plus, X, Upload, Download, RefreshCw } from "lucide-react"
import {
  Button,
  Input,
  Field,
  Badge,
  Alert,
  Table,
  Select,
  FileDropZone,
  Dialog,
  useToast,
  type TableColumn,
} from "@myd-org/ui"

const PAYMENT_METHODS = [
  { value: "Transferencia", label: "Transferencia" },
  { value: "Efectivo", label: "Efectivo" },
  { value: "Cheque", label: "Cheque" },
  { value: "Tarjeta de crédito", label: "Tarjeta de crédito" },
  { value: "Tarjeta de débito", label: "Tarjeta de débito" },
]

type PriceColumn = { key: string; label: string }

type PriceList = {
  id: string
  name: string
  category: string
  priceColumns: PriceColumn[]
  active: boolean
  uploadedAt: string
  itemCount: number
}

type CatalogItem = {
  id: string
  code: string
  description: string
  prices: Record<string, string>
}

type PaymentCondition = {
  method: string
  description: string
}

interface Props {
  initialLists: PriceList[]
  initialPaymentConditions: PaymentCondition[]
}

export function CatalogManager({ initialLists, initialPaymentConditions }: Props) {
  const { toast } = useToast()
  const [lists, setLists] = useState<PriceList[]>(initialLists)

  // Confirm delete dialog
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Upload form
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadName, setUploadName] = useState("")
  const [uploadCategory, setUploadCategory] = useState("")
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Payment conditions
  const [conditions, setConditions] = useState<PaymentCondition[]>(initialPaymentConditions)
  const [savedConditions, setSavedConditions] = useState<PaymentCondition[]>(initialPaymentConditions)
  const [savingConditions, setSavingConditions] = useState(false)

  const conditionsChanged = JSON.stringify(conditions) !== JSON.stringify(savedConditions)

  // Sincronización con Alegra (catálogo cacheado). Ver ADR catálogo Alegra.
  type SyncLog = { status: string; itemsSynced: number; categoriesSynced: number; finishedAt: string | null; trigger: string } | null
  const [lastSync, setLastSync] = useState<SyncLog>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    fetch("/api/admin/catalog/sync")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLastSync(d?.last ?? null))
      .catch(() => {})
  }, [])

  async function runAlegraSync() {
    setSyncing(true)
    try {
      const res = await fetch("/api/admin/catalog/sync", { method: "POST" })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast({ title: "Catálogo sincronizado", description: `${data.itemsSynced} productos · ${data.categoriesSynced} categorías`, tone: "success" })
      } else {
        toast({ title: "Error al sincronizar con Alegra", description: data.error, tone: "danger" })
      }
      const last = await fetch("/api/admin/catalog/sync").then((r) => r.json()).catch(() => null)
      setLastSync(last?.last ?? null)
    } finally {
      setSyncing(false)
    }
  }

  async function confirmDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/admin/catalog/${deleteId}`, { method: "DELETE" })
      if (res.ok) {
        setLists((prev) => prev.filter((l) => l.id !== deleteId))
        toast({ title: "Lista eliminada", tone: "neutral" })
      } else {
        toast({ title: "Error al eliminar la lista", tone: "danger" })
      }
    } finally {
      setDeleting(false)
      setDeleteId(null)
    }
  }

  async function handleUpload() {
    if (!uploadName || !uploadCategory || !uploadFile) {
      setUploadError("Completá todos los campos")
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      fd.append("name", uploadName)
      fd.append("category", uploadCategory)
      fd.append("file", uploadFile)
      const res = await fetch("/api/admin/catalog/upload", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) {
        setUploadError(data.error ?? "Error al cargar")
        return
      }
      const listRes = await fetch("/api/admin/catalog")
      const updated = await listRes.json()
      setLists(updated)
      toast({ title: `Lista "${data.name}" cargada`, description: `${data.itemCount} productos importados`, tone: "success" })
      setUploadOpen(false)
      setUploadName("")
      setUploadCategory("")
      setUploadFile(null)
      if (fileRef.current) fileRef.current.value = ""
    } finally {
      setUploading(false)
    }
  }

  async function saveConditions() {
    const filled = conditions.filter((c) => c.method.trim() || c.description.trim())
    const incomplete = filled.some((c) => !c.method.trim() || !c.description.trim())
    if (incomplete) {
      toast({ title: "Completá método y condición en todas las filas", tone: "warning" })
      return
    }
    setSavingConditions(true)
    try {
      const res = await fetch("/api/admin/catalog/payment-conditions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filled),
      })
      if (res.ok) {
        setConditions(filled)
        setSavedConditions(filled)
        toast({ title: "Condiciones guardadas", tone: "success" })
      } else {
        toast({ title: "Error al guardar condiciones", tone: "danger" })
      }
    } finally {
      setSavingConditions(false)
    }
  }

  return (
    <div className="space-y-4">

      {/* Sincronización con Alegra (catálogo cacheado: productos, precios, categorías) */}
      <div className="rounded-[var(--radius)] overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Catálogo de Alegra</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--ink-soft)" }}>
              {lastSync?.finishedAt
                ? `Última sincronización: ${new Date(lastSync.finishedAt).toLocaleString("es-AR")} · ${lastSync.itemsSynced} productos · ${lastSync.categoriesSynced} categorías${lastSync.status === "error" ? " · con errores" : ""}`
                : "Todavía no se sincronizó el catálogo con Alegra."}
            </p>
          </div>
          <Button variant="secondary" loading={syncing} onClick={runAlegraSync}>
            <RefreshCw size={14} strokeWidth={1.6} />
            Sincronizar con Alegra
          </Button>
        </div>
      </div>

      {/* Dialog de confirmación de eliminación */}
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null) }}
        title="Eliminar lista de precios"
        description="Se eliminarán todos los productos importados. Esta acción no se puede deshacer."
        headerBorder={false}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDeleteId(null)}>Cancelar</Button>
            <Button variant="danger" loading={deleting} onClick={confirmDelete}>Eliminar</Button>
          </div>
        }
      >
        <p className="text-sm" style={{ color: "var(--ink)" }}>¿Estás seguro que querés eliminar esta lista y todos sus productos?</p>
      </Dialog>

      {/* Listas de precios */}
      <div className="rounded-[var(--radius)] overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
        {/* Header de sección */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Listas de precios</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--ink-soft)" }}>Archivos Excel con productos y precios por categoría</p>
          </div>
          <Button onClick={() => { setUploadOpen((v) => !v); setUploadError(null) }}>
            <Upload size={14} strokeWidth={1.6} />
            Subir lista
          </Button>
        </div>

        {/* Dialog de upload */}
        <Dialog
          open={uploadOpen}
          onOpenChange={(open) => { setUploadOpen(open); if (!open) setUploadError(null) }}
          title="Subir lista de precios"
          description="El archivo reemplazará la lista activa del catálogo."
          footer={
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setUploadOpen(false)}>Cancelar</Button>
              <Button loading={uploading} onClick={handleUpload}>{uploading ? "Cargando..." : "Subir"}</Button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nombre de la lista">
                <Input value={uploadName} onChange={(e) => setUploadName(e.target.value)} placeholder="ej: Cables en general" />
              </Field>
              <Field label="Categoría">
                <Input value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)} placeholder="ej: cables" />
              </Field>
            </div>
            <Field label="Archivo Excel (.xlsx)">
              <FileDropZone
                file={uploadFile}
                onChange={setUploadFile}
                accept=".xlsx,.xls"
                hint="Formatos: .xlsx, .xls · Máx. 10 MB"
              />
            </Field>
            {uploadError && <Alert tone="danger">{uploadError}</Alert>}
          </div>
        </Dialog>

        {/* Contenido: vacío o tabla */}
        <Table<PriceList>
          rows={lists}
          rowKey={(l) => l.id}
          empty={
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <Package size={24} strokeWidth={1.4} style={{ color: "var(--ink-faint)" }} />
              <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>Sin listas cargadas</p>
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Subí un Excel con productos y precios para que el agente pueda responder consultas.</p>
            </div>
          }
          columns={[
            {
              key: "name",
              header: "Lista",
              render: (l) => <span className="font-medium">{l.name}</span>,
            },
            {
              key: "category",
              header: "Categoría",
              render: (l) => <span className="text-xs" style={{ color: "var(--ink-soft)" }}>{l.category}</span>,
            },
            {
              key: "itemCount",
              header: "Productos",
              render: (l) => <span className="tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>{l.itemCount.toLocaleString("es-AR")}</span>,
            },
            {
              key: "active",
              header: "Estado",
              render: (l) => l.active ? <Badge tone="success">Activa</Badge> : null,
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (l) => (
                <div className="flex gap-1 justify-end">
                  <a href={`/api/admin/catalog/${l.id}/download`} download>
                    <Button variant="ghost" size="icon" title="Descargar Excel">
                      <Download size={14} strokeWidth={1.6} />
                    </Button>
                  </a>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteId(l.id)} title="Eliminar">
                    <Trash2 size={14} strokeWidth={1.6} />
                  </Button>
                </div>
              ),
            },
          ] as TableColumn<PriceList>[]}
        />
      </div>

      {/* Condiciones de pago */}
      <div className="rounded-[var(--radius)] overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
        {/* Header de sección */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Condiciones de pago</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--ink-soft)" }}>
              El agente usa esta información para responder preguntas sobre formas de pago
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConditions((prev) => [...prev, { method: "", description: "" }])}>
              <Plus size={14} strokeWidth={1.6} /> Agregar
            </Button>
            <Button loading={savingConditions} disabled={!conditionsChanged} onClick={saveConditions}>
              Guardar
            </Button>
          </div>
        </div>

        <div className="px-5 py-4">
          {conditions.length === 0 ? (
            <p className="text-sm py-2" style={{ color: "var(--ink-soft)" }}>Sin condiciones cargadas todavía.</p>
          ) : (
            <div>
              {/* Encabezados */}
              <div className="flex gap-2 mb-1.5 pr-10">
                <p className="w-48 shrink-0 text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Método de pago</p>
                <p className="flex-1 text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Condición / descuento</p>
              </div>
              <div className="space-y-2">
                {conditions.map((c, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <Select
                      value={c.method}
                      onValueChange={(v) => setConditions((prev) => prev.map((x, idx) => idx === i ? { ...x, method: v } : x))}
                      options={PAYMENT_METHODS}
                      className="w-48 shrink-0"
                    />
                    <Input
                      value={c.description}
                      onChange={(e) => setConditions((prev) => prev.map((x, idx) => idx === i ? { ...x, description: e.target.value } : x))}
                      placeholder="ej: 5% de descuento sobre lista"
                      className="flex-1"
                    />
                    <Button variant="ghost" size="icon" onClick={() => setConditions((prev) => prev.filter((_, idx) => idx !== i))}>
                      <X size={14} strokeWidth={1.6} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  )
}
