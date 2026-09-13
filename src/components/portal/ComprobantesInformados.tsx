"use client"

import { Badge, Table, type TableColumn } from "@myd-org/ui"
import { usePaginado, Paginacion } from "./paginado"

// Historial de comprobantes informados (entrega B): bloque sobre la tabla de pagos de
// Alegra. La primera página la trae el server component de dashboard (props); el resto
// pagina contra GET /api/portal/comprobantes (10 por página, "Cargar más" en celular).
// Solo llegan estados pending/loaded propios del cliente; tras informar, el modal llama
// `router.refresh()` y `usePaginado` resetea con la página nueva.

export interface ComprobanteInformado {
  id: string
  submittedAt: string
  paidOn: string
  amount: string
  currency: "ARS"
  method: string
  methodOther: string | null
  status: "pending" | "loaded"
  fileOriginalName: string | null
}

const PAGE_SIZE = 10

const METODOS: Record<string, string> = {
  transferencia: "Transferencia",
  cheque: "Cheque",
  efectivo: "Efectivo",
  otro: "Otro",
}

function fmtMonto(amount: string): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(amount))
}

/** "2026-09-10" → "10/09/2026" (tanto paidOn como la fecha del submittedAt ISO). */
function fmtFecha(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-")
  return y && m && d ? `${d}/${m}/${y}` : iso
}

export function ComprobantesInformados({
  comprobantes: inicial,
  total: totalInicial,
}: {
  comprobantes: ComprobanteInformado[]
  total: number
}) {
  const pag = usePaginado<ComprobanteInformado>({
    url: "/api/portal/comprobantes",
    pick: (d) => (d.comprobantes as ComprobanteInformado[]) ?? [],
    inicial,
    totalInicial,
    pageSize: PAGE_SIZE,
  })

  const columns: TableColumn<ComprobanteInformado>[] = [
    {
      key: "informado",
      header: "Informado el",
      className: "text-xs",
      render: (c) => <span style={{ color: "var(--ink-soft)" }}>{fmtFecha(c.submittedAt)}</span>,
    },
    {
      key: "pago",
      header: "Pago del",
      className: "text-xs",
      render: (c) => <span style={{ color: "var(--ink-soft)" }}>{fmtFecha(c.paidOn)}</span>,
    },
    {
      key: "monto",
      header: "Monto",
      align: "right",
      className: "font-medium tabular-nums",
      render: (c) => <span style={{ color: "var(--green)" }}>{fmtMonto(c.amount)}</span>,
    },
    {
      key: "medio",
      header: "Medio",
      hideBelow: "sm",
      className: "text-xs",
      render: (c) => (
        <span style={{ color: "var(--ink-soft)" }}>
          {c.method === "otro" && c.methodOther ? `Otro (${c.methodOther})` : (METODOS[c.method] ?? c.method)}
        </span>
      ),
    },
    {
      key: "estado",
      header: "Estado",
      align: "right",
      render: (c) => (
        <Badge tone={c.status === "loaded" ? "success" : "warning"}>
          {c.status === "loaded" ? "Cargado" : "Pendiente"}
        </Badge>
      ),
    },
  ]

  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--ink)" }}>
        Comprobantes que informaste
      </h3>
      <Table<ComprobanteInformado>
        columns={columns}
        rows={pag.items}
        rowKey={(c) => c.id}
        empty="Todavía no informaste comprobantes"
      />
      <Paginacion
        desde={pag.desde}
        cantidad={pag.items.length}
        total={pag.total}
        hayMas={pag.hayMas}
        cargando={pag.cargando}
        error={pag.error}
        pageSize={PAGE_SIZE}
        onIrAPagina={(start) => void pag.irAPagina(start)}
        onCargarMas={() => void pag.cargarMas()}
      />
    </section>
  )
}
