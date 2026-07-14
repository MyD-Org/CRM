"use client"

import { useState, useEffect } from "react"
import { useRouter, useParams } from "next/navigation"
import { Button, Input, Field, Alert } from "@myd-org/ui"

type TokenState =
  | { status: "loading" }
  | { status: "valid"; email: string }
  | { status: "expired" }
  | { status: "used" }
  | { status: "invalid" }

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [tokenState, setTokenState] = useState<TokenState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/admin/auth/reset-password?token=${encodeURIComponent(token)}`)
        const data = await res.json()
        if (cancelled) return
        if (data.valid) setTokenState({ status: "valid", email: data.email })
        else if (data.expired) setTokenState({ status: "expired" })
        else if (data.used) setTokenState({ status: "used" })
        else setTokenState({ status: "invalid" })
      } catch {
        if (!cancelled) setTokenState({ status: "invalid" })
      }
    })()
    return () => { cancelled = true }
  }, [token])

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

  const cardStyle = {
    maxWidth: 408,
    background: "var(--card)",
    borderRadius: 16,
    borderTop: "3px solid var(--blue-bright)",
    boxShadow: "0 4px 32px rgba(12,62,214,0.08), 0 1px 4px rgba(0,0,0,0.06)",
  } as const

  if (tokenState.status === "loading") {
    return (
      <div className="w-full p-8" style={cardStyle}>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Verificando el link…</p>
      </div>
    )
  }

  if (tokenState.status !== "valid") {
    const message =
      tokenState.status === "expired"
        ? "Este link de invitación venció. Pedile a un administrador que te genere uno nuevo."
        : tokenState.status === "used"
          ? "Esta invitación ya fue utilizada. Si ya creaste tu contraseña, iniciá sesión normalmente."
          : "El link no es válido. Verificá que lo hayas copiado completo o pedí uno nuevo a un administrador."
    return (
      <div className="w-full p-8" style={cardStyle}>
        <div className="flex flex-col gap-1.5 mb-6">
          <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>
            {tokenState.status === "used" ? "Invitación ya utilizada" : "Link no disponible"}
          </h1>
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>{message}</p>
        </div>
        <Button onClick={() => router.push("/admin/login")} className="w-full justify-center">
          Ir a iniciar sesión
        </Button>
      </div>
    )
  }

  return (
    <div className="w-full p-8" style={cardStyle}>
      <div className="flex flex-col gap-1.5 mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>Creá tu contraseña</h1>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
          Estás activando la cuenta de <strong style={{ color: "var(--ink)" }}>{tokenState.email}</strong>. Elegí una contraseña de al menos 8 caracteres.
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
