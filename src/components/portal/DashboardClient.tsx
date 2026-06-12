"use client"

import { useState, useMemo, useRef, useEffect } from "react"
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
import { CreditCard, Search, Plus, X, Upload, FileText, Check, Eye, Download, Info, Calendar, ChevronDown, CheckSquare } from "lucide-react"

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tooltip({ text, white = false }: { text: string; white?: boolean }) {
  return (
    <span className="relative group inline-flex items-center">
      <Info
        size={13}
        strokeWidth={1.6}
        style={{ color: white ? "rgba(255,255,255,0.6)" : "var(--ink-faint)", cursor: "default" }}
      />
      <span
        className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 rounded-lg px-3 py-2 text-xs leading-relaxed opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 text-center"
        style={{
          background: "var(--ink)",
          color: "white",
          boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
        }}
      >
        {text}
        <span
          className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent"
          style={{ borderTopColor: "var(--ink)" }}
        />
      </span>
    </span>
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

// ── Ordenamiento de columnas ─────────────────────────────────────────────────

type SortDir = 1 | -1

function useSort<K extends string>(defaultDescKeys: readonly K[] = [], initialKey: K | null = null) {
  const [sortKey, setSortKey] = useState<K | null>(initialKey)
  const [sortDir, setSortDir] = useState<SortDir>(initialKey && defaultDescKeys.includes(initialKey) ? -1 : 1)

  function toggleSort(key: K) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1))
    } else {
      setSortKey(key)
      setSortDir(defaultDescKeys.includes(key) ? -1 : 1)
    }
  }

  return { sortKey, sortDir, toggleSort }
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b), "es")
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  align = "left",
  className = "",
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  align?: "left" | "right"
  className?: string
}) {
  return (
    <th
      onClick={onClick}
      className={`py-2 px-3 font-medium text-xs cursor-pointer select-none transition-colors ${align === "right" ? "text-right" : "text-left"} ${className}`}
      style={{ color: active ? "var(--blue)" : "var(--ink-soft)" }}
      aria-sort={active ? (dir === 1 ? "ascending" : "descending") : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span style={{ fontSize: 7, lineHeight: 1, visibility: active ? "visible" : "hidden" }}>
          {dir === 1 ? "▲" : "▼"}
        </span>
      </span>
    </th>
  )
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
}

type Tab = "facturas" | "pagos" | "presupuestos"

// ── Component ────────────────────────────────────────────────────────────────

export function DashboardClient({ cliente, facturas, pagos, presupuestos, razonsocial, tenantName, whatsappNumber, logoSrc, logoSubtitle }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("facturas")
  const [facturasFilter, setFacturasFilter] = useState<FacturaEstado | "todos">("todos")
  const [facturasSearch, setFacturasSearch] = useState("")

  const vencidasCount = facturas.filter((f) => f.estado === "vencida").length
  const pendientesCount = facturas.filter((f) => f.estado === "pendiente").length
  const topVencidas = facturas.filter((f) => f.estado === "vencida").slice(0, 2)
  const topPendientes = facturas.filter((f) => f.estado === "pendiente").slice(0, 2)

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <PortalHeader logoSrc={logoSrc} tenantName={tenantName} logoSubtitle={logoSubtitle} razonsocial={razonsocial} />

      {/* Content */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
        {/* Welcome */}
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>
            Bienvenido, {razonsocial}
          </h1>
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            CUIT {cliente.cuit} · Cuenta corriente N° {cliente.numerocuentacorriente}
          </p>
        </div>

        {/* Summary Cards */}
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

        {/* Tabs */}
        <div
          className="rounded-[var(--radius)] flex flex-col"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <div
            className="flex gap-0 border-b px-4"
            style={{ borderColor: "var(--border)" }}
          >
            {(["facturas", "pagos", "presupuestos"] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="px-4 py-3.5 text-sm font-medium capitalize transition-all relative"
                style={{
                  color: activeTab === tab ? "var(--blue)" : "var(--ink-soft)",
                  borderBottom: activeTab === tab ? "2px solid var(--blue)" : "2px solid transparent",
                }}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

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
              />
            )}
            {activeTab === "pagos" && <PagosTable pagos={pagos} facturas={facturas} razonsocial={razonsocial} cuentaCorriente={cliente.numerocuentacorriente} tenantName={tenantName} whatsappNumber={whatsappNumber} />}
            {activeTab === "presupuestos" && <PresupuestosTable presupuestos={presupuestos} razonsocial={razonsocial} cuentaCorriente={cliente.numerocuentacorriente} tenantName={tenantName} whatsappNumber={whatsappNumber} />}
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

function FacturaBadge({ estado }: { estado: FacturaEstado }) {
  const styles: Record<FacturaEstado, React.CSSProperties> = {
    pendiente: { background: "var(--amber-soft)", color: "var(--amber)" },
    vencida: { background: "var(--red-soft)", color: "var(--red)" },
    pagada: { background: "var(--green-soft)", color: "var(--green)" },
  }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
      style={styles[estado]}
    >
      {FACTURA_ESTADO_LABELS[estado]}
    </span>
  )
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

  const { sortKey, sortDir, toggleSort } = useSort<"id" | "emision" | "vencimiento" | "importe" | "estado">(["emision", "vencimiento", "importe"], "emision")
  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const estadoOrder: Record<FacturaEstado, number> = { vencida: 0, pendiente: 1, pagada: 2 }
    return [...filtered].sort((a, b) => {
      let av: unknown, bv: unknown
      if (sortKey === "emision" || sortKey === "vencimiento") { av = parseLocalDate(a[sortKey]); bv = parseLocalDate(b[sortKey]) }
      else if (sortKey === "estado") { av = estadoOrder[a.estado]; bv = estadoOrder[b.estado] }
      else { av = a[sortKey]; bv = b[sortKey] }
      return compareValues(av, bv) * sortDir
    })
  }, [filtered, sortKey, sortDir])

  const allSelected = filtered.length > 0 && filtered.every((f) => selected.has(f.id))
  const selectedFacturas = facturas.filter((f) => selected.has(f.id))
  const selectedTotal = selectedFacturas.reduce((s, f) => s + saldoDe(f), 0)

  function toggleAll() {
    if (allSelected) {
      const next = new Set(selected)
      filtered.forEach((f) => next.delete(f.id))
      setSelected(next)
    } else {
      const next = new Set(selected)
      filtered.forEach((f) => next.add(f.id))
      setSelected(next)
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

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

      <div className="overflow-x-auto mt-2">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th className="w-10 py-2 px-2 text-left">
                <Checkbox checked={allSelected} onChange={toggleAll} />
              </th>
              <SortableTh label="Comprobante" active={sortKey === "id"} dir={sortDir} onClick={() => toggleSort("id")} />
              <SortableTh label="Emisión" active={sortKey === "emision"} dir={sortDir} onClick={() => toggleSort("emision")} className="hidden sm:table-cell" />
              <SortableTh label="Vencimiento" active={sortKey === "vencimiento"} dir={sortDir} onClick={() => toggleSort("vencimiento")} />
              <SortableTh label="Importe" active={sortKey === "importe"} dir={sortDir} onClick={() => toggleSort("importe")} align="right" />
              <SortableTh label="Estado" active={sortKey === "estado"} dir={sortDir} onClick={() => toggleSort("estado")} className="hidden md:table-cell" />
              <th className="py-2 px-3 text-right font-medium text-xs" style={{ color: "var(--ink-soft)" }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-sm" style={{ color: "var(--ink-faint)" }}>
                  No hay facturas para mostrar
                </td>
              </tr>
            ) : (
              sorted.map((f) => (
                <tr
                  key={f.id}
                  className="transition-colors"
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: selected.has(f.id) ? "var(--blue-soft)" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (!selected.has(f.id)) e.currentTarget.style.background = "var(--bg)" }}
                  onMouseLeave={(e) => { if (!selected.has(f.id)) e.currentTarget.style.background = "transparent" }}
                >
                  <td className="py-2.5 px-2">
                    <Checkbox checked={selected.has(f.id)} onChange={() => toggleOne(f.id)} />
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="font-medium" style={{ color: "var(--ink)" }}>{f.id}</div>
                    <div className="text-xs" style={{ color: "var(--ink-faint)" }}>{f.tipo}</div>
                  </td>
                  <td className="py-2.5 px-3 hidden sm:table-cell text-xs" style={{ color: "var(--ink-soft)" }}>{f.emision}</td>
                  <td className="py-2.5 px-3 text-xs" style={{ color: "var(--ink-soft)" }}>{f.vencimiento}</td>
                  <td className="py-2.5 px-3 text-right font-medium tabular-nums" style={{ color: "var(--ink)" }}>
                    {esPagoParcial(f) ? (
                      <div className="inline-flex flex-col items-end gap-1">
                        <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{fmt(f.importe)}</span>
                        <span className="block rounded-full overflow-hidden" style={{ width: 92, height: 4, background: "var(--border)" }}>
                          <span
                            className="block h-full rounded-full"
                            style={{ width: `${Math.round(((f.pagado ?? 0) / f.importe) * 100)}%`, background: "var(--blue)" }}
                          />
                        </span>
                        <span className="font-bold" style={{ fontSize: 12.5 }}>Saldo {fmt(saldoDe(f))}</span>
                      </div>
                    ) : (
                      fmt(f.importe)
                    )}
                  </td>
                  <td className="py-2.5 px-3 hidden md:table-cell">
                    <div className="inline-flex flex-col items-start gap-1">
                      <FacturaBadge estado={f.estado} />
                      {esPagoParcial(f) && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: "var(--blue)" }}>
                          <span className="rounded-full" style={{ width: 5, height: 5, background: "var(--blue)" }} />
                          Pago parcial
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center justify-end gap-2">
                      <ActionBtn onClick={() => setModalFactura(f)} label="Ver">
                        <EyeIcon />
                      </ActionBtn>
                      <ActionBtn onClick={() => alert("Descarga: próximamente")} label="Descargar">
                        <DownloadIcon />
                      </ActionBtn>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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

function PagosTable({ pagos, facturas, razonsocial, cuentaCorriente, tenantName, whatsappNumber }: { pagos: Pago[]; facturas: Factura[]; razonsocial: string; cuentaCorriente: number; tenantName: string; whatsappNumber: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [modalPago, setModalPago] = useState<Pago | null>(null)
  const [showAdjuntar, setShowAdjuntar] = useState(false)
  const [wspModal, setWspModal] = useState(false)
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [dateFilterField, setDateFilterField] = useState<"emision" | "vencimiento">("emision")
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const desde = fromDate ? isoToLocal(fromDate) : null
    const hasta = toDate ? isoToLocal(toDate) : null
    return pagos.filter((p) => {
      const matchSearch = !search || p.id.toLowerCase().includes(search.toLowerCase()) || p.facturaAsociada.toLowerCase().includes(search.toLowerCase())
      const field = p.fecha
      const fecha = parseLocalDate(field)
      const matchFrom = !desde || !fecha || fecha >= desde
      const matchTo = !hasta || !fecha || fecha <= hasta
      return matchSearch && matchFrom && matchTo
    })
  }, [pagos, search, fromDate, toDate, dateFilterField])

  const { sortKey, sortDir, toggleSort } = useSort<"id" | "fecha" | "facturaAsociada" | "medio" | "monto">(["fecha", "monto"], "fecha")
  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    return [...filtered].sort((a, b) => {
      const av = sortKey === "fecha" ? parseLocalDate(a.fecha) : a[sortKey]
      const bv = sortKey === "fecha" ? parseLocalDate(b.fecha) : b[sortKey]
      return compareValues(av, bv) * sortDir
    })
  }, [filtered, sortKey, sortDir])

  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const selectedPagos = pagos.filter((p) => selected.has(p.id))
  const selectedTotal = selectedPagos.reduce((s, p) => s + p.monto, 0)

  function toggleAll() {
    if (allSelected) {
      const next = new Set(selected)
      filtered.forEach((p) => next.delete(p.id))
      setSelected(next)
    } else {
      const next = new Set(selected)
      filtered.forEach((p) => next.add(p.id))
      setSelected(next)
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

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
          dateFilterField={dateFilterField}
          onDateFilterFieldChange={setDateFilterField}
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

      <div className="overflow-x-auto mt-2">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th className="w-10 py-2 px-2 text-left">
                <Checkbox checked={allSelected} onChange={toggleAll} />
              </th>
              <SortableTh label="Recibo" active={sortKey === "id"} dir={sortDir} onClick={() => toggleSort("id")} />
              <SortableTh label="Fecha" active={sortKey === "fecha"} dir={sortDir} onClick={() => toggleSort("fecha")} />
              <SortableTh label="Factura asociada" active={sortKey === "facturaAsociada"} dir={sortDir} onClick={() => toggleSort("facturaAsociada")} className="hidden md:table-cell" />
              <SortableTh label="Medio" active={sortKey === "medio"} dir={sortDir} onClick={() => toggleSort("medio")} className="hidden sm:table-cell" />
              <SortableTh label="Monto pagado" active={sortKey === "monto"} dir={sortDir} onClick={() => toggleSort("monto")} align="right" />
              <th className="py-2 px-3 text-right font-medium text-xs" style={{ color: "var(--ink-soft)" }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-sm" style={{ color: "var(--ink-faint)" }}>
                  No hay pagos para mostrar
                </td>
              </tr>
            ) : (
              sorted.map((p) => (
                <tr
                  key={p.id}
                  className="transition-colors"
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: selected.has(p.id) ? "var(--blue-soft)" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (!selected.has(p.id)) e.currentTarget.style.background = "var(--bg)" }}
                  onMouseLeave={(e) => { if (!selected.has(p.id)) e.currentTarget.style.background = "transparent" }}
                >
                  <td className="py-2.5 px-2">
                    <Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="font-medium" style={{ color: "var(--ink)" }}>{p.id}</div>
                    <div className="text-xs" style={{ color: "var(--ink-faint)" }}>Recibo de pago</div>
                  </td>
                  <td className="py-2.5 px-3 text-xs" style={{ color: "var(--ink-soft)" }}>{p.fecha}</td>
                  <td className="py-2.5 px-3 text-xs hidden md:table-cell" style={{ color: "var(--ink-soft)" }}>{p.facturaAsociada}</td>
                  <td className="py-2.5 px-3 text-xs hidden sm:table-cell" style={{ color: "var(--ink-soft)" }}>{p.medio}</td>
                  <td className="py-2.5 px-3 text-right font-medium tabular-nums" style={{ color: "var(--green)" }}>{fmt(p.monto)}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center justify-end gap-2">
                      <ActionBtn onClick={() => setModalPago(p)} label="Ver">
                        <EyeIcon />
                      </ActionBtn>
                      <ActionBtn onClick={() => alert("Descarga: próximamente")} label="Descargar">
                        <DownloadIcon />
                      </ActionBtn>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
  const styles: Record<PresupuestoEstado, React.CSSProperties> = {
    vigente: { background: "var(--blue-soft)", color: "var(--blue)" },
    vencido: { background: "var(--red-soft)", color: "var(--red)" },
    aceptado: { background: "var(--green-soft)", color: "var(--green)" },
  }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
      style={styles[estado]}
    >
      {PRESUPUESTO_ESTADO_LABELS[estado]}
    </span>
  )
}

function PresupuestosTable({ presupuestos, razonsocial, cuentaCorriente, tenantName, whatsappNumber }: { presupuestos: Presupuesto[]; razonsocial: string; cuentaCorriente: number; tenantName: string; whatsappNumber: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
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

  const { sortKey, sortDir, toggleSort } = useSort<"id" | "fecha" | "validoHasta" | "total" | "estado">(["fecha", "validoHasta", "total"], "fecha")
  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const estadoOrder: Record<PresupuestoEstado, number> = { vencido: 0, vigente: 1, aceptado: 2 }
    return [...filtered].sort((a, b) => {
      let av: unknown, bv: unknown
      if (sortKey === "fecha" || sortKey === "validoHasta") { av = parseLocalDate(a[sortKey]); bv = parseLocalDate(b[sortKey]) }
      else if (sortKey === "estado") { av = estadoOrder[a.estado]; bv = estadoOrder[b.estado] }
      else { av = a[sortKey]; bv = b[sortKey] }
      return compareValues(av, bv) * sortDir
    })
  }, [filtered, sortKey, sortDir])

  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const selectedPresupuestos = presupuestos.filter((p) => selected.has(p.id))
  const selectedTotal = selectedPresupuestos.reduce((s, p) => s + p.total, 0)

  function toggleAll() {
    if (allSelected) {
      const next = new Set(selected)
      filtered.forEach((p) => next.delete(p.id))
      setSelected(next)
    } else {
      const next = new Set(selected)
      filtered.forEach((p) => next.add(p.id))
      setSelected(next)
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
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

      <div className="overflow-x-auto mt-2">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th className="w-10 py-2 px-2 text-left">
                <Checkbox checked={allSelected} onChange={toggleAll} />
              </th>
              <SortableTh label="Presupuesto" active={sortKey === "id"} dir={sortDir} onClick={() => toggleSort("id")} />
              <SortableTh label="Fecha" active={sortKey === "fecha"} dir={sortDir} onClick={() => toggleSort("fecha")} className="hidden sm:table-cell" />
              <SortableTh label="Válido hasta" active={sortKey === "validoHasta"} dir={sortDir} onClick={() => toggleSort("validoHasta")} className="hidden md:table-cell" />
              <SortableTh label="Total" active={sortKey === "total"} dir={sortDir} onClick={() => toggleSort("total")} align="right" />
              <SortableTh label="Estado" active={sortKey === "estado"} dir={sortDir} onClick={() => toggleSort("estado")} className="hidden md:table-cell" />
              <th className="py-2 px-3 text-right font-medium text-xs" style={{ color: "var(--ink-soft)" }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-sm" style={{ color: "var(--ink-faint)" }}>
                  No hay presupuestos para mostrar
                </td>
              </tr>
            ) : (
              sorted.map((p) => (
                <tr
                  key={p.id}
                  className="transition-colors"
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: selected.has(p.id) ? "var(--blue-soft)" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (!selected.has(p.id)) e.currentTarget.style.background = "var(--bg)" }}
                  onMouseLeave={(e) => { if (!selected.has(p.id)) e.currentTarget.style.background = "transparent" }}
                >
                  <td className="py-2.5 px-2">
                    <Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="font-medium" style={{ color: "var(--ink)" }}>{p.id}</div>
                  </td>
                  <td className="py-2.5 px-3 text-xs hidden sm:table-cell" style={{ color: "var(--ink-soft)" }}>{p.fecha}</td>
                  <td className="py-2.5 px-3 text-xs hidden md:table-cell" style={{ color: "var(--ink-soft)" }}>{p.validoHasta}</td>
                  <td className="py-2.5 px-3 text-right font-medium tabular-nums" style={{ color: "var(--ink)" }}>{fmt(p.total)}</td>
                  <td className="py-2.5 px-3 hidden md:table-cell">
                    <PresupuestoBadge estado={p.estado} />
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center justify-end gap-2">
                      <ActionBtn onClick={() => setModalPresupuesto(p)} label="Ver">
                        <EyeIcon />
                      </ActionBtn>
                      <ActionBtn onClick={() => alert("Descarga: próximamente")} label="Descargar">
                        <DownloadIcon />
                      </ActionBtn>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
              const prefix = activeDateField === "vencimiento" ? "Vence: " : "Emit.: "
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
                <div className="flex gap-1 bg-[var(--bg)] border border-[var(--border)] rounded-[8px] p-0.5 mb-2.5">
                  <button
                    type="button"
                    onClick={() => onDateFilterFieldChange?.("emision")}
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
                    onClick={() => onDateFilterFieldChange?.("vencimiento")}
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

      {/* Search — icon inside input, closes on blur if empty */}
      <div className="relative shrink-0 flex items-center">
        {searchOpen ? (
          <div
            className="flex items-center gap-1.5 rounded-full px-2.5"
            style={{ border: "1px solid var(--blue)", background: "var(--card)", height: 26 }}
          >
            <Search size={13} strokeWidth={1.4} style={{ color: "var(--blue)", flexShrink: 0 }} />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onBlur={() => { if (!search) setSearchOpen(false) }}
              placeholder="Buscar..."
              className="text-xs outline-none bg-transparent"
              style={{ width: 160, color: "var(--ink)" }}
            />
            {search && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setSearch(""); searchRef.current?.focus() }}
                aria-label="Limpiar búsqueda"
                className="flex items-center justify-center shrink-0 transition-opacity hover:opacity-70"
                style={{ color: "var(--blue)" }}
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
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
  const hasSelection = count > 0

  return (
    <div
      className="rounded-[10px] mt-3 mb-3 overflow-hidden"
      style={{
        background: hasSelection ? "var(--blue)" : "var(--bg)",
        border: `1px solid ${hasSelection ? "var(--blue)" : "var(--border)"}`,
        transition: "background 0.2s, border-color 0.2s",
      }}
    >
      {/* Fila info */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        {hasSelection ? (
          <button
            onClick={onClear}
            className="flex items-center justify-center w-6 h-6 rounded-full shrink-0"
            style={{ background: "rgba(255,255,255,0.2)" }}
            aria-label="Limpiar selección"
          >
            <X size={11} strokeWidth={2.5} color="white" />
          </button>
        ) : (
          <div className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center" style={{ background: "var(--border)" }}>
            <CheckSquare size={12} strokeWidth={1.8} style={{ color: "var(--ink-faint)" }} />
          </div>
        )}

        <div className="flex flex-col flex-1 min-w-0">
          {hasSelection ? (
            <>
              <span className="text-sm font-bold text-white">{count} {itemLabel}{count !== 1 ? "s" : ""} seleccionada{count !== 1 ? "s" : ""}</span>
              <span className="text-xs text-white/80">Total: {fmt(total)}</span>
            </>
          ) : (
            <span className="text-sm" style={{ color: "var(--ink-soft)" }}>Seleccioná para descargar o consultar</span>
          )}
        </div>

        {/* Botones — en pantallas angostas bajan a su propia fila */}
        <div className={`${hasSelection ? "flex" : "hidden sm:flex"} items-center gap-2 shrink-0 basis-full sm:basis-auto order-last sm:order-none`}>
          <button
            onClick={onDownload}
            disabled={!hasSelection}
            className="flex items-center justify-center gap-1.5 flex-1 sm:flex-none px-3 py-1.5 rounded-[7px] text-xs font-semibold transition-all"
            style={
              hasSelection
                ? { background: "rgba(255,255,255,0.18)", color: "white" }
                : { background: "var(--border)", color: "var(--ink-faint)", cursor: "not-allowed" }
            }
          >
            <DownloadIcon />
            Descargar
          </button>
          {onWhatsapp && (
            <button
              onClick={onWhatsapp}
              disabled={!hasSelection}
              className="flex items-center justify-center gap-1.5 flex-1 sm:flex-none px-3 py-1.5 rounded-[7px] text-xs font-semibold transition-all"
              style={
                hasSelection
                  ? { background: "var(--wsp)", color: "white" }
                  : { background: "var(--border)", color: "var(--ink-faint)", cursor: "not-allowed" }
              }
            >
              <WspIcon size={14} />
              Consultar
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Modal base ────────────────────────────────────────────────────────────────

function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(22,25,29,0.5)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col"
        style={{
          background: "var(--card)",
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-6 py-4 sticky top-0"
          style={{ background: "var(--card)", borderBottom: "1px solid var(--border)" }}
        >
          <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full transition-all"
            style={{ color: "var(--ink-soft)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)" }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
          >
            <X size={16} strokeWidth={1.8} color="currentColor" />
          </button>
        </div>
        <div className="p-6 flex-1">{children}</div>
      </div>
    </div>
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
  const facturaAsoc = facturas.find((f) => f.id === pago.facturaAsociada)

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
          {facturaAsoc ? (
            <div
              className="flex items-center justify-between p-3 rounded-[var(--radius)]"
              style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
            >
              <div>
                <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>{facturaAsoc.id}</p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{facturaAsoc.tipo} · Emitida {facturaAsoc.emision}</p>
              </div>
              <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(facturaAsoc.importe)}</span>
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>{pago.facturaAsociada}</p>
          )}
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

        {/* Tipo */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" style={{ color: "var(--ink)" }}>Tipo de comprobante</label>
          <select
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
            style={{ border: "1px solid var(--border-strong)", color: "var(--ink)", background: "var(--card)" }}
          >
            <option value="transferencia">Transferencia bancaria</option>
            <option value="cheque">Cheque</option>
            <option value="efectivo">Efectivo</option>
            <option value="otro">Otro</option>
          </select>
        </div>

        {/* Factura asociada */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" style={{ color: "var(--ink)" }}>Factura asociada (opcional)</label>
          <select
            value={facturaId}
            onChange={(e) => setFacturaId(e.target.value)}
            className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
            style={{ border: "1px solid var(--border-strong)", color: "var(--ink)", background: "var(--card)" }}
          >
            <option value="">Sin asociar</option>
            {facturas.map((f) => (
              <option key={f.id} value={f.id}>{f.id} — {fmt(f.importe)}</option>
            ))}
          </select>
        </div>

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

function Checkbox({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all"
      style={{
        border: checked ? "none" : "1.5px solid var(--border-strong)",
        background: checked ? "var(--blue)" : "transparent",
      }}
    >
      {checked && (
        <Check size={10} strokeWidth={1.6} color="white" />
      )}
    </button>
  )
}

function ActionBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      title={label}
      onClick={onClick}
      className="w-7 h-7 flex items-center justify-center rounded-[6px] transition-all"
      style={{ color: "var(--ink-soft)", border: "1px solid var(--border)" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)"; e.currentTarget.style.color = "var(--ink)" }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--ink-soft)" }}
    >
      {children}
    </button>
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
