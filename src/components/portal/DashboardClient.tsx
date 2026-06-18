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
  SearchInput,
  Field,
  Select,
} from "@myd-org/ui"
import { Logo } from "./Logo"
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
import { CreditCard, Search, Plus, X, Upload, FileText, Eye, Download, Info, Calendar, ChevronDown } from "lucide-react"

// ── Tooltip ───────────────────────────────────────────────────────────────────

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
  initialQuery?: string
  openFacturaId?: string
  shopUrl?: string
}

type Tab = "facturas" | "pagos" | "presupuestos"

const TABS: Tab[] = ["facturas", "pagos", "presupuestos"]

function toTab(value?: string): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : "facturas"
}

// ── Component ────────────────────────────────────────────────────────────────

export function DashboardClient({ cliente, facturas, pagos, presupuestos, razonsocial, tenantName, whatsappNumber, logoSrc, logoSubtitle, initialTab, initialQuery, openFacturaId, shopUrl }: Props) {
  const startTab = toTab(initialTab)
  const startQuery = initialQuery ?? ""

  const [activeTab, setActiveTab] = useState<Tab>(startTab)
  const [facturasFilter, setFacturasFilter] = useState<FacturaEstado | "todos">("todos")
  const [facturasSearch, setFacturasSearch] = useState(startTab === "facturas" ? startQuery : "")
  const [pagosSearch, setPagosSearch] = useState(startTab === "pagos" ? startQuery : "")
  const [presupuestosSearch, setPresupuestosSearch] = useState(startTab === "presupuestos" ? startQuery : "")

  // Sincroniza con los query params (?tab=&q=) cuando cambian — p.ej. al tocar
  // una notificación estando ya en el dashboard.
  const prevNav = useRef(`${startTab}|${startQuery}`)
  const navKey = `${toTab(initialTab)}|${initialQuery ?? ""}`
  if (prevNav.current !== navKey) {
    prevNav.current = navKey
    const t = toTab(initialTab)
    const q = initialQuery ?? ""
    setActiveTab(t)
    if (t === "facturas") { setFacturasFilter("todos"); setFacturasSearch(q) }
    else if (t === "pagos") setPagosSearch(q)
    else setPresupuestosSearch(q)
  }

  const vencidasCount = facturas.filter((f) => f.estado === "vencida").length
  const pendientesCount = facturas.filter((f) => f.estado === "pendiente").length
  const topVencidas = facturas.filter((f) => f.estado === "vencida").slice(0, 2)
  const topPendientes = facturas.filter((f) => f.estado === "pendiente").slice(0, 2)

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
              CUIT {cliente.cuit} · Cuenta corriente N° {cliente.numerocuentacorriente}
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
            </div>

            {/* Saldo vencido */}
            <SummaryCard
              title="Saldo vencido"
              amount={cliente.saldovencido}
              amountColor="var(--red)"
              count={vencidasCount}
              countLabel="facturas vencidas"
              rows={topVencidas}
              onVerMas={() => { setActiveTab("facturas"); setFacturasFilter("vencida"); setFacturasSearch("") }}
              onRowClick={(id) => { setActiveTab("facturas"); setFacturasFilter("todos"); setFacturasSearch(id) }}
            />

            {/* Saldo a vencer */}
            <SummaryCard
              title="Saldo a vencer"
              amount={cliente.saldoavencer}
              amountColor="var(--amber)"
              count={pendientesCount}
              countLabel="facturas pendientes"
              rows={topPendientes}
              onVerMas={() => { setActiveTab("facturas"); setFacturasFilter("pendiente"); setFacturasSearch("") }}
              onRowClick={(id) => { setActiveTab("facturas"); setFacturasFilter("todos"); setFacturasSearch(id) }}
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
            {activeTab === "facturas" && (
              <FacturasTable
                facturas={facturas}
                razonsocial={razonsocial}
                cuentaCorriente={cliente.numerocuentacorriente}
                tenantName={tenantName}
                whatsappNumber={whatsappNumber}
                logoSrc={logoSrc}
                initialFilter={facturasFilter}
                onFilterChange={setFacturasFilter}
                initialSearch={facturasSearch}
                onSearchChange={setFacturasSearch}
                openFacturaId={openFacturaId}
              />
            )}
            {activeTab === "pagos" && <PagosTable pagos={pagos} facturas={facturas} razonsocial={razonsocial} cuentaCorriente={cliente.numerocuentacorriente} tenantName={tenantName} whatsappNumber={whatsappNumber} initialSearch={pagosSearch} />}
            {activeTab === "presupuestos" && <PresupuestosTable presupuestos={presupuestos} razonsocial={razonsocial} cuentaCorriente={cliente.numerocuentacorriente} tenantName={tenantName} whatsappNumber={whatsappNumber} initialSearch={presupuestosSearch} />}

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
}

const FACTURA_TONE: Record<FacturaEstado, "warning" | "danger" | "success"> = {
  pendiente: "warning",
  vencida: "danger",
  pagada: "success",
}

function FacturaBadge({ estado }: { estado: FacturaEstado }) {
  return <Badge tone={FACTURA_TONE[estado]}>{FACTURA_ESTADO_LABELS[estado]}</Badge>
}

function initialToSet(f: FacturaEstado | "todos"): Set<FacturaEstado> {
  return f === "todos" ? new Set() : new Set([f])
}

function FacturasTable({
  facturas,
  razonsocial,
  cuentaCorriente,
  tenantName,
  whatsappNumber,
  logoSrc,
  initialFilter = "todos",
  onFilterChange,
  initialSearch = "",
  onSearchChange,
  openFacturaId,
}: {
  facturas: Factura[]
  razonsocial: string
  cuentaCorriente: number
  tenantName: string
  whatsappNumber: string
  logoSrc: string
  initialFilter?: FacturaEstado | "todos"
  onFilterChange?: (v: FacturaEstado | "todos") => void
  initialSearch?: string
  onSearchChange?: (v: string) => void
  openFacturaId?: string
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState(initialSearch)
  const [searchOpen, setSearchOpen] = useState(!!initialSearch)
  const [filterEstados, setFilterEstados] = useState<Set<FacturaEstado>>(initialToSet(initialFilter))
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [dateFilterField, setDateFilterField] = useState<"emision" | "vencimiento">("emision")

  const prevInitial = useRef(initialFilter)
  if (prevInitial.current !== initialFilter) {
    prevInitial.current = initialFilter
    setFilterEstados(initialToSet(initialFilter))
  }

  const prevSearch = useRef(initialSearch)
  if (prevSearch.current !== initialSearch) {
    prevSearch.current = initialSearch
    setSearch(initialSearch)
    setSearchOpen(!!initialSearch)
  }
  const [modalFactura, setModalFactura] = useState<Factura | null>(null)
  const [whatsappModal, setWhatsappModal] = useState<{ facturas: Factura[]; intent: WhatsAppFacturaIntent } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Abre el detalle de la factura indicada por URL (?factura=ID) — usado al tocar
  // una notificación. Se reabre si cambia el id.
  const prevOpen = useRef<string | undefined>(undefined)
  if (openFacturaId && prevOpen.current !== openFacturaId) {
    prevOpen.current = openFacturaId
    const target = facturas.find((f) => f.id === openFacturaId)
    if (target) setModalFactura(target)
  }

  function toggleEstado(estado: FacturaEstado) {
    setFilterEstados(prev => {
      const next = new Set(prev)
      if (next.has(estado)) next.delete(estado)
      else next.add(estado)
      return next
    })
  }

  const filtered = useMemo(() => {
    const desde = fromDate ? isoToLocal(fromDate) : null
    const hasta = toDate ? isoToLocal(toDate) : null
    return facturas.filter((f) => {
      const matchSearch = !search || f.id.toLowerCase().includes(search.toLowerCase()) || f.tipo.toLowerCase().includes(search.toLowerCase())
      const matchEstado = filterEstados.size === 0 || filterEstados.has(f.estado)
      const fecha = parseLocalDate(dateFilterField === "emision" ? f.emision : f.vencimiento)
      const matchFrom = !desde || !fecha || fecha >= desde
      const matchTo = !hasta || !fecha || fecha <= hasta
      return matchSearch && matchEstado && matchFrom && matchTo
    })
  }, [facturas, search, filterEstados, fromDate, toDate, dateFilterField])

  const selectedFacturas = facturas.filter((f) => selected.has(f.id))
  const selectedTotal = selectedFacturas.reduce((s, f) => s + saldoDe(f), 0)

  const estadoOrder: Record<FacturaEstado, number> = { vencida: 0, pendiente: 1, pagada: 2 }

  const facturaColumns: TableColumn<Factura>[] = [
    {
      key: "id",
      header: "Comprobante",
      sortable: true,
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
      sortable: true,
      hideBelow: "sm",
      defaultSortDir: "desc",
      sortValue: (f) => parseLocalDate(f.emision)?.valueOf() ?? 0,
      className: "text-xs",
      headerClassName: "text-xs",
      render: (f) => <span style={{ color: "var(--ink-soft)" }}>{f.emision}</span>,
    },
    {
      key: "vencimiento",
      header: "Vencimiento",
      sortable: true,
      defaultSortDir: "desc",
      sortValue: (f) => parseLocalDate(f.vencimiento)?.valueOf() ?? 0,
      className: "text-xs",
      render: (f) => <span style={{ color: "var(--ink-soft)" }}>{f.vencimiento}</span>,
    },
    {
      key: "importe",
      header: "Importe",
      sortable: true,
      align: "right",
      defaultSortDir: "desc",
      sortValue: (f) => f.importe,
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
      sortable: true,
      hideBelow: "md",
      sortValue: (f) => estadoOrder[f.estado],
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
          <ActionBtn onClick={() => setModalFactura(f)} label="Ver">
            <EyeIcon />
          </ActionBtn>
          <ActionBtn onClick={() => alert("Descarga: próximamente")} label="Descargar">
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
        searchOpen={searchOpen}
        setSearchOpen={(v) => { setSearchOpen(v); if (v) setTimeout(() => searchRef.current?.focus(), 50) }}
        searchRef={searchRef}
        search={search}
        setSearch={setSearch}
        fromDate={fromDate}
        toDate={toDate}
        onFromDateChange={setFromDate}
        onToDateChange={setToDate}
        dateFilterField={dateFilterField}
        onDateFilterFieldChange={setDateFilterField}
        multiFilterOptions={[
          { value: "pendiente", label: "Pendientes" },
          { value: "vencida", label: "Vencidas" },
          { value: "pagada", label: "Pagadas" },
        ]}
        activeFilters={filterEstados}
        onToggleFilter={(v) => toggleEstado(v as FacturaEstado)}
        onClearFilters={() => setFilterEstados(new Set())}
      />

      {(
        <SelectionBar
          count={selected.size}
          total={selectedTotal}
          onClear={() => setSelected(new Set())}
          onDownload={() => alert("Descarga de facturas: próximamente")}
          onWhatsapp={() => openWhatsAppModal("pagar")}
          itemLabel="factura"
        />
      )}

      <Table<Factura>
        className="mt-2"
        columns={facturaColumns}
        rows={filtered}
        rowKey={(f) => f.id}
        selectable
        selectedKeys={Array.from(selected)}
        onSelectionChange={(keys) => setSelected(new Set(keys))}
        defaultSort={{ key: "emision", dir: "desc" }}
        empty="No hay facturas para mostrar"
      />

      {modalFactura && (
        <FacturaModal
          factura={modalFactura}
          tenantName={tenantName}
          logoSrc={logoSrc}
          onClose={() => setModalFactura(null)}
        />
      )}

      {whatsappModal && (
        <WhatsAppFacturasModal
          facturas={whatsappModal.facturas}
          razonsocial={razonsocial}
          cuentaCorriente={cuentaCorriente}
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

function PagosTable({ pagos, facturas, razonsocial, cuentaCorriente, tenantName, whatsappNumber, initialSearch = "" }: { pagos: Pago[]; facturas: Factura[]; razonsocial: string; cuentaCorriente: number; tenantName: string; whatsappNumber: string; initialSearch?: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState(initialSearch)
  const [searchOpen, setSearchOpen] = useState(!!initialSearch)

  const prevSearch = useRef(initialSearch)
  if (prevSearch.current !== initialSearch) {
    prevSearch.current = initialSearch
    setSearch(initialSearch)
    setSearchOpen(!!initialSearch)
  }
  const [modalPago, setModalPago] = useState<Pago | null>(null)
  const [showAdjuntar, setShowAdjuntar] = useState(false)
  const [wspModal, setWspModal] = useState(false)
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const desde = fromDate ? isoToLocal(fromDate) : null
    const hasta = toDate ? isoToLocal(toDate) : null
    return pagos.filter((p) => {
      const matchSearch = !search || p.id.toLowerCase().includes(search.toLowerCase()) || p.facturas.some((imp) => imp.factura.toLowerCase().includes(search.toLowerCase()))
      const fecha = parseLocalDate(p.fecha)
      const matchFrom = !desde || !fecha || fecha >= desde
      const matchTo = !hasta || !fecha || fecha <= hasta
      return matchSearch && matchFrom && matchTo
    })
  }, [pagos, search, fromDate, toDate])

  const selectedPagos = pagos.filter((p) => selected.has(p.id))
  const selectedTotal = selectedPagos.reduce((s, p) => s + p.monto, 0)

  const pagoColumns: TableColumn<Pago>[] = [
    {
      key: "id",
      header: "Recibo",
      sortable: true,
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
      sortable: true,
      defaultSortDir: "desc",
      sortValue: (p) => parseLocalDate(p.fecha)?.valueOf() ?? 0,
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.fecha}</span>,
    },
    {
      key: "facturaAsociada",
      header: "Facturas asociadas",
      sortable: true,
      hideBelow: "md",
      sortValue: (p) => p.facturas[0]?.factura ?? "",
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
      sortable: true,
      hideBelow: "sm",
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.medio}</span>,
    },
    {
      key: "monto",
      header: "Monto pagado",
      sortable: true,
      align: "right",
      defaultSortDir: "desc",
      sortValue: (p) => p.monto,
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
          <ActionBtn onClick={() => setModalPago(p)} label="Ver">
            <EyeIcon />
          </ActionBtn>
          <ActionBtn onClick={() => alert("Descarga: próximamente")} label="Descargar">
            <DownloadIcon />
          </ActionBtn>
        </div>
      ),
    },
  ]

  return (
    <>
      <div className="mb-2">
        <Toolbar
          searchOpen={searchOpen}
          setSearchOpen={(v) => { setSearchOpen(v); if (v) setTimeout(() => searchRef.current?.focus(), 50) }}
          searchRef={searchRef}
          search={search}
          setSearch={setSearch}
          fromDate={fromDate}
          toDate={toDate}
          onFromDateChange={setFromDate}
          onToDateChange={setToDate}
          filterOptions={[]}
          filterValue="todos"
          setFilterValue={() => {}}
          hideFilter
          extraActions={
            <button
              onClick={() => setShowAdjuntar(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius)] text-xs font-medium transition-all shrink-0"
              style={{ background: "var(--blue-soft)", color: "var(--blue)", border: "1px solid var(--blue-soft)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--blue)"; e.currentTarget.style.color = "white" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--blue-soft)"; e.currentTarget.style.color = "var(--blue)" }}
            >
              <Plus size={14} strokeWidth={1.6} color="currentColor" />
              Adjuntar comprobante
            </button>
          }
        />
      </div>

      {(
        <SelectionBar
          count={selected.size}
          total={selectedTotal}
          onClear={() => setSelected(new Set())}
          onDownload={() => alert("Descarga de recibos: próximamente")}
          onWhatsapp={() => setWspModal(true)}
          itemLabel="recibo"
        />
      )}

      {wspModal && (
        <WhatsAppPagosModal
          pagos={selectedPagos}
          razonsocial={razonsocial}
          cuentaCorriente={cuentaCorriente}
          tenantName={tenantName}
          whatsappNumber={whatsappNumber}
          onClose={() => setWspModal(false)}
        />
      )}

      <Table<Pago>
        className="mt-2"
        columns={pagoColumns}
        rows={filtered}
        rowKey={(p) => p.id}
        selectable
        selectedKeys={Array.from(selected)}
        onSelectionChange={(keys) => setSelected(new Set(keys))}
        defaultSort={{ key: "fecha", dir: "desc" }}
        empty="No hay pagos para mostrar"
      />

      {modalPago && (
        <PagoModal pago={modalPago} facturas={facturas} onClose={() => setModalPago(null)} />
      )}

      {showAdjuntar && (
        <AdjuntarModal onClose={() => setShowAdjuntar(false)} facturas={facturas} />
      )}
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

function PresupuestosTable({ presupuestos, razonsocial, cuentaCorriente, tenantName, whatsappNumber, initialSearch = "" }: { presupuestos: Presupuesto[]; razonsocial: string; cuentaCorriente: number; tenantName: string; whatsappNumber: string; initialSearch?: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState(initialSearch)
  const [searchOpen, setSearchOpen] = useState(!!initialSearch)

  const prevSearch = useRef(initialSearch)
  if (prevSearch.current !== initialSearch) {
    prevSearch.current = initialSearch
    setSearch(initialSearch)
    setSearchOpen(!!initialSearch)
  }
  const [filterEstados, setFilterEstados] = useState<Set<PresupuestoEstado>>(new Set())
  const [modalPresupuesto, setModalPresupuesto] = useState<Presupuesto | null>(null)
  const [wspModal, setWspModal] = useState<WhatsAppPresupuestoIntent | null>(null)
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [dateFilterField, setDateFilterField] = useState<"emision" | "vencimiento">("emision")
  const searchRef = useRef<HTMLInputElement>(null)

  function toggleEstado(estado: PresupuestoEstado) {
    setFilterEstados(prev => {
      const next = new Set(prev)
      if (next.has(estado)) next.delete(estado)
      else next.add(estado)
      return next
    })
  }

  const filtered = useMemo(() => {
    const desde = fromDate ? isoToLocal(fromDate) : null
    const hasta = toDate ? isoToLocal(toDate) : null
    return presupuestos.filter((p) => {
      const matchSearch = !search || p.id.toLowerCase().includes(search.toLowerCase())
      const matchEstado = filterEstados.size === 0 || filterEstados.has(p.estado)
      const fecha = parseLocalDate(dateFilterField === "emision" ? p.fecha : p.validoHasta)
      const matchFrom = !desde || !fecha || fecha >= desde
      const matchTo = !hasta || !fecha || fecha <= hasta
      return matchSearch && matchEstado && matchFrom && matchTo
    })
  }, [presupuestos, search, filterEstados, fromDate, toDate, dateFilterField])

  const selectedPresupuestos = presupuestos.filter((p) => selected.has(p.id))
  const selectedTotal = selectedPresupuestos.reduce((s, p) => s + p.total, 0)

  const presupuestoEstadoOrder: Record<PresupuestoEstado, number> = { vencido: 0, vigente: 1, aceptado: 2 }

  const presupuestoColumns: TableColumn<Presupuesto>[] = [
    {
      key: "id",
      header: "Presupuesto",
      sortable: true,
      render: (p) => <div className="font-medium" style={{ color: "var(--ink)" }}>{p.id}</div>,
    },
    {
      key: "fecha",
      header: "Emisión",
      sortable: true,
      hideBelow: "sm",
      defaultSortDir: "desc",
      sortValue: (p) => parseLocalDate(p.fecha)?.valueOf() ?? 0,
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.fecha}</span>,
    },
    {
      key: "validoHasta",
      header: "Válido hasta",
      sortable: true,
      hideBelow: "md",
      defaultSortDir: "desc",
      sortValue: (p) => parseLocalDate(p.validoHasta)?.valueOf() ?? 0,
      className: "text-xs",
      render: (p) => <span style={{ color: "var(--ink-soft)" }}>{p.validoHasta}</span>,
    },
    {
      key: "total",
      header: "Total",
      sortable: true,
      align: "right",
      defaultSortDir: "desc",
      sortValue: (p) => p.total,
      className: "font-medium tabular-nums",
      render: (p) => <span style={{ color: "var(--ink)" }}>{fmt(p.total)}</span>,
    },
    {
      key: "estado",
      header: "Estado",
      sortable: true,
      hideBelow: "md",
      sortValue: (p) => presupuestoEstadoOrder[p.estado],
      render: (p) => <PresupuestoBadge estado={p.estado} />,
    },
    {
      key: "acciones",
      header: "Acciones",
      align: "right",
      headerClassName: "text-xs",
      render: (p) => (
        <div className="flex items-center justify-end gap-2">
          <ActionBtn onClick={() => setModalPresupuesto(p)} label="Ver">
            <EyeIcon />
          </ActionBtn>
          <ActionBtn onClick={() => alert("Descarga: próximamente")} label="Descargar">
            <DownloadIcon />
          </ActionBtn>
        </div>
      ),
    },
  ]

  return (
    <>
      <Toolbar
        searchOpen={searchOpen}
        setSearchOpen={(v) => { setSearchOpen(v); if (v) setTimeout(() => searchRef.current?.focus(), 50) }}
        searchRef={searchRef}
        search={search}
        setSearch={setSearch}
        fromDate={fromDate}
        toDate={toDate}
        onFromDateChange={setFromDate}
        onToDateChange={setToDate}
        dateFilterField={dateFilterField}
        onDateFilterFieldChange={setDateFilterField}
        multiFilterOptions={[
          { value: "vigente", label: "Vigentes" },
          { value: "vencido", label: "Vencidos" },
          { value: "aceptado", label: "Aceptados" },
        ]}
        activeFilters={filterEstados}
        onToggleFilter={(v) => toggleEstado(v as PresupuestoEstado)}
        onClearFilters={() => setFilterEstados(new Set())}
      />

      {(
        <SelectionBar
          count={selected.size}
          total={selectedTotal}
          onClear={() => setSelected(new Set())}
          onDownload={() => alert("Descarga: próximamente")}
          onWhatsapp={() => setWspModal("avanzar")}
          itemLabel="presupuesto"
        />
      )}

      {wspModal && (
        <WhatsAppPresupuestosModal
          presupuestos={selectedPresupuestos}
          razonsocial={razonsocial}
          cuentaCorriente={cuentaCorriente}
          tenantName={tenantName}
          whatsappNumber={whatsappNumber}
          initialIntent={wspModal}
          onClose={() => setWspModal(null)}
        />
      )}

      <Table<Presupuesto>
        className="mt-2"
        columns={presupuestoColumns}
        rows={filtered}
        rowKey={(p) => p.id}
        selectable
        selectedKeys={Array.from(selected)}
        onSelectionChange={(keys) => setSelected(new Set(keys))}
        defaultSort={{ key: "fecha", dir: "desc" }}
        empty="No hay presupuestos para mostrar"
      />

      {modalPresupuesto && (
        <PresupuestoModal presupuesto={modalPresupuesto} tenantName={tenantName} whatsappNumber={whatsappNumber} onClose={() => setModalPresupuesto(null)} />
      )}
    </>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

interface ToolbarProps {
  searchOpen: boolean
  setSearchOpen: (v: boolean) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  search: string
  setSearch: (v: string) => void
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
    searchOpen,
    setSearchOpen,
    searchRef,
    search,
    setSearch,
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

      {/* Search — icon button when closed, SearchInput when open */}
      <div className="relative shrink-0 flex items-center">
        {searchOpen ? (
          <SearchInput
            ref={searchRef}
            value={search}
            onValueChange={setSearch}
            onBlur={() => { if (!search) setSearchOpen(false) }}
            className="h-[26px] py-0 text-xs"
          />
        ) : (
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center justify-center rounded-full px-2.5 transition-all"
            style={{ border: "1px solid var(--border)", color: "var(--ink-soft)", background: "var(--bg)", height: 26 }}
          >
            <Search size={12} strokeWidth={2} color="currentColor" />
          </button>
        )}
      </div>

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
  cuentaCorriente,
  tenantName,
  whatsappNumber,
  initialIntent,
  onClose,
}: {
  facturas: Factura[]
  razonsocial: string
  cuentaCorriente: number
  tenantName: string
  whatsappNumber: string
  initialIntent: WhatsAppFacturaIntent
  onClose: () => void
}) {
  const [intent, setIntent] = useState<WhatsAppFacturaIntent>(initialIntent)
  const [message, setMessage] = useState(() =>
    buildFacturasWhatsAppMessage(initialIntent, tenantName, razonsocial, cuentaCorriente, facturas, fmt),
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useEffect(() => {
    const newMsg = buildFacturasWhatsAppMessage(intent, tenantName, razonsocial, cuentaCorriente, facturas, fmt)
    setMessage(newMsg)
    setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
  }, [intent, facturas, razonsocial, cuentaCorriente, tenantName])

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

// ── Factura Modal ─────────────────────────────────────────────────────────────

function FacturaModal({
  factura,
  onClose,
  tenantName,
  logoSrc,
}: {
  factura: Factura
  onClose: () => void
  tenantName: string
  logoSrc: string
}) {
  const items = [
    { desc: "Luminaria LED Panel 60x60 48W", qty: 10, unit: factura.importe * 0.4 / 10, total: factura.importe * 0.4 },
    { desc: "Tira LED 5050 RGB 5m c/fuente", qty: 5, unit: factura.importe * 0.35 / 5, total: factura.importe * 0.35 },
    { desc: "Downlight LED embutido 12W", qty: 8, unit: factura.importe * 0.25 / 8, total: factura.importe * 0.25 },
  ]
  const subtotal = factura.importe / 1.21
  const iva = factura.importe - subtotal

  return (
    <Modal onClose={onClose} title={`${factura.tipo} ${factura.id}`}>
      <div className="flex flex-col gap-6">
        {/* Header doc */}
        <div className="flex justify-between items-start pb-4" style={{ borderBottom: "2px solid var(--border)" }}>
          <div>
            <Logo size="sm" src={logoSrc} name={tenantName} />
            <div className="mt-2 text-xs" style={{ color: "var(--ink-soft)" }}>
              <p>{tenantName}</p>
              <p>CUIT: 30-71234567-8</p>
              <p>San Martín 1245, Posadas, Misiones</p>
              <p>IVA Responsable Inscripto</p>
            </div>
          </div>
          <div className="text-right">
            <div
              className="inline-flex items-center px-4 py-2 rounded-[var(--radius)] text-lg font-bold"
              style={{ border: "2px solid var(--ink)", color: "var(--ink)" }}
            >
              {factura.tipo === "Factura A" ? "A" : "B"}
            </div>
            <div className="mt-2 text-xs" style={{ color: "var(--ink-soft)" }}>
              <p>N°: {factura.id.replace(/\w+-/, "")}</p>
              <p>Fecha: {factura.emision}</p>
              <p>Vto: {factura.vencimiento}</p>
            </div>
          </div>
        </div>

        {/* Receptor */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ink-faint)" }}>Receptor</p>
            <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
              <p className="font-medium" style={{ color: "var(--ink)" }}>Ferretería Sol S.R.L.</p>
              <p>CUIT: 30-71045887-3</p>
              <p>Cond. IVA: Responsable Inscripto</p>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ink-faint)" }}>Condición de pago</p>
            <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
              <p>Cuenta Corriente 30 días</p>
              <p>Moneda: Peso Argentino</p>
            </div>
          </div>
        </div>

        {/* Items */}
        <div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr style={{ background: "var(--bg)", borderRadius: "var(--radius)" }}>
                <th className="py-2 px-3 text-left font-semibold" style={{ color: "var(--ink-soft)" }}>Descripción</th>
                <th className="py-2 px-3 text-right font-semibold" style={{ color: "var(--ink-soft)" }}>Cant.</th>
                <th className="py-2 px-3 text-right font-semibold" style={{ color: "var(--ink-soft)" }}>Precio unit.</th>
                <th className="py-2 px-3 text-right font-semibold" style={{ color: "var(--ink-soft)" }}>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 px-3" style={{ color: "var(--ink)" }}>{item.desc}</td>
                  <td className="py-2 px-3 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{item.qty}</td>
                  <td className="py-2 px-3 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmt(item.unit)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium" style={{ color: "var(--ink)" }}>{fmt(item.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="flex flex-col gap-1.5 min-w-[200px]">
            <div className="flex justify-between text-xs" style={{ color: "var(--ink-soft)" }}>
              <span>Subtotal</span>
              <span className="tabular-nums">{fmt(subtotal)}</span>
            </div>
            <div className="flex justify-between text-xs" style={{ color: "var(--ink-soft)" }}>
              <span>IVA 21%</span>
              <span className="tabular-nums">{fmt(iva)}</span>
            </div>
            <div
              className="flex justify-between text-sm font-bold pt-2"
              style={{ borderTop: "2px solid var(--border)", color: "var(--ink)" }}
            >
              <span>Total</span>
              <span className="tabular-nums">{fmt(factura.importe)}</span>
            </div>
            {esPagoParcial(factura) && (
              <>
                <div className="flex justify-between text-xs" style={{ color: "var(--green)" }}>
                  <span>Pagos registrados</span>
                  <span className="tabular-nums">−{fmt(factura.pagado ?? 0)}</span>
                </div>
                <div
                  className="flex justify-between text-sm font-bold pt-2"
                  style={{ borderTop: "2px solid var(--border)", color: "var(--blue)" }}
                >
                  <span>Saldo pendiente</span>
                  <span className="tabular-nums">{fmt(saldoDe(factura))}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* CAE */}
        <div
          className="flex items-center justify-between p-3 rounded-[var(--radius)]"
          style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
        >
          <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
            <p className="font-semibold" style={{ color: "var(--ink)" }}>CAE: 74123456789012</p>
            <p>Vto. CAE: {factura.vencimiento}</p>
          </div>
          {/* QR decorativo */}
          <div className="w-12 h-12 grid grid-cols-4 grid-rows-4 gap-0.5 opacity-60">
            {Array.from({ length: 16 }, (_, i) => (
              <div key={i} className="rounded-[1px]" style={{ background: [0,1,4,5,10,11,14,15].includes(i) ? "var(--ink)" : "transparent" }} />
            ))}
          </div>
        </div>

        {/* Acciones */}
        <div className="flex items-center justify-end pt-2" style={{ borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => alert("Descarga: próximamente")}
            className="flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all"
            style={{ border: "1px solid var(--border)", color: "var(--ink-soft)", background: "transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
          >
            <DownloadIcon />
            Descargar PDF
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Pago Modal ────────────────────────────────────────────────────────────────

function PagoModal({ pago, facturas, onClose }: { pago: Pago; facturas: Factura[]; onClose: () => void }) {
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
            {pago.facturas.map((imp) => {
              const facturaAsoc = facturas.find((f) => f.id === imp.factura)
              return (
                <div
                  key={imp.factura}
                  className="flex items-center justify-between p-3 rounded-[var(--radius)]"
                  style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
                >
                  <div>
                    <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>{imp.factura}</p>
                    {facturaAsoc && (
                      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{facturaAsoc.tipo} · Emitida {facturaAsoc.emision}</p>
                    )}
                  </div>
                  <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(imp.imputado)}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={() => alert("Descarga: próximamente")}
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

// ── Presupuesto Modal ─────────────────────────────────────────────────────────

function PresupuestoModal({ presupuesto, tenantName, whatsappNumber, onClose }: { presupuesto: Presupuesto; tenantName: string; whatsappNumber: string; onClose: () => void }) {
  const items = [
    { desc: "Luminaria LED Industrial 150W", qty: 4, unit: presupuesto.total * 0.5 / 4, total: presupuesto.total * 0.5 },
    { desc: "Panel LED 40W retroiluminado", qty: 6, unit: presupuesto.total * 0.3 / 6, total: presupuesto.total * 0.3 },
    { desc: "Reflector LED exterior 50W", qty: 5, unit: presupuesto.total * 0.2 / 5, total: presupuesto.total * 0.2 },
  ]

  function handleWsp() {
    openWhatsApp(whatsappNumber, `Hola ${tenantName}, quiero avanzar con el presupuesto ${presupuesto.id} por un total de ${fmt(presupuesto.total)}.`)
  }

  return (
    <Modal onClose={onClose} title={`Presupuesto ${presupuesto.id}`}>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4">
          <InfoRow label="N° de presupuesto" value={presupuesto.id} />
          <InfoRow label="Estado" value={<PresupuestoBadge estado={presupuesto.estado} />} />
          <InfoRow label="Fecha emisión" value={presupuesto.fecha} />
          <InfoRow label="Válido hasta" value={presupuesto.validoHasta} />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--ink-faint)" }}>Ítems</p>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr style={{ background: "var(--bg)" }}>
                <th className="py-2 px-3 text-left font-semibold" style={{ color: "var(--ink-soft)" }}>Descripción</th>
                <th className="py-2 px-3 text-right font-semibold" style={{ color: "var(--ink-soft)" }}>Cant.</th>
                <th className="py-2 px-3 text-right font-semibold" style={{ color: "var(--ink-soft)" }}>Precio unit.</th>
                <th className="py-2 px-3 text-right font-semibold" style={{ color: "var(--ink-soft)" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 px-3" style={{ color: "var(--ink)" }}>{item.desc}</td>
                  <td className="py-2 px-3 text-right" style={{ color: "var(--ink-soft)" }}>{item.qty}</td>
                  <td className="py-2 px-3 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmt(item.unit)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium" style={{ color: "var(--ink)" }}>{fmt(item.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <div className="flex flex-col gap-1 text-sm min-w-[160px]">
            <div
              className="flex justify-between font-bold pt-1"
              style={{ borderTop: "2px solid var(--border)", color: "var(--ink)" }}
            >
              <span>Total</span>
              <span className="tabular-nums">{fmt(presupuesto.total)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2" style={{ borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => alert("Descarga: próximamente")}
            className="flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all"
            style={{ border: "1px solid var(--border)", color: "var(--ink-soft)", background: "transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
          >
            <DownloadIcon />
            Descargar
          </button>

          {presupuesto.estado === "vigente" && (
            <button
              onClick={handleWsp}
              className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] text-sm font-medium transition-all text-white"
              style={{ background: "var(--wsp)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--wsp-strong)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--wsp)" }}
            >
              <WspIcon />
              Avanzar por WhatsApp
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ── Adjuntar Modal ────────────────────────────────────────────────────────────

function AdjuntarModal({ onClose, facturas }: { onClose: () => void; facturas: Factura[] }) {
  const [dragging, setDragging] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [tipo, setTipo] = useState("transferencia")
  const [facturaId, setFacturaId] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const dropped = Array.from(e.dataTransfer.files).filter(
      (f) => f.type === "application/pdf" || f.type.startsWith("image/")
    )
    setFiles((prev) => [...prev, ...dropped])
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return
    const selected = Array.from(e.target.files)
    setFiles((prev) => [...prev, ...selected])
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i))
  }

  return (
    <Modal onClose={onClose} title="Adjuntar comprobante de pago">
      <div className="flex flex-col gap-5">
        {/* Dropzone */}
        <div
          className="flex flex-col items-center justify-center gap-3 p-8 rounded-[var(--radius)] transition-all cursor-pointer"
          style={{
            border: `2px dashed ${dragging ? "var(--blue)" : "var(--border-strong)"}`,
            background: dragging ? "var(--blue-soft)" : "var(--bg)",
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: "var(--blue-soft)" }}>
            <Upload size={24} strokeWidth={1.6} style={{ color: "var(--blue)" }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>
              Arrastrá archivos o{" "}
              <span style={{ color: "var(--blue)" }}>hacé clic para seleccionar</span>
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--ink-faint)" }}>PDF, JPG o PNG · Máx. 10 MB por archivo</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,image/*"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>

        {/* Files list */}
        {files.length > 0 && (
          <div className="flex flex-col gap-2">
            {files.map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-3 py-2 rounded-[var(--radius)]"
                style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
              >
                <div className="flex items-center gap-2 text-sm" style={{ color: "var(--ink)" }}>
                  <FileText size={14} strokeWidth={1.3} style={{ color: "var(--blue)" }} />
                  <span className="truncate max-w-[200px]">{f.name}</span>
                  <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
                    {(f.size / 1024).toFixed(0)} KB
                  </span>
                </div>
                <button
                  onClick={() => removeFile(i)}
                  className="transition-opacity hover:opacity-70"
                  style={{ color: "var(--ink-faint)" }}
                >
                  <X size={14} strokeWidth={1.6} color="currentColor" />
                </button>
              </div>
            ))}
          </div>
        )}

        <Field label="Tipo de comprobante">
          <Select
            value={tipo}
            onValueChange={setTipo}
            options={[
              { value: "transferencia", label: "Transferencia bancaria" },
              { value: "cheque", label: "Cheque" },
              { value: "efectivo", label: "Efectivo" },
              { value: "otro", label: "Otro" },
            ]}
          />
        </Field>

        <Field label="Factura asociada (opcional)">
          <Select
            value={facturaId || "none"}
            onValueChange={(v) => setFacturaId(v === "none" ? "" : v)}
            options={[
              { value: "none", label: "Sin asociar" },
              ...facturas.map((f) => ({ value: f.id, label: `${f.id} — ${fmt(f.importe)}` })),
            ]}
          />
        </Field>

        <div className="flex gap-3 justify-end pt-2" style={{ borderTop: "1px solid var(--border)" }}>
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
            onClick={() => { alert("Envío: próximamente"); onClose() }}
            disabled={files.length === 0}
            className="px-4 py-2 rounded-[var(--radius)] text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "var(--blue)" }}
            onMouseEnter={(e) => { if (files.length > 0) e.currentTarget.style.background = "var(--blue-hover)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--blue)" }}
          >
            Enviar comprobante
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

function ActionBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-7 w-7 rounded-[6px] border border-border text-muted hover:bg-bg hover:text-text"
    >
      {children}
    </Button>
  )
}

function EyeIcon() {
  return <Eye size={14} strokeWidth={1.3} color="currentColor" />
}

function DownloadIcon() {
  return <Download size={14} strokeWidth={1.4} color="currentColor" />
}

// ── WhatsApp Pagos Modal ──────────────────────────────────────────────────────

function WhatsAppPagosModal({ pagos, razonsocial, cuentaCorriente, tenantName, whatsappNumber, onClose }: {
  pagos: Pago[]
  razonsocial: string
  cuentaCorriente: number
  tenantName: string
  whatsappNumber: string
  onClose: () => void
}) {
  const [message, setMessage] = useState(() =>
    buildPagosWhatsAppMessage(tenantName, razonsocial, cuentaCorriente, pagos, fmt)
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

function WhatsAppPresupuestosModal({ presupuestos, razonsocial, cuentaCorriente, tenantName, whatsappNumber, initialIntent, onClose }: {
  presupuestos: Presupuesto[]
  razonsocial: string
  cuentaCorriente: number
  tenantName: string
  whatsappNumber: string
  initialIntent: WhatsAppPresupuestoIntent
  onClose: () => void
}) {
  const [intent, setIntent] = useState<WhatsAppPresupuestoIntent>(initialIntent)
  const [message, setMessage] = useState(() =>
    buildPresupuestosWhatsAppMessage(initialIntent, tenantName, razonsocial, cuentaCorriente, presupuestos, fmt)
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useEffect(() => {
    setMessage(buildPresupuestosWhatsAppMessage(intent, tenantName, razonsocial, cuentaCorriente, presupuestos, fmt))
    setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
  }, [intent, presupuestos, razonsocial, cuentaCorriente])

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
