"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

export default function AdminLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        router.push("/admin/inbox")
      } else {
        const body = await res.json()
        setError(body.error ?? "Error al iniciar sesión")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="w-full max-w-sm rounded-[var(--radius)] p-8"
      style={{ background: "var(--card)", border: "1px solid var(--border)", boxShadow: "0 4px 24px rgba(0,0,0,0.07)" }}
    >
      <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--ink)" }}>Backoffice</h1>
      <p className="text-sm mb-6" style={{ color: "var(--ink-soft)" }}>Ingresá con tu email y contraseña</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Email</label>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
            style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Contraseña</label>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
            style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
          />
        </div>

        {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="py-2 rounded-[var(--radius)] text-sm font-medium text-white transition-opacity disabled:opacity-60"
          style={{ background: "var(--blue)" }}
        >
          {loading ? "Ingresando..." : "Ingresar"}
        </button>
      </form>

      <Link
        href="/admin/forgot-password"
        className="block text-center text-xs mt-4 hover:underline"
        style={{ color: "var(--blue)" }}
      >
        Olvidé mi contraseña
      </Link>
    </div>
  )
}
