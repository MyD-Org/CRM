import type { ReactNode } from "react"
import Link from "next/link"
import { Logo } from "./Logo"
import { LEGAL_LAST_UPDATED } from "@/lib/legal"

interface LegalDocProps {
  title: string
  tenantName: string
  logoSrc: string
  children: ReactNode
}

/** Marca un dato legal que el tenant todavía no cargó (env var vacía). */
export function Pendiente({ label }: { label: string }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[0.9em] font-medium"
      style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
    >
      [pendiente: {label}]
    </span>
  )
}

/** Muestra el valor, o un marcador visible si falta. */
export function Dato({ valor, label }: { valor: string; label: string }) {
  return valor ? <>{valor}</> : <Pendiente label={label} />
}

export function LegalDoc({ title, tenantName, logoSrc, children }: LegalDocProps) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <Logo src={logoSrc} name={tenantName} size="md" />

      <h1 className="mt-8 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        {title}
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--ink-faint)" }}>
        Última actualización: {LEGAL_LAST_UPDATED}
      </p>

      <div
        className="mt-8 flex flex-col gap-5 text-[15px] leading-relaxed"
        style={{ color: "var(--ink-soft)" }}
      >
        {children}
      </div>

      <nav
        className="mt-12 flex flex-wrap gap-x-5 gap-y-2 border-t pt-6 text-sm"
        style={{ borderColor: "var(--border)" }}
      >
        <Link href="/legal/privacidad" style={{ color: "var(--blue)" }}>
          Política de privacidad
        </Link>
        <Link href="/legal/terminos" style={{ color: "var(--blue)" }}>
          Términos y condiciones
        </Link>
        <Link href="/legal/eliminacion-datos" style={{ color: "var(--blue)" }}>
          Eliminación de datos
        </Link>
      </nav>
    </main>
  )
}

/** Sección con título, para no repetir estilos en cada documento. */
export function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>
        {titulo}
      </h2>
      {children}
    </section>
  )
}
