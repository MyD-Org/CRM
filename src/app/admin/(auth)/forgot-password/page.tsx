"use client"

import { useState } from "react"
import Link from "next/link"
import { Button, Input, Field, Alert } from "@myd-org/ui"

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
      className="w-full p-8"
      style={{
        maxWidth: 408,
        background: "var(--card)",
        borderRadius: 16,
        borderTop: "3px solid var(--blue-bright)",
        boxShadow: "0 4px 32px rgba(12,62,214,0.08), 0 1px 4px rgba(0,0,0,0.06)",
      }}
    >
      <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--ink)" }}>Recuperar contraseña</h1>

      {sent ? (
        <>
          <Alert tone="success" className="mt-4">
            Si el email existe, vas a recibir un link para restablecer tu contraseña.
          </Alert>
          <Link
            href="/admin/login"
            className="block text-center text-xs mt-6 hover:underline"
            style={{ color: "var(--blue)" }}
          >
            Volver al login
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm mb-6 mt-1" style={{ color: "var(--ink-soft)" }}>
            Ingresá tu email y te enviamos un link para restablecer tu contraseña.
          </p>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" loading={loading} className="w-full justify-center">
              {loading ? "Enviando..." : "Enviar link"}
            </Button>
          </form>
          <Link
            href="/admin/login"
            className="block text-center text-xs mt-4 hover:underline"
            style={{ color: "var(--ink-soft)" }}
          >
            Volver al login
          </Link>
        </>
      )}
    </div>
  )
}
