"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button, Field, Input, Spinner } from "@myd-org/ui"
import { Logo } from "@/components/portal/Logo"
import { ChevronLeft, Clock, ShoppingCart } from "lucide-react"

export interface LoginPageProps {
  logoSrc: string
  tenantName: string
  tenantSubtitle: string
}

type Step = "identify" | "otp" | "tienda"

export default function LoginPage({ logoSrc, tenantName, tenantSubtitle }: LoginPageProps) {
  const router = useRouter()
  const [step, setStep] = useState<Step>("identify")
  const [identifier, setIdentifier] = useState("")
  const [otp, setOtp] = useState(["", "", "", "", "", ""])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [countdown, setCountdown] = useState(0)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCountdown = useCallback(() => {
    setCountdown(30)
    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(countdownRef.current!)
          return 0
        }
        return c - 1
      })
    }, 1000)
  }, [])

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Error al enviar el código")
        return
      }
      setOtp(["", "", "", "", "", ""])
      setStep("otp")
      startCountdown()
      setTimeout(() => otpRefs.current[0]?.focus(), 100)
    } catch {
      setError("Error de conexión. Intentá de nuevo.")
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    const code = otp.join("")
    if (code.length < 6) {
      setError("Ingresá los 6 dígitos del código")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Código incorrecto")
        return
      }
      router.push(data.redirect ?? "/portal/dashboard")
    } catch {
      setError("Error de conexión. Intentá de nuevo.")
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    if (countdown > 0) return
    setError("")
    setLoading(true)
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Error al reenviar")
        return
      }
      setOtp(["", "", "", "", "", ""])
      startCountdown()
      otpRefs.current[0]?.focus()
    } catch {
      setError("Error de conexión.")
    } finally {
      setLoading(false)
    }
  }

  function handleOtpChange(index: number, value: string) {
    const v = value.replace(/\D/g, "").slice(-1)
    const next = [...otp]
    next[index] = v
    setOtp(next)
    if (v && index < 5) {
      otpRefs.current[index + 1]?.focus()
    }
  }

  function handleOtpKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      if (otp[index]) {
        const next = [...otp]
        next[index] = ""
        setOtp(next)
      } else if (index > 0) {
        otpRefs.current[index - 1]?.focus()
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      otpRefs.current[index - 1]?.focus()
    } else if (e.key === "ArrowRight" && index < 5) {
      otpRefs.current[index + 1]?.focus()
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    e.preventDefault()
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6)
    if (text.length === 0) return
    const next = [...otp]
    for (let i = 0; i < 6; i++) {
      next[i] = text[i] ?? ""
    }
    setOtp(next)
    const focusIdx = Math.min(text.length, 5)
    otpRefs.current[focusIdx]?.focus()
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: "#eef1f5",
        backgroundImage:
          "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(31,140,255,0.18) 0%, transparent 70%)",
      }}
    >
      {/* Header */}
      <header
        className="w-full flex items-center justify-between px-8 py-4"
        style={{ background: "transparent" }}
      >
        <Logo size="md" showSubtitle src={logoSrc} name={tenantName} subtitle={tenantSubtitle} />
        <nav className="flex items-center gap-1 rounded-full p-1" style={{ background: "rgba(255,255,255,0.7)", border: "1px solid var(--border)" }}>
          <button
            onClick={() => setStep("identify")}
            className="px-4 py-1.5 rounded-full text-sm font-medium transition-all"
            style={
              step !== "tienda"
                ? { background: "var(--blue)", color: "white" }
                : { background: "transparent", color: "var(--ink-soft)" }
            }
          >
            Iniciar sesión
          </button>
          <button
            onClick={() => setStep("tienda")}
            className="px-4 py-1.5 rounded-full text-sm font-medium transition-all"
            style={
              step === "tienda"
                ? { background: "var(--blue)", color: "white" }
                : { background: "transparent", color: "var(--ink-soft)" }
            }
          >
            Tienda
          </button>
        </nav>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        {step === "tienda" ? (
          <TiendaCard onBack={() => setStep("identify")} />
        ) : (
          <div
            className="w-full"
            style={{
              maxWidth: 408,
              background: "var(--card)",
              borderRadius: 16,
              borderTop: "3px solid var(--blue-bright)",
              boxShadow: "0 4px 32px rgba(12,62,214,0.08), 0 1px 4px rgba(0,0,0,0.06)",
            }}
          >
            {step === "identify" && (
              <IdentifyStep
                identifier={identifier}
                setIdentifier={setIdentifier}
                onSubmit={handleSendCode}
                loading={loading}
                error={error}
              />
            )}
            {step === "otp" && (
              <OtpStep
                identifier={identifier}
                otp={otp}
                otpRefs={otpRefs}
                onOtpChange={handleOtpChange}
                onOtpKeyDown={handleOtpKeyDown}
                onOtpPaste={handleOtpPaste}
                onSubmit={handleVerifyCode}
                onResend={handleResend}
                onBack={() => { setStep("identify"); setError("") }}
                loading={loading}
                error={error}
                countdown={countdown}
              />
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Identify Step ────────────────────────────────────────────────────────────

function IdentifyStep({
  identifier,
  setIdentifier,
  onSubmit,
  loading,
  error,
}: {
  identifier: string
  setIdentifier: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  loading: boolean
  error: string
}) {
  return (
    <form onSubmit={onSubmit} className="p-8 flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>
          Bienvenido
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
          Ingresá tu CUIT o email para acceder a tu cuenta
        </p>
      </div>

      <Field label="CUIT o Email" error={error || undefined}>
        <Input
          id="identifier"
          type="text"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="20-12345678-9 o correo@empresa.com"
          autoFocus
          autoComplete="username"
          required
        />
      </Field>

      <Button
        type="submit"
        loading={loading}
        disabled={!identifier.trim()}
        className="w-full"
      >
        {loading ? (
          <>
            <Spinner size="sm" />
            Enviando...
          </>
        ) : (
          "Continuar"
        )}
      </Button>

      <p className="text-xs text-center" style={{ color: "var(--ink-faint)" }}>
        Te enviaremos un código de verificación de 6 dígitos.
      </p>
    </form>
  )
}

// ── OTP Step ─────────────────────────────────────────────────────────────────

function OtpStep({
  identifier,
  otp,
  otpRefs,
  onOtpChange,
  onOtpKeyDown,
  onOtpPaste,
  onSubmit,
  onResend,
  onBack,
  loading,
  error,
  countdown,
}: {
  identifier: string
  otp: string[]
  otpRefs: React.MutableRefObject<(HTMLInputElement | null)[]>
  onOtpChange: (i: number, v: string) => void
  onOtpKeyDown: (i: number, e: React.KeyboardEvent<HTMLInputElement>) => void
  onOtpPaste: (e: React.ClipboardEvent) => void
  onSubmit: (e: React.FormEvent) => void
  onResend: () => void
  onBack: () => void
  loading: boolean
  error: string
  countdown: number
}) {
  const maskedId =
    identifier.includes("@")
      ? identifier.replace(/(.{2}).+(@.+)/, "$1***$2")
      : identifier.replace(/^(.{4}).+(.{3})$/, "$1***$2")

  return (
    <form onSubmit={onSubmit} className="p-8 flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="w-fit px-0 text-primary hover:bg-transparent hover:opacity-70"
        >
          <ChevronLeft size={16} strokeWidth={1.8} color="currentColor" />
          Volver
        </Button>
        <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>
          Verificá tu identidad
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
          Ingresá el código de 6 dígitos enviado a{" "}
          <span className="font-medium" style={{ color: "var(--ink)" }}>{maskedId}</span>
        </p>
      </div>

      {/* OTP inputs */}
      <div className="flex gap-2 justify-center" onPaste={onOtpPaste}>
        {otp.map((digit, i) => (
          <input
            key={i}
            ref={(el) => { otpRefs.current[i] = el }}
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={2}
            value={digit}
            onChange={(e) => onOtpChange(i, e.target.value)}
            onKeyDown={(e) => onOtpKeyDown(i, e)}
            className="w-12 h-14 text-center text-xl font-bold rounded-[var(--radius)] outline-none transition-all"
            style={{
              border: error ? "1.5px solid var(--red)" : digit ? "1.5px solid var(--blue)" : "1.5px solid var(--border-strong)",
              color: "var(--ink)",
              background: "var(--card)",
            }}
            onFocus={(e) => {
              if (!error) e.currentTarget.style.borderColor = "var(--blue)"
              e.currentTarget.select()
            }}
            onBlur={(e) => {
              if (!e.currentTarget.value && !error) e.currentTarget.style.borderColor = "var(--border-strong)"
            }}
          />
        ))}
      </div>

      {error && (
        <p className="text-sm text-center" style={{ color: "var(--red)" }}>{error}</p>
      )}

      <Button
        type="submit"
        loading={loading}
        disabled={otp.join("").length < 6}
        className="w-full"
      >
        {loading ? (
          <>
            <Spinner size="sm" />
            Verificando...
          </>
        ) : (
          "Verificar"
        )}
      </Button>

      <div className="flex items-center justify-center gap-1 text-sm" style={{ color: "var(--ink-soft)" }}>
        <span>¿No recibiste el código?</span>
        {countdown > 0 ? (
          <span style={{ color: "var(--ink-faint)" }}>Reenviar en {countdown}s</span>
        ) : (
          <button
            type="button"
            onClick={onResend}
            className="font-medium underline transition-opacity hover:opacity-70"
            style={{ color: "var(--blue)" }}
          >
            Reenviar
          </button>
        )}
      </div>
    </form>
  )
}

// ── Tienda Card ──────────────────────────────────────────────────────────────

function TiendaCard({ onBack }: { onBack: () => void }) {
  return (
    <div
      className="w-full flex flex-col items-center gap-8 p-12"
      style={{
        maxWidth: 408,
        background: "var(--card)",
        borderRadius: 16,
        borderTop: "3px solid var(--blue-bright)",
        boxShadow: "0 4px 32px rgba(12,62,214,0.08), 0 1px 4px rgba(0,0,0,0.06)",
      }}
    >
      <div
        className="flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-semibold"
        style={{ background: "var(--blue-soft)", color: "var(--blue)" }}
      >
        <Clock size={14} strokeWidth={1.4} color="currentColor" />
        Muy pronto
      </div>

      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ background: "var(--blue-soft)" }}
        >
          <ShoppingCart size={32} strokeWidth={1.8} style={{ color: "var(--blue)" }} />
        </div>
        <h2 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>
          Tienda Online
        </h2>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
          Estamos trabajando para traerte la mejor experiencia de compra online.
          Pronto podrás adquirir todos nuestros productos desde aquí.
        </p>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="text-primary hover:bg-transparent hover:opacity-70"
      >
        <ChevronLeft size={16} strokeWidth={1.8} color="currentColor" />
        Volver al inicio de sesión
      </Button>
    </div>
  )
}
