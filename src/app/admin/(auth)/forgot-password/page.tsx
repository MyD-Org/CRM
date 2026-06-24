"use client"

import { useState } from "react"
import Link from "next/link"

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch("/api/admin/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
    setSent(true)
    setLoading(false)
  }

  return (
    <div
      className="w-full max-w-sm rounded-[var(--radius)] p-8"
      style={{ background: "var(--card)", border: "1px solid var(--border)", boxShadow: "0 4px 24px rgba(0,0,0,0.07)" }}
    >
      <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--ink)" }}>Recuperar contraseña</h1>

      {sent ? (
        <>
          <p className="text-sm mt-2" style={{ color: "var(--ink-soft)" }}>
            Si el email existe, vas a recibir un link para restablecer tu contraseña.
          </p>
          <Link href="/admin/login" className="block text-center text-xs mt-6 hover:underline" style={{ color: "var(--blue)" }}>
            Volver al login
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm mb-6" style={{ color: "var(--ink-soft)" }}>
            Ingresá tu email y te enviamos un link para restablecer tu contraseña.
          </p>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
                style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="py-2 rounded-[var(--radius)] text-sm font-medium text-white transition-opacity disabled:opacity-60"
              style={{ background: "var(--blue)" }}
            >
              {loading ? "Enviando..." : "Enviar link"}
            </button>
          </form>
          <Link href="/admin/login" className="block text-center text-xs mt-4 hover:underline" style={{ color: "var(--ink-soft)" }}>
            Volver al login
          </Link>
        </>
      )}
    </div>
  )
}
