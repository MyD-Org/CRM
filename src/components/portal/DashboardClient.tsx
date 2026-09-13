"use client"

import { useState, useMemo, useRef, useEffect } from "react"
import Link from "next/link"
import {
  Table,
  type TableColumn,
  Progress,
  Badge,
  Button,
  SelectionBar as DSSelectionBar,
  Dialog,
  Tabs,
  Tooltip as DSTooltip,
  TooltipProvider,
  Field,
  Select,
} from "@myd-org/ui"
import { PortalHeader } from "./PortalHeader"
import type { Cliente, Factura, Pago, Presupuesto, FacturaEstado, PresupuestoEstado } from "@/types"
import {
  buildFacturasWhatsAppMessage,
  buildPagosWhatsAppMessage,
  buildPresupuestosWhatsAppMessage,
  openWhatsApp,
  type WhatsAppFacturaIntent,
  type WhatsAppPresupuestoIntent,
} from "@/lib/whatsapp"
import { CreditCard, X, Eye, Download, Info, Calendar, Plus } from "lucide-react"
import { InformarPagoModal } from "./InformarPagoModal"
import { usePaginado, Paginacion, useEsDesktop } from "./paginado"
import { ComprobantesInformados, type ComprobanteInformado } from "./ComprobantesInformados"

// ── Tooltip ───────────────────────────────────────────────────────────────────

// ── PDF de documentos ────────────────────────────────────────────────────────
// El PDF lo genera Alegra y lo sirve /api/portal/documentos/[kind]/[id], que valida
// que el documento sea del cliente logueado. Acá se baja con fetch (en vez de apuntar
// un <a> a la URL) para poder mostrar el error del server: si el endpoint responde
// JSON de error, un link directo le dejaría al cliente un PDF roto o un JSON en
// pantalla. `alegraId` falta en los fixtures del modo mock → botón deshabilitado.

type DocKind = "factura" | "pago" | "presupuesto"

interface DocumentoRef {
  id: string
  alegraId?: string
}

async function fetchDocumento(kind: DocKind, alegraId: string, download: boolean): Promise<Blob> {
  const res = await fetch(`/api/portal/documentos/${kind}/${alegraId}${download ? "?download=1" : ""}`)
  if (!res.ok) {
    const msg = await res.json().then((d) => d.error).catch(() => null)
    throw new Error(msg ?? "No pudimos obtener el documento")
  }
  return res.blob()
}

/** Baja el PDF como archivo. */
async function descargarDocumento(kind: DocKind, doc: DocumentoRef) {
  if (!doc.alegraId) return
  try {
    const blob = await fetchDocumento(kind, doc.alegraId, true)
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${kind}-${doc.id.replace(/[^\w.-]+/g, "-")}.pdf`
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Sin esto el blob queda en memoria hasta que se cierre la pestaña.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (err) {
    alert(err instanceof Error ? err.message : "No pudimos descargar el documento")
  }
}

/** URL del PDF para embeberlo o abrirlo. El navegador la pide con la cookie de sesión. */
function documentoUrl(kind: DocKind, alegraId: string) {
  return `/api/portal/documentos/${kind}/${alegraId}`
}

/** Descarga varios, de a uno: el navegador bloquea una ráfaga de descargas simultáneas. */
async function descargarVarios(kind: DocKind, docs: DocumentoRef[]) {
  for (const doc of docs) {
    await descargarDocumento(kind, doc)
  }
}

function Tooltip({ text, white = false }: { text: string; white?: boolean }) {
  return (
    <DSTooltip content={text}>
      <button
        type="button"
        aria-label={text}
        className="inline-flex cursor-default items-center bg-transparent p-0"
      >
        <Info
          size={13}
          strokeWidth={1.6}
          style={{ color: white ? "rgba(255,255,255,0.6)" : "var(--ink-faint)" }}
        />
      </button>
    </DSTooltip>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(n)
}

function parseLocalDate(value: string | null | undefined) {
  if (!value) return null
  const [day, month, year] = value.split("/").map(Number)
  if (!day || !month || !year) return null
  return new Date(year, month - 1, day)
}

// ISO "2026-06-15" → local midnight (evita el bug de UTC que resta un día en Argentina)
function isoToLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d)
}

// ── Pagos parciales ──────────────────────────────────────────────────────────

function esPagoParcial(f: Factura) {
  return Boolean(f.pagado && f.pagado > 0 && f.pagado < f.importe)
}

/** Lo que realmente se adeuda de la factura (importe menos pagos registrados) */
function saldoDe(f: Factura) {
  return f.importe - (f.pagado ?? 0)
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  cliente: Cliente
  facturas: Factura[]
  pagos: Pago[]
  presupuestos: Presupuesto[]
  razonsocial: string
  tenantName: string
  whatsappNumber: string
  logoSrc: string
  logoSubtitle: string
  initialTab?: string
  openFacturaId?: string
  /** Id de Alegra de `openFacturaId`, cuando lo trae el link (notificaciones desde 0022). */
  openFacturaAlegraId?: string
  shopUrl?: string
  /** Secciones que Alegra no pudo devolver en esta carga. Se avisan en vez de mostrarlas vacías. */
  seccionesCaidas?: readonly Tab[]
  /** Cuántas facturas tiene el contacto en total. `facturas` es solo la primera página. */
  facturasTotal?: number
  /** Facturas impagas completas: contadores del resumen y chips Pendientes/Vencidas. */
  abiertas: Factura[]
  pagosTotal?: number
  presupuestosTotal?: number
  /** Storage de comprobantes configurado (r2Config() !== null): muestra "Informar pago". */
  receiptsEnabled?: boolean
  /** Primera página del historial de comprobantes informados (B). `comprobantesTotal` filas. */
  comprobantes?: ComprobanteInformado[]
  comprobantesTotal?: number
}

type Tab = "facturas" | "pagos" | "presupuestos"

const TABS: Tab[] = ["facturas", "pagos", "presupuestos"]

function toTab(value?: string): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : "facturas"
}

// ── Component ────────────────────────────────────────────────────────────────

export function DashboardClient({ cliente, facturas, facturasTotal = facturas.length, abiertas, pagos, pagosTotal = pagos.length, presupuestos, presupuestosTotal = presupuestos.length, razonsocial, tenantName, whatsappNumber, logoSrc, logoSubtitle, initialTab, openFacturaId, openFacturaAlegraId, shopUrl, seccionesCaidas = [], receiptsEnabled = false, comprobantes = [], comprobantesTotal = 0 }: Props) {
  const startTab = toTab(initialTab)

  const [activeTab, setActiveTab] = useState<Tab>(startTab)
  const [facturasFilter, setFacturasFilter] = useState<FacturaEstado | "todos">("todos")

  // Sincroniza con ?tab= cuando cambia — p.ej. al tocar una notificación estando ya en el
  // dashboard. Ya no hay ?q=: la búsqueda se sacó porque miraba solo la página cargada.
  const [prevNav, setPrevNav] = useState(startTab)
  const navTab = toTab(initialTab)
  if (prevNav !== navTab) {
    setPrevNav(navTab)
    setActiveTab(navTab)
    if (navTab === "facturas") setFacturasFilter("todos")
  }

  /** Lleva a la tabla de facturas con el filtro de esa tarjeta. */
  function irAFacturas(estado: "vencida" | "pendiente") {
    setActiveTab("facturas")
    setFacturasFilter(estado)
  }

  // Sobre las abiertas COMPLETAS. Contarlas sobre `facturas` (la primera página) daba mal apenas
  // la tabla empezó a paginar: un cliente con vencidas viejas veía "0 facturas vencidas" al lado
  // de un saldo vencido mayor a cero.
  const vencidasCount = abiertas.filter((f) => f.estado === "vencida").length
  const pendientesCount = abiertas.filter((f) => f.estado === "pendiente").length
  const topVencidas = abiertas.filter((f) => f.estado === "vencida").slice(0, 2)
  const topPendientes = abiertas.filter((f) => f.estado === "pendiente").slice(0, 2)

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <PortalHeader
        logoSrc={logoSrc}
        tenantName={tenantName}
        logoSubtitle={logoSubtitle}
        razonsocial={razonsocial}
        shopUrl={shopUrl}
      />

      {/* Content */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
        {/* Welcome */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>
              Bienvenido, {razonsocial}
            </h1>
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
              {cliente.cuit && `CUIT ${cliente.cuit}`}
            </p>
          </div>
          {cliente.tipoCuenta === "corriente" && (
            <Link
              href="/portal/condiciones"
              className="inline-flex items-center gap-1.5 rounded-[var(--radius)] px-3 py-2 text-sm font-medium transition-opacity hover:opacity-80"
              style={{ background: "var(--blue-soft)", color: "var(--blue)" }}
            >
              <CreditCard size={15} strokeWidth={1.8} />
              Condiciones comerciales
            </Link>
          )}
        </div>

        {/* Summary Cards — solo cuenta corriente */}
        {cliente.tipoCuenta === "corriente" && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Deuda total */}
            <div
              className="rounded-[var(--radius)] p-5 flex flex-col gap-3"
              style={{ background: "var(--blue)", color: "white" }}
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm font-medium opacity-80">
                  Deuda total
                  <Tooltip white text="Suma de todas las facturas pendientes de pago, incluyendo vencidas y a vencer." />
                </span>
              </div>
              <div className="text-3xl font-bold tracking-tight">{fmt(cliente.deudatotal)}</div>
              {/* Solo con un límite cargado en Alegra. Antes el límite era 0 fijo y la barra
                  dividía la deuda por cero: "Disponible" salía negativo para cualquier cliente
                  que debiera algo. */}
              {cliente.limitecredito != null && cliente.limitecredito > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs opacity-70">
                    <span>Límite de crédito</span>
                    <span>{fmt(cliente.limitecredito)}</span>
                  </div>
                  <div className="h-1.5 rounded-full" style={{ background: "rgba(255,255,255,0.2)" }}>
                    <div
                      className="h-1.5 rounded-full transition-all"
                      style={{
                        background: "rgba(255,255,255,0.85)",
                        width: `${Math.min(100, (cliente.deudatotal / cliente.limitecredito) * 100).toFixed(1)}%`,
                      }}
                    />
                  </div>
                  <div className="text-xs opacity-70">
                    Disponible: {fmt(cliente.limitecredito - cliente.deudatotal)}
                  </div>
                </div>
              )}
            </div>

            {/* Saldo vencido */}
            <SummaryCard
              title="Saldo vencido"
              amount={cliente.saldovencido}
              amountColor="var(--red)"
              count={vencidasCount}
              countLabel="facturas vencidas"
              rows={topVencidas}
              onVerMas={() => irAFacturas("vencida")}
              onRowClick={() => irAFacturas("vencida")}
            />

            {/* Saldo a vencer */}
            <SummaryCard
              title="Saldo a vencer"
              amount={cliente.saldoavencer}
              amountColor="var(--amber)"
              count={pendientesCount}
              countLabel="facturas pendientes"
              rows={topPendientes}
              onVerMas={() => irAFacturas("pendiente")}
              onRowClick={() => irAFacturas("pendiente")}
            />
          </div>
        )}

        {/* Tabs */}
        <div
          className="rounded-[var(--radius)] flex flex-col"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <Tabs
            items={[
              { value: "facturas", label: "Facturas" },
              { value: "pagos", label: "Pagos" },
              { value: "presupuestos", label: "Presupuestos" },
            ]}
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as Tab)}
            ariaLabel="Vistas"
            listClassName="px-4 py-1"
          />

          <div className="p-4">
            {/* Una sección caída y una vacía se ven igual: sin este aviso, el cliente lee
                "No hay pagos para mostrar" y cree que el portal le perdió los pagos. */}
            {seccionesCaidas.includes(activeTab) && (
              <div
                className="mb-3 flex items-center gap-2 p-3 rounded-[var(--radius)] text-sm"
                style={{ background: "#fef3c7", border: "1px solid #fcd34d", color: "#92400e" }}
                role="status"
              >
                <Info size={16} strokeWidth={1.6} color="currentColor" />
                <span>No pudimos cargar esta sección en este momento. Actualizá la página en unos minutos.</span>
              </div>
            )}
            {activeTab === "facturas" && (
              <FacturasTable
                facturas={facturas}
                total={facturasTotal}
                abiertas={abiertas}
                razonsocial={razonsocial}
                cuit={cliente.cuit}
                tenantName={tenantName}
                whatsappNumber={whatsappNumber}
                initialFilter={facturasFilter}
                openFacturaId={openFacturaId}
                openFacturaAlegraId={openFacturaAlegraId}
              />
            )}
            {activeTab === "pagos" && <PagosTable pagos={pagos} total={pagosTotal} razonsocial={razonsocial} cuit={cliente.cuit} tenantName={tenantName} whatsappNumber={whatsappNumber} receiptsEnabled={receiptsEnabled} comprobantes={comprobantes} comprobantesTotal={comprobantesTotal} />}
            {activeTab === "presupuestos" && <PresupuestosTable presupuestos={presupuestos} total={presupuestosTotal} razonsocial={razonsocial} cuit={cliente.cuit} tenantName={tenantName} whatsappNumber={whatsappNumber} />}

          </div>
        </div>
      </main>
    </div>
  )
}

// ── Summary Card ─────────────────────────────────────────────────────────────

const SUMMARY_TOOLTIPS: Record<string, string> = {
  "Saldo vencido": "Facturas cuya fecha de vencimiento ya pasó y aún no fueron abonadas.",
  "Saldo a vencer": "Facturas pendientes de pago con vencimiento futuro.",
}

function SummaryCard({
  title,
  amount,
  amountColor,
  count,
  countLabel,
  rows,
  onVerMas,
  onRowClick,
}: {
  title: string
  amount: number
  amountColor: string
  count: number
  countLabel: string
  rows: Factura[]
  onVerMas: () => void
  onRowClick: (id: string) => void
}) {
  return (
    <div
      onClick={onVerMas}
      className="rounded-[var(--radius)] p-5 flex flex-col gap-3 cursor-pointer transition-shadow hover:shadow-md"
      style={{ background: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium" style={{ color: "var(--ink-soft)" }}>
          {title}
          {SUMMARY_TOOLTIPS[title] && <Tooltip text={SUMMARY_TOOLTIPS[title]} />}
        </span>
      </div>
      <div className="text-2xl font-bold" style={{ color: amountColor }}>{fmt(amount)}</div>
      <div className="text-xs" style={{ color: "var(--ink-faint)" }}>
        {count} {countLabel}
      </div>

      <div className="flex flex-col mt-1">
        {rows.slice(0, 2).map((f) => (
          <button
            key={f.id}
            onClick={(e) => { e.stopPropagation(); onRowClick(f.id) }}
            className="flex justify-between items-center text-xs py-1.5 text-left transition-colors hover:opacity-70"
            style={{ borderTop: "1px solid var(--border)", cursor: "pointer" }}
          >
            <span className="truncate max-w-[120px]" style={{ color: "var(--ink-soft)" }}>{f.id}</span>
            <span className="font-medium" style={{ color: "var(--ink)" }}>{fmt(saldoDe(f))}</span>
          </button>
        ))}
        {count > 2 && (
          <button
            onClick={(e) => { e.stopPropagation(); onVerMas() }}
            className="text-xs font-medium text-left transition-opacity hover:opacity-70 pt-2"
            style={{ color: "var(--blue)", borderTop: "1px solid var(--border)" }}
          >
            Ver más →
          </button>
        )}
      </div>
    </div>
  )
}

// ── Facturas Table ────────────────────────────────────────────────────────────

const FACTURA_ESTADO_LABELS: Record<FacturaEstado, string> = {
  pendiente: "Pendiente",
  vencida: "Vencida",
  pagada: "Pagada",
  anulada: "Anulada",
}

const FACTURA_TONE: Record<FacturaEstado, "warning" | "danger" | "success" | "neutral"> = {
  pendiente: "warning",
  vencida: "danger",
  pagada: "success",
  // Neutral y no "danger": una anulada no es un problema del cliente, es un documento
  // sin efecto. En rojo se confundiría con una vencida.
  anulada: "neutral",
}

function FacturaBadge({ estado }: { estado: FacturaEstado }) {
  return <Badge tone={FACTURA_TONE[estado]}>{FACTURA_ESTADO_LABELS[estado]}</Badge>
}

function initialToSet(f: FacturaEstado | "todos"): Set<FacturaEstado> {
  return f === "todos" ? new Set() : new Set([f])
}

/** Tamaños de página del portal. Iguales a los *_PAGE_SIZE del server (lib/erp.ts). */
const PAGINA = 30
/** Pagos de a 10: cada pago trae sus facturas embebidas y 30 tardan ~9 s en Alegra. */
const PAGINA_PAGOS = 10
const PAGINA_PRESUPUESTOS = 30

function FacturasTable({
  facturas: primeraPagina,
  total: totalInicial,
  abiertas,
  razonsocial,
  cuit,
  tenantName,
  whatsappNumber,
  initialFilter = "todos",
  openFacturaId,
  openFacturaAlegraId,
}: {
  facturas: Factura[]
  total: number
  /** Facturas impagas COMPLETAS (no una página). Resuelven Pendientes/Vencidas sin pedir nada. */
  abiertas: Factura[]
  razonsocial: string
  cuit: string
  tenantName: string
  whatsappNumber: string
  initialFilter?: FacturaEstado | "todos"
  openFacturaId?: string
  openFacturaAlegraId?: string
}) {
  // Qué resuelve Alegra (probado) y cómo se usa acá:
  //   Pagadas / Anuladas / Todos → se piden paginados: status=closed|void y fecha de emisión.
  //   Pendientes / Vencidas      → las dos son status=open y Alegra no filtra por vencimiento,
  //                                así que salen del set de abiertas, que está COMPLETO. Nada de
  //                                recortar una página.
  // Un chip por vez: Alegra acepta un solo status por consulta, así que "pagadas + anuladas" no
  // se puede pedir. Sin búsqueda ni orden por columna: los dos mirarían solo la página cargada.
  const pag = usePaginado<Factura>({
    url: "/api/portal/facturas",
    pick: (d) => (d.facturas as Factura[]) ?? [],
    inicial: primeraPagina,
    totalInicial,
    pageSize: PAGINA,
  })

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterEstados, setFilterEstados] = useState<Set<FacturaEstado>>(initialToSet(initialFilter))
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [pdfFactura, setPdfFactura] = useState<Factura | null>(null)
  const [whatsappModal, setWhatsappModal] = useState<{ facturas: Factura[]; intent: WhatsAppFacturaIntent } | null>(null)

  // Fechas vigentes en el acto: "Limpiar" cambia desde y hasta en el mismo click, y armar la
  // consulta con el estado del render hacía que cada cambio viera el valor viejo del otro.
  // Los chips no lo necesitan: se tocan de a uno, así que el estado del render está al día.
  const fechasRef = useRef({ desde: fromDate, hasta: toDate })

  const [prevInitial, setPrevInitial] = useState(initialFilter)
  if (prevInitial !== initialFilter) {
    // Viene de tocar una factura en las tarjetas de resumen: siempre Pendientes o Vencidas,
    // que se resuelven con las abiertas. No hace falta pedir nada.
    setPrevInitial(initialFilter)
    setFilterEstados(initialToSet(initialFilter))
  }

  const estadoSel = [...filterEstados][0] as FacturaEstado | undefined
  const modoAbiertas = estadoSel === "pendiente" || estadoSel === "vencida"

  /** Filas de Pendientes/Vencidas: del set completo, con el rango de emisión aplicado acá. */
  const filasAbiertas = useMemo(() => {
    if (!modoAbiertas) return []
    const d = fromDate ? isoToLocal(fromDate) : null
    const h = toDate ? isoToLocal(toDate) : null
    return abiertas.filter((f) => {
      if (f.estado !== estadoSel) return false
      const fecha = parseLocalDate(f.emision)
      return (!d || !fecha || fecha >= d) && (!h || !fecha || fecha <= h)
    })
  }, [modoAbiertas, abiertas, estadoSel, fromDate, toDate])

  const facturas = modoAbiertas ? filasAbiertas : pag.items

  function aplicar(estados: Set<FacturaEstado>, fechas: { desde: string; hasta: string }) {
    setSelected(new Set())
    const sel = [...estados][0]
    // Pendientes/Vencidas no consultan: se recalculan en pantalla sobre las abiertas.
    if (sel === "pendiente" || sel === "vencida") return
    const params = new URLSearchParams()
    if (sel) params.set("estado", sel) // la ruta traduce pagada→closed, anulada→void
    if (fechas.desde) params.set("desde", fechas.desde)
    if (fechas.hasta) params.set("hasta", fechas.hasta)
    void pag.filtrar(params)
  }

  function toggleEstado(estado: FacturaEstado) {
    // Un chip por vez. Tocar el que ya está activo lo apaga (vuelve a Todos).
    const next = filterEstados.has(estado) ? new Set<FacturaEstado>() : new Set([estado])
    setFilterEstados(next)
    aplicar(next, fechasRef.current)
  }

  function cambiarFecha(patch: Partial<typeof fechasRef.current>) {
    fechasRef.current = { ...fechasRef.current, ...patch }
    aplicar(filterEstados, fechasRef.current)
  }

  // Abre la factura indicada por URL (?factura=NUMERO[&alegra=ID]) — lo usan las notificaciones.
  // 1. Con el id de Alegra en el link se abre directo (el endpoint del PDF valida que sea del
  //    cliente: un id ajeno da 404).
  // 2. Sin él (notificaciones anteriores a 0022) se busca por número en la página cargada y en
  //    las abiertas COMPLETAS: las notificaciones son por facturas impagas, así que ahí está
  //    aunque sea vieja. Antes caía en la búsqueda, que ya no existe.
  const [prevOpen, setPrevOpen] = useState<string | undefined>(undefined)
  if (openFacturaId && prevOpen !== openFacturaId) {
    setPrevOpen(openFacturaId)
    const target = primeraPagina.find((f) => f.id === openFacturaId) ?? abiertas.find((f) => f.id === openFacturaId)
    if (openFacturaAlegraId) {
      // El visor usa solo `id` (título) y `alegraId`.
      setPdfFactura({ ...(target ?? ({} as Factura)), id: openFacturaId, alegraId: openFacturaAlegraId })
    } else if (target?.alegraId) {
      setPdfFactura(target)
    }
  }

  const selectedFacturas = facturas.filter((f) => selected.has(f.id))
  const selectedTotal = selectedFacturas.reduce((s, f) => s + saldoDe(f), 0)

  const facturaColumns: TableColumn<Factura>[] = [
    {
      key: "id",
      header: "Comprobante",
      render: (f) => (
        <>
          <div className="font-medium" style={{ color: "var(--ink)" }}>{f.id}</div>
          <div className="text-xs" style={{ color: "var(--ink-faint)" }}>{f.tipo}</div>
        </>
      ),
    },
    {
      key: "emision",
      header: "Emisión",
      hideBelow: "sm",
      className: "text-xs",
      headerClassName: "text-xs",
      render: (f) => <span style={{ color: "var(--ink-soft)" }}>{f.emision}</span>,
    },
    {
      key: "vencimiento",
      header: "Vencimiento",
      className: "text-xs",
      render: (f) => <span style={{ color: "var(--ink-soft)" }}>{f.vencimiento}</span>,
    },
    {
      key: "importe",
      header: "Importe",
      align: "right",
      className: "font-medium tabular-nums",
      render: (f) =>
        esPagoParcial(f) ? (
          <div className="inline-flex flex-col items-end gap-1">
            <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{fmt(f.importe)}</span>
            <Progress
              value={f.pagado ?? 0}
              max={f.importe}
              size="sm"
              className="w-[92px]"
            />
            <span className="font-bold" style={{ fontSize: 12.5 }}>Saldo {fmt(saldoDe(f))}</span>
          </div>
        ) : (
          <span style={{ color: "var(--ink)" }}>{fmt(f.importe)}</span>
        ),
    },
    {
      key: "estado",
      header: "Estado",
      hideBelow: "md",
      render: (f) => (
        <div className="inline-flex flex-col items-start gap-1">
          <FacturaBadge estado={f.estado} />
          {esPagoParcial(f) && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: "var(--blue)" }}>
              <span className="rounded-full" style={{ width: 5, height: 5, background: "var(--blue)" }} />
              Pago parcial
            </span>
          )}
        </div>
      ),
    },
    {
      key: "acciones",
      header: "Acciones",
      align: "right",
      headerClassName: "text-xs",
      render: (f) => (
        <div className="flex items-center justify-end gap-2">
          <ActionBtn
            onClick={() => setPdfFactura(f)}
            label={f.alegraId ? "Ver PDF" : "PDF no disponible"}
            disabled={!f.alegraId}
          >
            <EyeIcon />
          </ActionBtn>
          <ActionBtn
            onClick={() => descargarDocumento("factura", f)}
            label={f.alegraId ? "Descargar PDF" : "PDF no disponible"}
            disabled={!f.alegraId}
          >
            <DownloadIcon />
          </ActionBtn>
        </div>
      ),
    },
  ]

  function openWhatsAppModal(intent: WhatsAppFacturaIntent = "pagar") {
    setWhatsappModal({ facturas: selectedFacturas, intent })
  }

  return (
    <>
      <Toolbar
        fromDate={fromDate}
        toDate={toDate}
        onFromDateChange={(v) => { setFromDate(v); cambiarFecha({ desde: v }) }}
        onToDateChange={(v) => { setToDate(v); cambiarFecha({ hasta: v }) }}
        multiFilterOptions={[
          { value: "pendiente", label: "Pendientes" },
          { value: "vencida", label: "Vencidas" },
          { value: "pagada", label: "Pagadas" },
          { value: "anulada", label: "Anuladas" },
        ]}
        activeFilters={filterEstados}
        onToggleFilter={(v) => toggleEstado(v as FacturaEstado)}
        onClearFilters={() => { setFilterEstados(new Set()); aplicar(new Set(), fechasRef.current) }}
      />

      {(
        <SelectionBar
          count={selected.size}
          total={selectedTotal}
          onClear={() => setSelected(new Set())}
          onDownload={() => descargarVarios("factura", selectedFacturas)}
          onWhatsapp={() => openWhatsAppModal("pagar")}
          itemLabel="factura"
        />
      )}

      <Table<Factura>
        className="mt-2"
        columns={facturaColumns}
        rows={facturas}
        rowKey={(f) => f.id}
        selectable
        selectedKeys={Array.from(selected)}
        onSelectionChange={(keys) => setSelected(new Set(keys))}
        empty="No hay facturas para mostrar"
      />

      {/* Pendientes/Vencidas vienen completas: no hay páginas que recorrer. */}
      {!modoAbiertas && (
        <Paginacion
          desde={pag.desde}
          cantidad={pag.items.length}
          total={pag.total}
          hayMas={pag.hayMas}
          cargando={pag.cargando}
          error={pag.error}
          pageSize={PAGINA}
          onIrAPagina={(start) => { setSelected(new Set()); void pag.irAPagina(start) }}
          onCargarMas={() => void pag.cargarMas()}
        />
      )}

      {pdfFactura?.alegraId && (
        <PdfModal kind="factura" doc={pdfFactura} titulo={`Factura ${pdfFactura.id}`} onClose={() => setPdfFactura(null)} />
      )}

      {whatsappModal && (
        <WhatsAppFacturasModal
          facturas={whatsappModal.facturas}
          razonsocial={razonsocial}
          cuit={cuit}
          tenantName={tenantName}
          whatsappNumber={whatsappNumber}
          initialIntent={whatsappModal.intent}
          onClose={() => setWhatsappModal(null)}
        />
      )}
    </>
  )
}

// ── Pagos Table ───────────────────────────────────────────────────────────────

function PagosTable({
  pagos: primeraPagina,
  total: totalInicial,
  razonsocial,
  cuit,
  tenantName,
  whatsappNumber,
  receiptsEnabled = false,
  comprobantes = [],
  comprobantesTotal = 0,
}: {
  pagos: Pago[]
  total: number
  razonsocial: string
  cuit: string
  tenantName: string
  whatsappNumber: string
  receiptsEnabled?: boolean
  comprobantes?: ComprobanteInformado[]
  comprobantesTotal?: number
}) {
  // Sin filtros, sin búsqueda y sin orden por columna: Alegra no filtra pagos por fecha
  // (date_afterOrNow se ignora, probado) ni busca por número, y ordenar por columna ordenaría
  // solo la página cargada. Lo que se muestra es exactamente lo que Alegra devuelve.
  const pag = usePaginado<Pago>({
    url: "/api/portal/pagos",
    pick: (d) => (d.pagos as Pago[]) ?? [],
    inicial: primeraPagina,
    totalInicial,
    pageSize: PAGINA_PAGOS,
  })
  const pagos = pag.items

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [modalPago, setModalPago] = useState<Pago | null>(null)
  const [pdfPago, setPdfPago] = useState<Pago | null>(null)
  const [wspModal, setWspModal] = useState(false)
  const [informarPago, setInformarPago] = useState(false)

  const selectedPagos = pagos.filter((p) => selected.has(p.id))
  const selectedTotal = selectedPagos.reduce((s, p) => s + p.monto, 0)

  const pagoColumns: TableColumn<Pago>[] = [
    {
      key: "id",
      header: "Recibo",
      render: (p) => (
        <>
          <div className="font-medium" style={{ color: "var(--ink)" }}>{p.id}</div>
          <div className="text-xs" style={{ color: "var(--ink-faint)" }}>Recibo de pago</div>
        </>
      ),
    },
    {
      key: "fecha",
      header: "Fecha",
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.fecha}</span>,
    },
    {
      key: "facturaAsociada",
      header: "Facturas asociadas",
      hideBelow: "md",
      className: "text-xs",
      render: (p) => (
        <span className="inline-flex items-center gap-1.5" style={{ color: "var(--ink-soft)" }}>
          {p.facturas[0]?.factura}
          {p.facturas.length > 1 && (
            <span
              className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
              style={{ background: "var(--blue-soft)", color: "var(--blue)" }}
              title={p.facturas.slice(1).map((imp) => imp.factura).join(", ")}
            >
              +{p.facturas.length - 1}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "medio",
      header: "Medio",
      hideBelow: "sm",
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.medio}</span>,
    },
    {
      key: "monto",
      header: "Monto pagado",
      align: "right",
      className: "font-medium tabular-nums",
      render: (p) => <span style={{ color: "var(--green)" }}>{fmt(p.monto)}</span>,
    },
    {
      key: "acciones",
      header: "Acciones",
      align: "right",
      headerClassName: "text-xs",
      render: (p) => (
        <div className="flex items-center justify-end gap-2">
          <ActionBtn onClick={() => setPdfPago(p)} label={p.alegraId ? "Ver PDF" : "PDF no disponible"} disabled={!p.alegraId}>
            <EyeIcon />
          </ActionBtn>
          <ActionBtn onClick={() => descargarDocumento("pago", p)} label={p.alegraId ? "Descargar PDF" : "PDF no disponible"} disabled={!p.alegraId}>
            <DownloadIcon />
          </ActionBtn>
        </div>
      ),
    },
  ]

  return (
    <>
      <SelectionBar
        count={selected.size}
        total={selectedTotal}
        onClear={() => setSelected(new Set())}
        onDownload={() => descargarVarios("pago", selectedPagos)}
        onWhatsapp={() => setWspModal(true)}
        itemLabel="recibo"
      />

      {wspModal && (
        <WhatsAppPagosModal
          pagos={selectedPagos}
          razonsocial={razonsocial}
          cuit={cuit}
          tenantName={tenantName}
          whatsappNumber={whatsappNumber}
          onClose={() => setWspModal(false)}
        />
      )}

      {informarPago && <InformarPagoModal onClose={() => setInformarPago(false)} />}

      {/* Botón "Informar pago" (solo con storage configurado). Pagos no usa filtros: el slot
          extraActions es todo lo que renderiza el Toolbar. */}
      {receiptsEnabled && (
        <Toolbar
          hideFilter
          extraActions={
            <Button size="sm" onClick={() => setInformarPago(true)}>
              <Plus size={14} strokeWidth={2} />
              Informar pago
            </Button>
          }
        />
      )}

      {/* Historial de comprobantes informados (B), sobre la tabla de Alegra. Solo aparece si
          hay al menos uno: tras el primer informe, el `router.refresh()` del modal trae la
          primera página nueva y el bloque se monta. */}
      {comprobantesTotal > 0 && (
        <ComprobantesInformados comprobantes={comprobantes} total={comprobantesTotal} />
      )}

      <Table<Pago>
        className="mt-2"
        columns={pagoColumns}
        rows={pagos}
        rowKey={(p) => p.id}
        onRowClick={(p) => setModalPago(p)}
        selectable
        selectedKeys={Array.from(selected)}
        onSelectionChange={(keys) => setSelected(new Set(keys))}
        empty="No hay pagos para mostrar"
      />

      <Paginacion
        desde={pag.desde}
        cantidad={pagos.length}
        total={pag.total}
        hayMas={pag.hayMas}
        cargando={pag.cargando}
        error={pag.error}
        pageSize={PAGINA_PAGOS}
        onIrAPagina={(start) => { setSelected(new Set()); void pag.irAPagina(start) }}
        onCargarMas={() => void pag.cargarMas()}
      />

      {pdfPago?.alegraId && (
        <PdfModal kind="pago" doc={pdfPago} titulo={`Recibo ${pdfPago.id}`} onClose={() => setPdfPago(null)} />
      )}

      {modalPago && <PagoModal pago={modalPago} onClose={() => setModalPago(null)} />}
    </>
  )
}

// ── Presupuestos Table ────────────────────────────────────────────────────────

const PRESUPUESTO_ESTADO_LABELS: Record<PresupuestoEstado, string> = {
  vigente: "Vigente",
  vencido: "Vencido",
  aceptado: "Aceptado",
}

function PresupuestoBadge({ estado }: { estado: PresupuestoEstado }) {
  if (estado === "vencido") return <Badge tone="danger">{PRESUPUESTO_ESTADO_LABELS[estado]}</Badge>
  if (estado === "aceptado") return <Badge tone="success">{PRESUPUESTO_ESTADO_LABELS[estado]}</Badge>
  return (
    <Badge className="bg-primary-soft text-primary">{PRESUPUESTO_ESTADO_LABELS[estado]}</Badge>
  )
}

/** Estados de presupuesto que Alegra sabe filtrar: `billed` y `unbilled`. */
type FiltroPresupuesto = "aceptado" | "sin-aceptar"

function PresupuestosTable({
  presupuestos: primeraPagina,
  total: totalInicial,
  razonsocial,
  cuit,
  tenantName,
  whatsappNumber,
}: {
  presupuestos: Presupuesto[]
  total: number
  razonsocial: string
  cuit: string
  tenantName: string
  whatsappNumber: string
}) {
  // Filtros que resuelve Alegra (probado): estado → status=billed|unbilled, y fecha de emisión.
  // "Vigentes" y "Vencidos" ya no son chips separados: los dos son `unbilled` y los separa el
  // vencimiento, que Alegra no filtra. Se juntan en "Sin aceptar" y el vencido se ve en el badge.
  const pag = usePaginado<Presupuesto>({
    url: "/api/portal/presupuestos",
    pick: (d) => (d.presupuestos as Presupuesto[]) ?? [],
    inicial: primeraPagina,
    totalInicial,
    pageSize: PAGINA_PRESUPUESTOS,
  })
  const presupuestos = pag.items

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pdfPresupuesto, setPdfPresupuesto] = useState<Presupuesto | null>(null)
  const [wspModal, setWspModal] = useState<WhatsAppPresupuestoIntent | null>(null)
  const [filtro, setFiltro] = useState<Set<FiltroPresupuesto>>(new Set())
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  // Últimos valores en el acto: "Limpiar" cambia desde y hasta en el mismo click.
  const filtrosRef = useRef({ filtro, desde: fromDate, hasta: toDate })

  function aplicar(patch: Partial<typeof filtrosRef.current>) {
    const f = { ...filtrosRef.current, ...patch }
    filtrosRef.current = f
    const params = new URLSearchParams()
    // Alegra acepta un solo status: con los dos chips (o ninguno) no se filtra por estado.
    if (f.filtro.size === 1) params.set("estado", [...f.filtro][0])
    if (f.desde) params.set("desde", f.desde)
    if (f.hasta) params.set("hasta", f.hasta)
    setSelected(new Set())
    void pag.filtrar(params)
  }

  function toggleFiltro(v: FiltroPresupuesto) {
    const next = new Set(filtrosRef.current.filtro)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    setFiltro(next)
    aplicar({ filtro: next })
  }

  const selectedPresupuestos = presupuestos.filter((p) => selected.has(p.id))
  const selectedTotal = selectedPresupuestos.reduce((s, p) => s + p.total, 0)

  const presupuestoColumns: TableColumn<Presupuesto>[] = [
    {
      key: "id",
      header: "Presupuesto",
      render: (p) => <div className="font-medium" style={{ color: "var(--ink)" }}>{p.id}</div>,
    },
    {
      key: "fecha",
      header: "Emisión",
      hideBelow: "sm",
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.fecha}</span>,
    },
    {
      key: "validoHasta",
      header: "Válido hasta",
      hideBelow: "md",
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.validoHasta}</span>,
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      className: "font-medium tabular-nums",
      render: (p) => <span style={{ color: "var(--ink)" }}>{fmt(p.total)}</span>,
    },
    {
      key: "estado",
      header: "Estado",
      hideBelow: "md",
      render: (p) => <PresupuestoBadge estado={p.estado} />,
    },
    {
      key: "acciones",
      header: "Acciones",
      align: "right",
      headerClassName: "text-xs",
      render: (p) => (
        <div className="flex items-center justify-end gap-2">
          <ActionBtn onClick={() => setPdfPresupuesto(p)} label={p.alegraId ? "Ver PDF" : "PDF no disponible"} disabled={!p.alegraId}>
            <EyeIcon />
          </ActionBtn>
          <ActionBtn onClick={() => descargarDocumento("presupuesto", p)} label={p.alegraId ? "Descargar PDF" : "PDF no disponible"} disabled={!p.alegraId}>
            <DownloadIcon />
          </ActionBtn>
        </div>
      ),
    },
  ]

  return (
    <>
      <Toolbar
        fromDate={fromDate}
        toDate={toDate}
        onFromDateChange={(v) => { setFromDate(v); aplicar({ desde: v }) }}
        onToDateChange={(v) => { setToDate(v); aplicar({ hasta: v }) }}
        multiFilterOptions={[
          { value: "sin-aceptar", label: "Sin aceptar" },
          { value: "aceptado", label: "Aceptados" },
        ]}
        activeFilters={filtro}
        onToggleFilter={(v) => toggleFiltro(v as FiltroPresupuesto)}
        onClearFilters={() => { setFiltro(new Set()); aplicar({ filtro: new Set() }) }}
      />

      <SelectionBar
        count={selected.size}
        total={selectedTotal}
        onClear={() => setSelected(new Set())}
        onDownload={() => descargarVarios("presupuesto", selectedPresupuestos)}
        onWhatsapp={() => setWspModal("avanzar")}
        itemLabel="presupuesto"
      />

      {wspModal && (
        <WhatsAppPresupuestosModal
          presupuestos={selectedPresupuestos}
          razonsocial={razonsocial}
          cuit={cuit}
          tenantName={tenantName}
          whatsappNumber={whatsappNumber}
          initialIntent={wspModal}
          onClose={() => setWspModal(null)}
        />
      )}

      <Table<Presupuesto>
        className="mt-2"
        columns={presupuestoColumns}
        rows={presupuestos}
        rowKey={(p) => p.id}
        selectable
        selectedKeys={Array.from(selected)}
        onSelectionChange={(keys) => setSelected(new Set(keys))}
        empty="No hay presupuestos para mostrar"
      />

      <Paginacion
        desde={pag.desde}
        cantidad={presupuestos.length}
        total={pag.total}
        hayMas={pag.hayMas}
        cargando={pag.cargando}
        error={pag.error}
        pageSize={PAGINA_PRESUPUESTOS}
        onIrAPagina={(start) => { setSelected(new Set()); void pag.irAPagina(start) }}
        onCargarMas={() => void pag.cargarMas()}
      />

      {pdfPresupuesto?.alegraId && (
        <PdfModal kind="presupuesto" doc={pdfPresupuesto} titulo={`Presupuesto ${pdfPresupuesto.id}`} onClose={() => setPdfPresupuesto(null)} />
      )}
    </>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

interface ToolbarProps {
  filterOptions?: { value: string; label: string; tooltip?: string }[]
  filterValue?: string
  setFilterValue?: (v: string) => void
  multiFilterOptions?: { value: string; label: string }[]
  activeFilters?: Set<string>
  onToggleFilter?: (v: string) => void
  onClearFilters?: () => void
  hideFilter?: boolean
  fromDate?: string
  toDate?: string
  onFromDateChange?: (v: string) => void
  onToDateChange?: (v: string) => void
  dateFilterField?: "emision" | "vencimiento"
  onDateFilterFieldChange?: (field: "emision" | "vencimiento") => void
  extraActions?: React.ReactNode
}

function Toolbar(props: ToolbarProps) {
  const {
    filterOptions,
    filterValue,
    setFilterValue,
    multiFilterOptions,
    activeFilters,
    onToggleFilter,
    onClearFilters,
    hideFilter,
    fromDate,
    toDate,
    onFromDateChange,
    onToDateChange,
    dateFilterField,
    onDateFilterFieldChange,
    extraActions,
  } = props

  const [dateOpen, setDateOpen] = useState(false)
  const [datePanelPos, setDatePanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const dateButtonRef = useRef<HTMLButtonElement | null>(null)
  const datePanelRef = useRef<HTMLDivElement | null>(null)

  function computeDatePanelPos() {
    if (!dateButtonRef.current) return
    const rect = dateButtonRef.current.getBoundingClientRect()
    const panelWidth = 252
    const panelHeight = datePanelRef.current?.offsetHeight ?? 380
    const left = Math.min(rect.left, window.innerWidth - panelWidth - 12)
    // Si no entra abajo, abrir hacia arriba; si tampoco, clavar al borde inferior
    let top = rect.bottom + 8
    if (top + panelHeight > window.innerHeight - 8) {
      top = rect.top - panelHeight - 8
      if (top < 8) top = window.innerHeight - panelHeight - 8
    }
    setDatePanelPos({ top: Math.max(8, top), left: Math.max(8, left) })
  }

  function toggleDateOpen() {
    if (!dateOpen) computeDatePanelPos()
    setDateOpen((prev) => !prev)
  }

  useEffect(() => {
    if (!dateOpen) return
    function handleReposition() {
      computeDatePanelPos()
    }
    handleReposition()
    window.addEventListener("scroll", handleReposition, true)
    window.addEventListener("resize", handleReposition)
    return () => {
      window.removeEventListener("scroll", handleReposition, true)
      window.removeEventListener("resize", handleReposition)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateOpen])

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!dateOpen) return
      if (
        datePanelRef.current &&
        dateButtonRef.current &&
        !datePanelRef.current.contains(event.target as Node) &&
        !dateButtonRef.current.contains(event.target as Node)
      ) {
        setDateOpen(false)
      }
    }
    function handleKeydown(event: KeyboardEvent) {
      if (!dateOpen) return
      if (event.key === "Escape") {
        setDateOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKeydown)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKeydown)
    }
  }, [dateOpen])

  const hasDateFilter = Boolean(onFromDateChange && onToDateChange)
  const activeDateField = dateFilterField ?? "emision"
  const [calendarMonth, setCalendarMonth] = useState(() => new Date())

  const selectedFrom = fromDate ? isoToLocal(fromDate) : null
  const selectedTo = toDate ? isoToLocal(toDate) : null
  const rangeStart = selectedFrom && selectedTo && selectedFrom <= selectedTo ? selectedFrom : selectedTo && selectedFrom ? selectedTo : selectedFrom
  const rangeEnd = selectedFrom && selectedTo && selectedFrom <= selectedTo ? selectedTo : selectedFrom && selectedTo ? selectedFrom : selectedTo

  const days = useMemo(() => {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1)
    const startWeekday = (firstOfMonth.getDay() + 6) % 7 // Monday = 0
    const startDate = new Date(firstOfMonth)
    startDate.setDate(firstOfMonth.getDate() - startWeekday)

    return Array.from({ length: 42 }).map((_, index) => {
      const day = new Date(startDate)
      day.setDate(startDate.getDate() + index)
      return day
    })
  }, [calendarMonth])

  const weekDayLabels = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"]

  function formatMonthLabel(date: Date) {
    return date.toLocaleString("es-AR", { month: "long", year: "numeric" })
  }

  function formatIso(date: Date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
  }

  function sameDate(a: Date, b: Date | null) {
    return Boolean(b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate())
  }

  function selectDay(day: Date) {
    const dayIso = formatIso(day)
    if (!selectedFrom || (selectedFrom && selectedTo)) {
      onFromDateChange?.(dayIso)
      onToDateChange?.("")
      return
    }
    if (day < selectedFrom) {
      onFromDateChange?.(dayIso)
      onToDateChange?.("")
      return
    }
    onToDateChange?.(dayIso)
  }

  function clearDates() {
    onFromDateChange?.("")
    onToDateChange?.("")
  }

  return (
    <div className="flex items-center gap-2">
      {/* Chips row — scrollable, but overflow clips absolute children */}
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5 flex-1 min-w-0" style={{ scrollbarWidth: "none" }}>
        {/* Multi-select filter chips */}
        {!hideFilter && multiFilterOptions && multiFilterOptions.length > 0 && (
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={onClearFilters}
              className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
              style={
                activeFilters?.size === 0
                  ? { background: "var(--blue)", color: "white" }
                  : { background: "var(--bg)", color: "var(--ink-soft)", border: "1px solid var(--border)" }
              }
            >
              Todos
            </button>
            {multiFilterOptions.map((opt) => {
              const isActive = activeFilters?.has(opt.value)
              return (
                <button
                  key={opt.value}
                  onClick={() => onToggleFilter?.(opt.value)}
                  className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                  style={
                    isActive
                      ? { background: "var(--blue-soft)", color: "var(--blue)", border: "1px solid var(--blue)" }
                      : { background: "var(--bg)", color: "var(--ink-soft)", border: "1px solid var(--border)" }
                  }
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        )}

        {/* Single-select filter tabs (para pagos/presupuestos) */}
        {!hideFilter && filterOptions && filterOptions.length > 0 && (
          <div className="flex gap-1 rounded-[var(--radius)] p-0.5 shrink-0" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
            {filterOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFilterValue?.(opt.value)}
                className="px-2.5 py-1 rounded-[6px] text-xs font-medium transition-all"
                style={
                  filterValue === opt.value
                    ? { background: "var(--card)", color: "var(--ink)", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }
                    : { background: "transparent", color: "var(--ink-soft)" }
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

      {/* Date filter — popup renders position:fixed so overflow doesn't clip it */}
      {hasDateFilter && (
        <div className="shrink-0">
          <button
            ref={dateButtonRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={dateOpen}
            onClick={toggleDateOpen}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all"
            style={
              fromDate
                ? { background: "var(--blue-soft)", color: "var(--blue)", border: "1px solid var(--blue)" }
                : { background: "var(--bg)", color: "var(--ink-soft)", border: "1px solid var(--border)" }
            }
          >
            <Calendar size={12} strokeWidth={2} />
            <span>{(() => {
              if (!fromDate) return "Fecha"
              const prefix = !onDateFilterFieldChange ? "" : activeDateField === "vencimiento" ? "Vence: " : "Emit.: "
              const fmt2 = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}` }
              return toDate && toDate !== fromDate
                ? `${prefix}${fmt2(fromDate)} – ${fmt2(toDate)}`
                : `${prefix}${fmt2(fromDate)}`
            })()}</span>
            {fromDate && (
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); clearDates() }}
                aria-label="Limpiar filtro de fecha"
                className="flex items-center justify-center"
              >
                <X size={11} strokeWidth={2.5} />
              </span>
            )}
          </button>

          {dateOpen && (
            <div
              ref={datePanelRef}
              className="fixed w-[252px] rounded-[12px] border border-[var(--border)] bg-white shadow-[0_12px_32px_rgba(16,24,40,0.14)] p-3 z-50"
              style={{ top: datePanelPos.top, left: datePanelPos.left }}
              role="dialog"
              aria-label="Seleccionar fecha o rango"
            >
                {onDateFilterFieldChange && (
                  <div className="flex gap-1 bg-[var(--bg)] border border-[var(--border)] rounded-[8px] p-0.5 mb-2.5">
                    <button
                      type="button"
                      onClick={() => onDateFilterFieldChange("emision")}
                      className="flex-1 rounded-[6px] px-2 py-1 text-xs font-semibold transition-all"
                      style={
                        activeDateField === "emision"
                          ? { background: "white", color: "var(--ink)", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }
                          : { background: "transparent", color: "var(--ink-soft)" }
                      }
                    >
                      Emisión
                    </button>
                    <button
                      type="button"
                      onClick={() => onDateFilterFieldChange("vencimiento")}
                      className="flex-1 rounded-[6px] px-2 py-1 text-xs font-semibold transition-all"
                      style={
                        activeDateField === "vencimiento"
                          ? { background: "white", color: "var(--ink)", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }
                          : { background: "transparent", color: "var(--ink-soft)" }
                      }
                    >
                      Vencimiento
                    </button>
                  </div>
                )}

                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={() => setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))}
                    className="flex h-6 w-6 items-center justify-center rounded-[6px] text-sm transition-all"
                    style={{ color: "var(--ink-soft)" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
                  >
                    ‹
                  </button>
                  <span className="text-xs font-semibold capitalize" style={{ color: "var(--ink)" }}>
                    {formatMonthLabel(calendarMonth)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))}
                    className="flex h-6 w-6 items-center justify-center rounded-[6px] text-sm transition-all"
                    style={{ color: "var(--ink-soft)" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
                  >
                    ›
                  </button>
                </div>

                <div className="grid grid-cols-7 text-center text-[10px] font-semibold mb-1" style={{ color: "var(--ink-faint)" }}>
                  {weekDayLabels.map((label) => (
                    <div key={label}>{label}</div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-0.5">
                  {days.map((day) => {
                    const isCurrentMonth = day.getMonth() === calendarMonth.getMonth()
                    const isSelected = sameDate(day, selectedFrom) || sameDate(day, selectedTo)
                    const inRange = rangeStart && rangeEnd && day >= rangeStart && day <= rangeEnd
                    return (
                      <button
                        key={day.toISOString()}
                        type="button"
                        onClick={() => selectDay(day)}
                        className="h-7 rounded-[6px] text-xs transition-all"
                        style={{
                          background: isSelected ? "var(--blue)" : inRange ? "var(--blue-soft)" : "transparent",
                          color: isSelected ? "white" : isCurrentMonth ? "var(--ink)" : "var(--ink-faint)",
                          opacity: isCurrentMonth ? 1 : 0.4,
                        }}
                      >
                        {day.getDate()}
                      </button>
                    )
                  })}
                </div>

                <div className="flex items-center justify-between mt-2.5">
                  <button
                    type="button"
                    onClick={clearDates}
                    className="text-xs font-medium px-2 py-1 rounded-[6px] transition-all"
                    style={{ color: "var(--ink-soft)" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
                  >
                    Limpiar
                  </button>
                  <button
                    type="button"
                    onClick={() => setDateOpen(false)}
                    className="rounded-[7px] bg-[var(--blue)] px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

      {/* Sin búsqueda: todo viene paginado de Alegra, que no busca por número. Una lupa que
          mira solo la página cargada le hace creer al cliente que la factura no existe. */}
      {/* Extra actions (e.g. "Adjuntar comprobante") — extremo derecho */}
      {extraActions && <div className="ml-auto shrink-0 flex items-center">{extraActions}</div>}
      </div>
    </div>
  )
}

// ── Facturas Selection Bar ────────────────────────────────────────────────────


// ── WhatsApp Facturas Modal ─────────────────────────────────────────────────

function WhatsAppFacturasModal({
  facturas,
  razonsocial,
  cuit,
  tenantName,
  whatsappNumber,
  initialIntent,
  onClose,
}: {
  facturas: Factura[]
  razonsocial: string
  cuit: string
  tenantName: string
  whatsappNumber: string
  initialIntent: WhatsAppFacturaIntent
  onClose: () => void
}) {
  const [intent, setIntent] = useState<WhatsAppFacturaIntent>(initialIntent)
  const [message, setMessage] = useState(() =>
    buildFacturasWhatsAppMessage(initialIntent, tenantName, razonsocial, cuit, facturas, fmt),
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Al cambiar el intent se regenera el mensaje, descartando ediciones previas.
  const [prevIntent, setPrevIntent] = useState(intent)
  if (prevIntent !== intent) {
    setPrevIntent(intent)
    setMessage(buildFacturasWhatsAppMessage(intent, tenantName, razonsocial, cuit, facturas, fmt))
  }

  // Tras regenerar el mensaje, devuelve el foco al textarea con el cursor al final.
  useEffect(() => {
    setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
  }, [intent])

  const intents: { value: WhatsAppFacturaIntent; title: string; subtitle: string }[] = [
    { value: "pagar", title: "Quiero pagar", subtitle: "Coordinar el pago de estas facturas" },
    { value: "consulta", title: "Tengo una consulta", subtitle: "Preguntar algo sobre estas facturas" },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(22,25,29,0.5)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg flex flex-col"
        style={{
          background: "var(--card)",
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "var(--wsp)", color: "white" }}
              >
                <WspIcon size={20} />
              </div>
              <div>
                <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>
                  Enviar por WhatsApp
                </h2>
                <p className="text-sm mt-1" style={{ color: "var(--ink-soft)" }}>
                  Se abrirá WhatsApp con el mensaje listo para enviar al local. Podés editarlo antes.
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full transition-all shrink-0"
              style={{ color: "var(--ink-soft)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
            >
              <X size={16} strokeWidth={1.8} color="currentColor" />
            </button>
          </div>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <div>
            <p
              className="text-xs font-semibold uppercase tracking-wide mb-3"
              style={{ color: "var(--ink-faint)" }}
            >
              ¿Sobre qué querés escribir?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {intents.map((item) => {
                const selected = intent === item.value
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setIntent(item.value)}
                    className="text-left p-4 rounded-[var(--radius)] transition-all"
                    style={{
                      border: selected ? "2px solid var(--blue)" : "1px solid var(--border)",
                      background: selected ? "var(--blue-soft)" : "var(--card)",
                    }}
                  >
                    <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {item.title}
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--ink-soft)" }}>
                      {item.subtitle}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <p
              className="text-xs font-semibold uppercase tracking-wide mb-2"
              style={{ color: "var(--ink-faint)" }}
            >
              Mensaje
            </p>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={8}
              className="w-full text-sm leading-relaxed p-3 rounded-[var(--radius)] resize-y outline-none transition-all"
              style={{
                border: "1px solid var(--border)",
                color: "var(--ink)",
                background: "var(--bg)",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--blue)" }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)" }}
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all"
              style={{ border: "1px solid var(--border)", color: "var(--ink-soft)", background: "transparent" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
            >
              Cancelar
            </button>
            <button
              onClick={() => openWhatsApp(whatsappNumber, message)}
              className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all text-white"
              style={{ background: "var(--wsp)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--wsp-strong)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--wsp)" }}
            >
              <WspIcon />
              Abrir WhatsApp
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Selection Bar ─────────────────────────────────────────────────────────────

function SelectionBar({
  count,
  total,
  onClear,
  onDownload,
  onWhatsapp,
  itemLabel = "factura",
}: {
  count: number
  total: number
  onClear: () => void
  onDownload: () => void
  onWhatsapp?: () => void
  itemLabel?: string
}) {
  const label = `${count} ${itemLabel}${count !== 1 ? "s" : ""} seleccionada${count !== 1 ? "s" : ""}`
  return (
    <DSSelectionBar
      className="my-3"
      count={count}
      label={label}
      summary={`Total: ${fmt(total)}`}
      emptyHint="Seleccioná para descargar o consultar"
      onClear={onClear}
    >
      <Button
        size="sm"
        onClick={onDownload}
        className="bg-white/20 text-on-primary hover:bg-white/30"
      >
        <DownloadIcon />
        Descargar
      </Button>
      {onWhatsapp && (
        <Button
          size="sm"
          onClick={onWhatsapp}
          className="bg-[var(--wsp)] text-white hover:opacity-90"
        >
          <WspIcon size={14} />
          Consultar
        </Button>
      )}
    </DSSelectionBar>
  )
}

// ── Modal base ────────────────────────────────────────────────────────────────

function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={title}
      className="max-w-2xl"
    >
      {children}
    </Dialog>
  )
}

// ── Pago Modal ────────────────────────────────────────────────────────────────


/**
 * Visor del PDF dentro de la página.
 *
 * `<iframe>` y no fetch + blob: el endpoint ya sirve el PDF inline y el navegador lo
 * renderiza con su propio visor, que trae zoom, búsqueda e impresión gratis.
 *
 * El botón de abrir en pestaña no es decorativo: el visor embebido de Safari en iPhone
 * muestra solo la primera página, así que ahí hace falta la salida.
 */
function PdfModal({ kind, doc, titulo, onClose }: { kind: DocKind; doc: DocumentoRef; titulo: string; onClose: () => void }) {
  const url = documentoUrl(kind, doc.alegraId!)

  // El PDF se pide con fetch antes de mostrarlo, en vez de apuntar el iframe directo al
  // endpoint: un iframe no expone el status de la respuesta, así que un 404 (link viejo, o un
  // id ajeno puesto a mano en la URL) o un 502 (Alegra caído) se veía como JSON crudo adentro
  // del visor. Con fetch se distingue el error y se muestra un mensaje; el iframe recibe el
  // PDF ya descargado como blob, así que no se baja dos veces.
  const [estado, setEstado] = useState<{ blobUrl: string } | { error: string } | null>(null)
  useEffect(() => {
    let cancelado = false
    let blobUrl: string | null = null
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.json().then((d) => d.error as string).catch(() => null)
          if (!cancelado) setEstado({ error: msg ?? "No pudimos abrir el documento" })
          return
        }
        const blob = await res.blob()
        blobUrl = URL.createObjectURL(blob)
        if (!cancelado) setEstado({ blobUrl })
      })
      .catch(() => {
        if (!cancelado) setEstado({ error: "Error de conexión. Intentá de nuevo." })
      })
    return () => {
      cancelado = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [url])

  const alto = { height: "min(70vh, 780px)" }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={titulo} size="lg" className="max-w-4xl">
      <div className="flex flex-col gap-3">
        {estado === null && (
          <div className="w-full flex items-center justify-center rounded-[var(--radius)] text-sm" style={{ ...alto, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink-soft)" }}>
            Cargando documento…
          </div>
        )}
        {estado && "error" in estado && (
          <div className="w-full flex flex-col items-center justify-center gap-2 p-6 rounded-[var(--radius)] text-sm text-center" style={{ minHeight: 220, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink-soft)" }}>
            <Info size={20} strokeWidth={1.6} color="currentColor" />
            <p>{estado.error}</p>
          </div>
        )}
        {estado && "blobUrl" in estado && (
          <iframe
            src={estado.blobUrl}
            title={titulo}
            className="w-full rounded-[var(--radius)]"
            style={{ ...alto, border: "1px solid var(--border)", background: "var(--bg)" }}
          />
        )}
        {/* Sin documento no hay nada que abrir ni bajar: los botones confundirían. */}
        {estado && "blobUrl" in estado && (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => window.open(url, "_blank", "noopener")}>
              Abrir en pestaña nueva
            </Button>
            <Button onClick={() => descargarDocumento(kind, doc)}>
              <DownloadIcon />
              Descargar PDF
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function PagoModal({ pago, onClose }: { pago: Pago; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title={`Recibo ${pago.id}`}>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4">
          <InfoRow label="N° de recibo" value={pago.id} />
          <InfoRow label="Fecha" value={pago.fecha} />
          <InfoRow label="Medio de pago" value={pago.medio} />
          <InfoRow label="Monto pagado" value={<span className="font-bold text-base" style={{ color: "var(--green)" }}>{fmt(pago.monto)}</span>} />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--ink-faint)" }}>
            Facturas canceladas con este pago
          </p>
          <div className="flex flex-col gap-2">
            {/* Solo lo que trae el pago. Antes se cruzaba con las facturas cargadas para mostrar
                "Emitida el…", y con paginación eso aparecía o no según qué página estuviera. */}
            {pago.facturas.map((imp) => (
              <div
                key={imp.factura}
                className="flex items-center justify-between p-3 rounded-[var(--radius)]"
                style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
              >
                <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>{imp.factura}</p>
                <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(imp.imputado)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={() => descargarDocumento("pago", pago)}
            disabled={!pago.alegraId}
            className="flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all"
            style={{ background: "var(--blue)", color: "white" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--blue-hover)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--blue)" }}
          >
            <DownloadIcon />
            Descargar recibo
          </button>
        </div>
      </div>
    </Modal>
  )
}



// ── Small components ──────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-medium" style={{ color: "var(--ink-faint)" }}>{label}</p>
      <div className="text-sm" style={{ color: "var(--ink)" }}>{value}</div>
    </div>
  )
}

function ActionBtn({ onClick, label, children, disabled = false }: { onClick: () => void; label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="h-7 w-7 rounded-[6px] border border-border text-muted hover:bg-bg hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </Button>
  )
}

function DownloadIcon() {
  return <Download size={14} strokeWidth={1.4} color="currentColor" />
}

function EyeIcon() {
  return <Eye size={14} strokeWidth={1.3} color="currentColor" />
}

// ── WhatsApp Pagos Modal ──────────────────────────────────────────────────────

function WhatsAppPagosModal({ pagos, razonsocial, cuit, tenantName, whatsappNumber, onClose }: {
  pagos: Pago[]
  razonsocial: string
  cuit: string
  tenantName: string
  whatsappNumber: string
  onClose: () => void
}) {
  const [message, setMessage] = useState(() =>
    buildPagosWhatsAppMessage(tenantName, razonsocial, cuit, pagos, fmt)
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(22,25,29,0.5)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div className="w-full max-w-lg flex flex-col" style={{ background: "var(--card)", borderRadius: 16, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: "var(--wsp)", color: "white" }}>
                <WspIcon size={20} />
              </div>
              <div>
                <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>Enviar por WhatsApp</h2>
                <p className="text-sm mt-1" style={{ color: "var(--ink-soft)" }}>Se abrirá WhatsApp con el mensaje listo para enviar al local. Podés editarlo antes.</p>
              </div>
            </div>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full transition-all shrink-0" style={{ color: "var(--ink-soft)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
            >
              <X size={16} strokeWidth={1.8} color="currentColor" />
            </button>
          </div>
        </div>
        <div className="p-6 flex flex-col gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--ink-faint)" }}>Mensaje</p>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={8}
              className="w-full text-sm leading-relaxed p-3 rounded-[var(--radius)] resize-y outline-none transition-all"
              style={{ border: "1px solid var(--border)", color: "var(--ink)", background: "var(--bg)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--blue)" }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)" }}
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            <button onClick={onClose} className="px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all"
              style={{ border: "1px solid var(--border)", color: "var(--ink-soft)", background: "transparent" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
            >Cancelar</button>
            <button onClick={() => openWhatsApp(whatsappNumber, message)} className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] text-sm font-medium text-white transition-all"
              style={{ background: "var(--wsp)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--wsp-strong)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--wsp)" }}
            >
              <WspIcon />
              Abrir WhatsApp
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── WhatsApp Presupuestos Modal ───────────────────────────────────────────────

function WhatsAppPresupuestosModal({ presupuestos, razonsocial, cuit, tenantName, whatsappNumber, initialIntent, onClose }: {
  presupuestos: Presupuesto[]
  razonsocial: string
  cuit: string
  tenantName: string
  whatsappNumber: string
  initialIntent: WhatsAppPresupuestoIntent
  onClose: () => void
}) {
  const [intent, setIntent] = useState<WhatsAppPresupuestoIntent>(initialIntent)
  const [message, setMessage] = useState(() =>
    buildPresupuestosWhatsAppMessage(initialIntent, tenantName, razonsocial, cuit, presupuestos, fmt)
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Al cambiar el intent se regenera el mensaje, descartando ediciones previas.
  const [prevIntent, setPrevIntent] = useState(intent)
  if (prevIntent !== intent) {
    setPrevIntent(intent)
    setMessage(buildPresupuestosWhatsAppMessage(intent, tenantName, razonsocial, cuit, presupuestos, fmt))
  }

  // Tras regenerar el mensaje, devuelve el foco al textarea con el cursor al final.
  useEffect(() => {
    setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
  }, [intent])

  const intents: { value: WhatsAppPresupuestoIntent; title: string; subtitle: string }[] = [
    { value: "avanzar", title: "Quiero avanzar", subtitle: "Confirmar y avanzar con estos presupuestos" },
    { value: "consulta", title: "Tengo una consulta", subtitle: "Preguntar algo sobre estos presupuestos" },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(22,25,29,0.5)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div className="w-full max-w-lg flex flex-col" style={{ background: "var(--card)", borderRadius: 16, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: "var(--wsp)", color: "white" }}>
                <WspIcon size={20} />
              </div>
              <div>
                <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>Enviar por WhatsApp</h2>
                <p className="text-sm mt-1" style={{ color: "var(--ink-soft)" }}>Se abrirá WhatsApp con el mensaje listo para enviar al local. Podés editarlo antes.</p>
              </div>
            </div>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full transition-all shrink-0" style={{ color: "var(--ink-soft)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
            >
              <X size={16} strokeWidth={1.8} color="currentColor" />
            </button>
          </div>
        </div>
        <div className="p-6 flex flex-col gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: "var(--ink-faint)" }}>¿Sobre qué querés escribir?</p>
            <div className="grid grid-cols-2 gap-3">
              {intents.map((item) => {
                const active = intent === item.value
                return (
                  <button key={item.value} type="button" onClick={() => setIntent(item.value)}
                    className="text-left p-4 rounded-[var(--radius)] transition-all"
                    style={{ border: active ? "2px solid var(--blue)" : "1px solid var(--border)", background: active ? "var(--blue-soft)" : "var(--card)" }}
                  >
                    <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{item.title}</p>
                    <p className="text-xs mt-1" style={{ color: "var(--ink-soft)" }}>{item.subtitle}</p>
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--ink-faint)" }}>Mensaje</p>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={7}
              className="w-full text-sm leading-relaxed p-3 rounded-[var(--radius)] resize-y outline-none transition-all"
              style={{ border: "1px solid var(--border)", color: "var(--ink)", background: "var(--bg)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--blue)" }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)" }}
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            <button onClick={onClose} className="px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all"
              style={{ border: "1px solid var(--border)", color: "var(--ink-soft)", background: "transparent" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
            >Cancelar</button>
            <button onClick={() => openWhatsApp(whatsappNumber, message)} className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] text-sm font-medium text-white transition-all"
              style={{ background: "var(--wsp)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--wsp-strong)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--wsp)" }}
            >
              <WspIcon />
              Abrir WhatsApp
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function WspIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 2.126.557 4.126 1.527 5.865L.057 23.428a.75.75 0 00.916.916l5.563-1.47A11.952 11.952 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.907 0-3.7-.505-5.25-1.385l-.378-.213-3.924 1.037 1.037-3.924-.213-.378A9.953 9.953 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
    </svg>
  )
}
