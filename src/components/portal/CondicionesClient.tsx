"use client"

import Link from "next/link"
import { CreditCard, Tag, Truck, UserRound, ArrowLeft } from "lucide-react"
import { PortalHeader } from "./PortalHeader"
import type { Cliente, CondicionesComerciales } from "@/types"

function fmt(n: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(n)
}

interface Props {
  cliente: Cliente
  condiciones: CondicionesComerciales
  razonsocial: string
  tenantName: string
  logoSrc: string
  logoSubtitle: string
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-[var(--radius)] p-5 flex flex-col gap-4"
      style={{ background: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0"
          style={{ background: "var(--blue-soft)", color: "var(--blue)" }}
        >
          {icon}
        </div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-baseline gap-4 text-sm">
      <span style={{ color: "var(--ink-soft)" }}>{label}</span>
      <span className="font-medium text-right" style={{ color: "var(--ink)" }}>{value}</span>
    </div>
  )
}

export function CondicionesClient({ cliente, condiciones, razonsocial, tenantName, logoSrc, logoSubtitle }: Props) {
  const disponible = cliente.limitecredito - cliente.deudatotal
  const usadoPct = Math.min(100, Math.round((cliente.deudatotal / cliente.limitecredito) * 100))

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)" }}>
      <PortalHeader logoSrc={logoSrc} tenantName={tenantName} logoSubtitle={logoSubtitle} razonsocial={razonsocial} />

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
        <div>
          <Link
            href="/portal/dashboard"
            className="inline-flex items-center gap-1.5 text-xs font-medium mb-2 transition-opacity hover:opacity-70"
            style={{ color: "var(--blue)" }}
          >
            <ArrowLeft size={13} strokeWidth={2} />
            Volver al inicio
          </Link>
          <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>
            Condiciones comerciales
          </h1>
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            {razonsocial} · CUIT {cliente.cuit} · Cuenta corriente N° {cliente.numerocuentacorriente}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Condición de pago + crédito */}
          <Card icon={<CreditCard size={15} strokeWidth={1.8} />} title="Condición de pago y crédito">
            <div className="flex flex-col gap-2.5">
              <Row label="Condición de pago" value={condiciones.condicionPago} />
              <Row label="Plazo" value={`${condiciones.plazoDias} días`} />
              <div className="h-px" style={{ background: "var(--border)" }} />
              <Row label="Límite de crédito" value={fmt(cliente.limitecredito)} />
              <Row label="Deuda actual" value={fmt(cliente.deudatotal)} />
              <Row label="Disponible" value={<span style={{ color: "var(--green)" }}>{fmt(disponible)}</span>} />
              <div className="flex flex-col gap-1 mt-1">
                <div className="h-1.5 rounded-full" style={{ background: "var(--border)" }}>
                  <div
                    className="h-1.5 rounded-full"
                    style={{ width: `${usadoPct}%`, background: usadoPct > 85 ? "var(--red)" : "var(--blue)" }}
                  />
                </div>
                <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{usadoPct}% del crédito utilizado</span>
              </div>
            </div>
          </Card>

          {/* Lista de precios y descuentos */}
          <Card icon={<Tag size={15} strokeWidth={1.8} />} title="Lista de precios y descuentos">
            <div className="flex flex-col gap-2.5">
              <Row label="Lista asignada" value={condiciones.listaPrecios} />
              <div className="h-px" style={{ background: "var(--border)" }} />
              {condiciones.descuentos.map((d) => (
                <Row
                  key={d.concepto}
                  label={d.concepto}
                  value={<span style={{ color: "var(--green)" }}>−{d.porcentaje}%</span>}
                />
              ))}
            </div>
          </Card>

          {/* Vendedor asignado */}
          <Card icon={<UserRound size={15} strokeWidth={1.8} />} title="Vendedor asignado">
            <div className="flex flex-col gap-2.5">
              <Row label="Nombre" value={condiciones.vendedor.nombre} />
              <Row
                label="Teléfono"
                value={
                  <a href={`tel:${condiciones.vendedor.telefono.replace(/[^+\d]/g, "")}`} className="hover:underline" style={{ color: "var(--blue)" }}>
                    {condiciones.vendedor.telefono}
                  </a>
                }
              />
              <Row
                label="Email"
                value={
                  <a href={`mailto:${condiciones.vendedor.email}`} className="hover:underline" style={{ color: "var(--blue)" }}>
                    {condiciones.vendedor.email}
                  </a>
                }
              />
            </div>
          </Card>

          {/* Transporte y entregas */}
          <Card icon={<Truck size={15} strokeWidth={1.8} />} title="Transporte y entregas">
            <div className="flex flex-col gap-2.5">
              <Row label="Modalidad" value={condiciones.transporte.modalidad} />
              <div className="h-px" style={{ background: "var(--border)" }} />
              <p className="text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                {condiciones.transporte.observaciones}
              </p>
            </div>
          </Card>
        </div>

        <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
          Estas condiciones son informativas y pueden actualizarse. Ante cualquier duda, contactá a tu vendedor asignado.
        </p>
      </main>
    </div>
  )
}
