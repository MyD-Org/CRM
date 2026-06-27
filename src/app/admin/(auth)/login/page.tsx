"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button, Input, Field, Alert } from "@myd-org/ui"

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
        <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>Backoffice</h1>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Ingresá con tu email y contraseña</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Email">
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>

        <Field label="Contraseña">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}

        <Button type="submit" loading={loading} className="w-full justify-center">
          {loading ? "Ingresando..." : "Ingresar"}
        </Button>
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
