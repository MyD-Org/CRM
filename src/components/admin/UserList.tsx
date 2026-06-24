"use client"

import { useState } from "react"
import { UserPlus, Mail, Shield, Clock, Pencil, Check, X } from "lucide-react"
import { Button, Input, Field, Select, Badge, Alert, Avatar } from "@myd-org/ui"

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
  currentRole: string
}

export function UserList({ initialUsers, currentUserId, currentRole }: Props) {
  const [users, setUsers] = useState(initialUsers)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: "", email: "", role: "operator" })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState("")
  const [formSuccess, setFormSuccess] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: "", role: "" })
  const [editError, setEditError] = useState("")
  const [editSaving, setEditSaving] = useState(false)

  function startEdit(user: AdminUser) {
    setEditingId(user.id)
    setEditForm({ name: user.name, role: user.role })
    setEditError("")
  }

  function cancelEdit() {
    setEditingId(null)
    setEditError("")
  }

  async function saveEdit(userId: string) {
    setEditError("")
    setEditSaving(true)
    try {
      const res = await fetch(`/api/admin/usuarios/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editForm),
      })
      const body = await res.json()
      if (res.ok) {
        setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, name: body.name, role: body.role } : u))
        setEditingId(null)
      } else {
        setEditError(body.error ?? "Error al guardar")
      }
    } finally {
      setEditSaving(false)
    }
  }

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

  const isSuperadmin = currentRole === "superadmin"

  return (
    <div>
      {isSuperadmin && (
        <div className="flex justify-end mb-4">
          <Button onClick={() => { setShowForm((p) => !p); setFormError(""); setFormSuccess("") }}>
            <UserPlus size={15} strokeWidth={1.6} />
            Invitar usuario
          </Button>
        </div>
      )}

      {showForm && (
        <div
          className="mb-4 p-5 rounded-[var(--radius)]"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h2 className="text-sm font-semibold mb-4" style={{ color: "var(--ink)" }}>Invitar nuevo usuario</h2>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nombre">
                <Input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  required
                  placeholder="Nombre del operador"
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  required
                  placeholder="email@empresa.com"
                />
              </Field>
            </div>
            <Field label="Rol">
              <Select
                value={form.role}
                onValueChange={(v) => setForm((p) => ({ ...p, role: v }))}
                options={[
                  { value: "operator", label: "Operador" },
                  { value: "superadmin", label: "Superadmin" },
                ]}
              />
            </Field>
            {formError && <Alert tone="danger">{formError}</Alert>}
            <div className="flex gap-2 justify-end pt-1">
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>Cancelar</Button>
              <Button type="submit" loading={submitting}>
                {submitting ? "Enviando..." : "Enviar invitación"}
              </Button>
            </div>
          </form>
        </div>
      )}

      {formSuccess && <Alert tone="success" className="mb-4">{formSuccess}</Alert>}

      <div className="rounded-[var(--radius)] overflow-hidden" style={{ border: "1px solid var(--border)" }}>
        <table className="w-full text-sm" style={{ background: "var(--card)" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Usuario", "Rol", "Estado", "Alta", ""].map((h, i) => (
                <th key={i} className="text-left px-4 py-3 text-xs font-semibold" style={{ color: "var(--ink-soft)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isEditing = editingId === user.id
              const isSelf = user.id === currentUserId
              const canEdit = isSelf || isSuperadmin

              return (
                <tr key={user.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  {/* Usuario */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Avatar name={isEditing ? editForm.name || user.name : user.name} size="sm" className="shrink-0" />
                      <div className="min-w-0">
                        {isEditing ? (
                          <Input
                            autoFocus
                            value={editForm.name}
                            onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                            className="w-40 py-1 h-auto"
                          />
                        ) : (
                          <p className="font-medium" style={{ color: "var(--ink)" }}>
                            {user.name}{" "}
                            {isSelf && <span className="text-xs font-normal" style={{ color: "var(--ink-faint)" }}>(vos)</span>}
                          </p>
                        )}
                        <p className="flex items-center gap-1 text-xs mt-0.5" style={{ color: "var(--ink-soft)" }}>
                          <Mail size={10} /> {user.email}
                        </p>
                      </div>
                    </div>
                  </td>

                  {/* Rol */}
                  <td className="px-4 py-3">
                    {isEditing && isSuperadmin && !isSelf ? (
                      <Select
                        value={editForm.role}
                        onValueChange={(v) => setEditForm((p) => ({ ...p, role: v }))}
                        options={[
                          { value: "operator", label: "Operador" },
                          { value: "superadmin", label: "Superadmin" },
                        ]}
                        className="w-36"
                      />
                    ) : (
                      <Badge tone={user.role === "superadmin" ? "warning" : "info"} className="flex items-center gap-1 w-fit">
                        <Shield size={10} />
                        {user.role === "superadmin" ? "Superadmin" : "Operador"}
                      </Badge>
                    )}
                  </td>

                  {/* Estado */}
                  <td className="px-4 py-3">
                    <Badge tone={user.hasPassword ? "success" : "warning"}>
                      {user.hasPassword ? "Activo" : "Invitación pendiente"}
                    </Badge>
                  </td>

                  {/* Alta */}
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                      <Clock size={10} />
                      {new Date(user.createdAt).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })}
                    </span>
                  </td>

                  {/* Acciones */}
                  <td className="px-4 py-3">
                    {canEdit && (
                      isEditing ? (
                        <div className="flex items-center gap-1">
                          {editError && <span className="text-xs mr-1 text-danger">{editError}</span>}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => saveEdit(user.id)}
                            disabled={editSaving || !editForm.name.trim()}
                            title="Guardar"
                          >
                            <Check size={13} strokeWidth={2} />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={cancelEdit} title="Cancelar">
                            <X size={13} strokeWidth={2} />
                          </Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="icon" onClick={() => startEdit(user)} title="Editar">
                          <Pencil size={13} strokeWidth={1.6} />
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
