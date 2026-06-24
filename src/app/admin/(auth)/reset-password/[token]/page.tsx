"use client"

import { useState } from "react"
import { useRouter, useParams } from "next/navigation"

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError("Las contraseñas no coinciden"); return }
    if (password.length < 8) { setError("Mínimo 8 caracteres"); return }
    setError("")
    setLoading(true)
    try {
      const res = await fetch("/api/admin/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      if (res.ok) {
        router.push("/admin/login?reset=ok")
      } else {
        const body = await res.json()
        setError(body.error ?? "Error al restablecer contraseña")
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
      <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--ink)" }}>Nueva contraseña</h1>
      <p className="text-sm mb-6" style={{ color: "var(--ink-soft)" }}>Elegí una contraseña de al menos 8 caracteres.</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Nueva contraseña</label>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
            style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Confirmar contraseña</label>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
          {loading ? "Guardando..." : "Guardar contraseña"}
        </button>
      </form>
    </div>
  )
}
