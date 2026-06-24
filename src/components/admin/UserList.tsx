"use client"

import { useState } from "react"
import { UserPlus, Mail, Shield, Clock } from "lucide-react"

interface AdminUser {
  id: string
  email: string
  name: string
  role: string
  hasPassword: boolean
  createdAt: Date | string
}

interface Props {
  initialUsers: AdminUser[]
  currentUserId: string
}

export function UserList({ initialUsers, currentUserId }: Props) {
  const [users, setUsers] = useState(initialUsers)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: "", email: "", role: "operator" })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState("")
  const [formSuccess, setFormSuccess] = useState("")

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormError("")
    setFormSuccess("")
    setSubmitting(true)
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      })
      const body = await res.json()
      if (res.ok) {
        setFormSuccess(`Invitación enviada a ${form.email}`)
        setForm({ name: "", email: "", role: "operator" })
        setShowForm(false)
        const listRes = await fetch("/api/admin/usuarios")
        if (listRes.ok) setUsers(await listRes.json())
      } else {
        setFormError(body.error ?? "Error al crear usuario")
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {/* Botón nuevo usuario */}
      <div className="flex justify-end mb-4">
        <button
          onClick={() => { setShowForm((p) => !p); setFormError(""); setFormSuccess("") }}
          className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] text-sm font-medium text-white"
          style={{ background: "var(--blue)" }}
        >
          <UserPlus size={15} strokeWidth={1.6} />
          Invitar usuario
        </button>
      </div>

      {/* Form de alta */}
      {showForm && (
        <div
          className="mb-4 p-5 rounded-[var(--radius)]"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h2 className="text-sm font-semibold mb-4" style={{ color: "var(--ink)" }}>Invitar nuevo usuario</h2>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Nombre</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  required
                  className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
                  style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  required
                  className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
                  style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Rol</label>
              <select
                value={form.role}
                onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
                className="px-3 py-2 rounded-[var(--radius)] text-sm outline-none"
                style={{ border: "1px solid var(--border-strong)", background: "var(--bg)", color: "var(--ink)" }}
              >
                <option value="operator">Operador</option>
                <option value="superadmin">Superadmin</option>
              </select>
            </div>
            {formError && <p className="text-xs" style={{ color: "var(--red)" }}>{formError}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 rounded-[var(--radius)] text-sm"
                style={{ color: "var(--ink-soft)" }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-[var(--radius)] text-sm font-medium text-white disabled:opacity-60"
                style={{ background: "var(--blue)" }}
              >
                {submitting ? "Enviando..." : "Enviar invitación"}
              </button>
            </div>
          </form>
        </div>
      )}

      {formSuccess && (
        <div className="mb-4 p-3 rounded-[var(--radius)] text-sm" style={{ background: "var(--green-soft)", color: "var(--green)" }}>
          {formSuccess}
        </div>
      )}

      {/* Tabla de usuarios */}
      <div className="rounded-[var(--radius)] overflow-hidden" style={{ border: "1px solid var(--border)" }}>
        <table className="w-full text-sm" style={{ background: "var(--card)" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Usuario", "Rol", "Estado", "Alta"].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold" style={{ color: "var(--ink-soft)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                      style={{ background: "var(--blue)" }}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium" style={{ color: "var(--ink)" }}>
                        {user.name} {user.id === currentUserId && <span className="text-xs font-normal" style={{ color: "var(--ink-faint)" }}>(vos)</span>}
                      </p>
                      <p className="flex items-center gap-1 text-xs" style={{ color: "var(--ink-soft)" }}>
                        <Mail size={10} /> {user.email}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className="flex items-center gap-1 w-fit px-2 py-0.5 rounded-full text-xs font-medium"
                    style={{
                      background: user.role === "superadmin" ? "var(--amber-soft)" : "var(--blue-soft)",
                      color: user.role === "superadmin" ? "var(--amber)" : "var(--blue)",
                    }}
                  >
                    <Shield size={10} />
                    {user.role === "superadmin" ? "Superadmin" : "Operador"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className="text-xs px-2 py-0.5 rounded-full"
                    style={{
                      background: user.hasPassword ? "var(--green-soft)" : "var(--amber-soft)",
                      color: user.hasPassword ? "var(--green)" : "var(--amber)",
                    }}
                  >
                    {user.hasPassword ? "Activo" : "Invitación pendiente"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                    <Clock size={10} />
                    {new Date(user.createdAt).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
