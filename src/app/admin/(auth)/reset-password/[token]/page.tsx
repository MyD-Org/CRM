"use client"

import { useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { Button, Input, Field, Alert } from "@myd-org/ui"

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
      className="w-full p-8"
      style={{
        maxWidth: 408,
        background: "var(--card)",
        borderRadius: 16,
        borderTop: "3px solid var(--blue-bright)",
        boxShadow: "0 4px 32px rgba(12,62,214,0.08), 0 1px 4px rgba(0,0,0,0.06)",
      }}
    >
      <div className="flex flex-col gap-1.5 mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>Nueva contraseña</h1>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
          Elegí una contraseña de al menos 8 caracteres.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Nueva contraseña">
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Field label="Confirmar contraseña">
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}

        <Button type="submit" loading={loading} className="w-full justify-center">
          {loading ? "Guardando..." : "Guardar contraseña"}
        </Button>
      </form>
    </div>
  )
}
