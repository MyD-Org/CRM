"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Receipt, RefreshCw } from "lucide-react"
import { Badge, Button, EmptyState, Table, type TableColumn, Tabs } from "@myd-org/ui"
import type { AdminReceiptDto } from "@/lib/payment-receipts"
import { useVisiblePoll } from "@/lib/use-visible-poll"
import { ComprobanteDialog } from "./ComprobanteDialog"
import { fmtFecha, fmtFechaHora, fmtMonto, methodLabel } from "./format"

type Tab = "pending" | "loaded"

interface ListaResponse {
  items: AdminReceiptDto[]
  total: number
  receiptsEmailConfigured: boolean
  storageConfigured: boolean
}

interface Props {
  initialItems: AdminReceiptDto[]
  initialTotal: number
  initialReceiptsEmailConfigured: boolean
  initialStorageConfigured: boolean
  /** Id de `?id=` (link del mail): el shell abre ese comprobante, o avisa "no encontrado". */
  initialOpenId?: string
  pageSize: number
}

// Poll del listado: un comprobante nuevo avisa por mail, pero el admin que tiene la pantalla
// abierta lo ve sin hacer nada. El inbox pollea cada 10s porque el tiempo de respuesta importa;
// acá 30s alcanza (mismo hook useVisiblePoll: se pausa con la pestaña oculta).
const POLL_MS = 30_000

export function ComprobantesShell({
  initialItems,
  initialTotal,
  initialReceiptsEmailConfigured,
  initialStorageConfigured,
  initialOpenId,
  pageSize,
}: Props) {
  const [tab, setTab] = useState<Tab>("pending")
  const [items, setItems] = useState(initialItems)
  const [total, setTotal] = useState(initialTotal)
  const [receiptsEmailConfigured, setReceiptsEmailConfigured] = useState(initialReceiptsEmailConfigured)
  const [storageConfigured] = useState(initialStorageConfigured)
  const [start, setStart] = useState(0)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)
  // Link del mail con id inexistente/ajeno: el GET detalle da 404 (idéntico al de operator) y
  // la pantalla lo dice en vez de abrir el diálogo, sin revelar nada.
  const [notFoundId, setNotFoundId] = useState<string | null>(null)

  const load = useCallback(async () => {
    // `no-store`: misma URL en cada poll; sin esto el navegador cachea el GET.
    const res = await fetch(
      `/api/admin/comprobantes?status=${tab}&start=${start}&limit=${pageSize}`,
      { cache: "no-store" },
    ).catch(() => null)
    if (res?.ok) {
      const data = (await res.json().catch(() => null)) as ListaResponse | null
      if (data) {
        setItems(data.items)
        setTotal(data.total)
        setReceiptsEmailConfigured(data.receiptsEmailConfigured)
        setError("")
      } else {
        setError("No pudimos cargar los comprobantes")
      }
    } else if (res) {
      // res null (red) o !ok: el poll no borra la lista, solo avisa.
      setError("No pudimos cargar los comprobantes")
    }
    setCargando(false)
  }, [tab, start, pageSize])

  // Carga inmediata al montar y al cambiar de tab/página. El IIFE es el patrón de
  // TemplateManager: sin él la regla react-hooks/set-state-in-effect marca un falso positivo
  // (todo el setState del load corre después del await, nunca síncrono con el effect).
  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [load])

  useVisiblePoll(load, POLL_MS)

  // ?id= del link del mail: se resuelve al montar (GET detalle). 404 → aviso en pantalla.
  const openIdRef = useRef(initialOpenId)
  useEffect(() => {
    const id = openIdRef.current
    if (!id) return
    let cancelado = false
    fetch(`/api/admin/comprobantes/${id}`, { cache: "no-store" })
      .then((res) => {
        if (cancelado) return
        if (res.ok) setOpenId(id)
        else setNotFoundId(id)
      })
      .catch(() => {
        // Sin red no se sabe si existe: se abre el diálogo, que muestra su propio error de carga.
        if (!cancelado) setOpenId(id)
      })
    return () => {
      cancelado = true
    }
  }, [])

  function cambiarTab(next: Tab) {
    if (next === tab) return
    setCargando(true)
    setTab(next)
    setStart(0)
  }

  function irAPagina(nuevoStart: number) {
    setCargando(true)
    setStart(nuevoStart)
  }

  /** El diálogo actualizó una fila (PATCH / resend): se refleja en la lista. */
  function handleChanged(next: AdminReceiptDto) {
    setItems((prev) => prev.map((item) => (item.id === next.id ? next : item)))
  }

  const columns: TableColumn<AdminReceiptDto>[] = [
    {
      key: "pago",
      header: "Fecha del pago",
      render: (r) => (
        <>
          <div className="font-medium" style={{ color: "var(--ink)" }}>{fmtFecha(r.paidOn)}</div>
          <div className="text-xs" style={{ color: "var(--ink-faint)" }}>
            Informado el {fmtFechaHora(r.submittedAt)}
          </div>
        </>
      ),
    },
    {
      key: "cliente",
      header: "Cliente",
      render: (r) => (
        <>
          <div className="font-medium" style={{ color: "var(--ink)" }}>{r.razonsocial}</div>
          {r.cuit && <div className="text-xs" style={{ color: "var(--ink-faint)" }}>CUIT {r.cuit}</div>}
        </>
      ),
    },
    {
      key: "monto",
      header: "Monto",
      align: "right",
      className: "font-medium tabular-nums",
      render: (r) => <span style={{ color: "var(--ink)" }}>{fmtMonto(r.amount)}</span>,
    },
    {
      key: "medio",
      header: "Medio",
      hideBelow: "sm",
      className: "text-xs",
      render: (r) => <span style={{ color: "var(--ink-soft)" }}>{methodLabel(r.method, r.methodOther)}</span>,
    },
    {
      key: "estado",
      header: "Estado",
      render: (r) =>
        r.status === "loaded" ? (
          <Badge tone="success">Cargado</Badge>
        ) : (
          <Badge tone="warning">Pendiente</Badge>
        ),
    },
    {
      key: "mail",
      header: "Mail",
      hideBelow: "md",
      render: (r) => <EmailBadge receipt={r} />,
    },
    {
      key: "acciones",
      header: "",
      align: "right",
      render: (r) => (
        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setOpenId(r.id) }}>
          Ver
        </Button>
      ),
    },
  ]

  const hasta = Math.min(start + items.length, total)

  return (
    <div className="flex flex-col gap-3">
      {!receiptsEmailConfigured && (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius)] p-3 text-sm"
          style={{ background: "var(--amber-soft)", border: "1px solid var(--amber)", color: "var(--amber)" }}
          role="status"
        >
          <AlertTriangle size={15} strokeWidth={1.8} />
          <span>
            Todavía no configuraste el email que recibe los comprobantes.{" "}
            <a href="/admin/configuracion" style={{ textDecoration: "underline", fontWeight: 600 }}>
              Configuralo en Configuración → Comprobantes
            </a>{" "}
            para que te llegue el aviso con cada comprobante.
          </span>
        </div>
      )}

      {!storageConfigured && (
        <div
          className="rounded-[var(--radius)] p-3 text-sm"
          style={{ background: "var(--amber-soft)", border: "1px solid var(--amber)", color: "var(--amber)" }}
          role="status"
        >
          El almacenamiento de comprobantes no está configurado: los clientes no pueden informar pagos.
        </div>
      )}

      {notFoundId && (
        <div
          className="rounded-[var(--radius)] p-3 text-sm"
          style={{ background: "var(--red-soft)", border: "1px solid var(--red)", color: "var(--red)" }}
          role="status"
        >
          Comprobante no encontrado.
        </div>
      )}

      <Tabs
        variant="underline"
        value={tab}
        onValueChange={(v) => cambiarTab(v as Tab)}
        items={[
          { value: "pending", label: "Pendientes" },
          { value: "loaded", label: "Cargados" },
        ]}
      />

      {!items.length && !error ? (
        <EmptyState
          icon={<Receipt size={28} strokeWidth={1.2} />}
          title={tab === "pending" ? "No hay comprobantes pendientes" : "No hay comprobantes cargados"}
        />
      ) : (
        <>
          <Table<AdminReceiptDto>
            columns={columns}
            rows={items}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenId(r.id)}
            empty="No hay comprobantes para mostrar"
          />
          {error && (
            <div className="flex flex-col items-center gap-2 pt-2">
              <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                <RefreshCw size={13} /> Reintentar
              </Button>
            </div>
          )}
          {(total > 0 || start > 0) && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button variant="ghost" size="sm" onClick={() => irAPagina(Math.max(0, start - pageSize))} disabled={cargando || start === 0}>
                Anterior
              </Button>
              <p className="text-xs tabular-nums" style={{ color: "var(--ink-faint)" }}>
                {cargando ? "Cargando…" : total === 0 ? "0" : `${start + 1}–${hasta} de ${total}`}
              </p>
              <Button variant="ghost" size="sm" onClick={() => irAPagina(start + pageSize)} disabled={cargando || hasta >= total}>
                Siguiente
              </Button>
            </div>
          )}
        </>
      )}

      {openId && (
        <ComprobanteDialog
          id={openId}
          initial={items.find((r) => r.id === openId) ?? null}
          onClose={() => setOpenId(null)}
          onChanged={handleChanged}
        />
      )}
    </div>
  )
}

function EmailBadge({ receipt }: { receipt: AdminReceiptDto }) {
  const { email } = receipt
  const fallido = email.status === "failed" || email.status === "skipped" || email.stale
  if (fallido) {
    const motivo =
      email.status === "skipped"
        ? "El envío se omitió (falta configurar el email destino o el remitente)."
        : email.status === "failed"
          ? (email.error ?? "El envío falló.")
          : "El envío está tardando más de lo normal."
    return (
      <span title={motivo}>
        <Badge tone="danger" className="flex items-center gap-1">
          <AlertTriangle size={9} />
          Mail no enviado
        </Badge>
      </span>
    )
  }
  if (email.status === "sent") {
    return (
      <span title={email.sentAt ? `Enviado el ${fmtFechaHora(email.sentAt)}` : undefined}>
        <Badge tone="success">Enviado</Badge>
      </span>
    )
  }
  return <Badge tone="neutral">Pendiente</Badge>
}
