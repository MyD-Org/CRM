"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { UserPlus, Mail, Shield, Clock, Pencil, Check, X, Link, RefreshCw, Trash2, ChevronDown } from "lucide-react"
import { Button, Input, Field, Select, Badge, Alert, Avatar, Dialog, useToast } from "@myd-org/ui"

interface AdminUser {
  id: string
  email: string
  name: string
  role: string
  departments: string[]
  hasPassword: boolean
  createdAt: Date | string
  inviteExpiresAt: Date | string | null
  inviteAcceptedAt: Date | string | null
}

// Las opciones de departamento se cargan desde /api/admin/departments (tabla por tenant).
// Un operador puede tener 0..N departamentos (multi). 0 = "sin departamento".

interface Props {
  initialUsers: AdminUser[]
  currentUserId: string
  currentRole: string
}

export function UserList({ initialUsers, currentUserId, currentRole }: Props) {
  const [users, setUsers] = useState(initialUsers)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<{ name: string; email: string; role: string; departments: string[] }>({ name: "", email: "", role: "operator", departments: [] })
  const { toast } = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState("")
  // URLs de invitación conocidas en esta sesión (userId → url)
  const [pendingUrls, setPendingUrls] = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ name: string; role: string; departments: string[] }>({ name: "", role: "", departments: [] })
  const [editError, setEditError] = useState("")
  const [editSaving, setEditSaving] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Modal con el link de invitación para copiar y compartir (mientras no haya mail)
  const [inviteModal, setInviteModal] = useState<{ url: string; name: string } | null>(null)
  const [modalCopied, setModalCopied] = useState(false)
  const [departments, setDepartments] = useState<{ key: string; label: string }[]>([])

  useEffect(() => {
    fetch("/api/admin/departments")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: { key: string; label: string }[]) => setDepartments(data))
      .catch(() => setDepartments([]))
  }, [])

  const departmentLabel = (key: string) =>
    departments.find((d) => d.key === key)?.label ?? key

  async function openInviteModal(url: string, name: string) {
    setInviteModal({ url, name })
    setModalCopied(false)
    try {
      await navigator.clipboard.writeText(url)
      setModalCopied(true)
    } catch {
      /* el usuario puede copiar manualmente desde el input */
    }
  }

  function startEdit(user: AdminUser) {
    setEditingId(user.id)
    setEditForm({ name: user.name, role: user.role, departments: user.departments ?? [] })
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
        setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, name: body.name, role: body.role, departments: body.departments ?? [] } : u))
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
    setSubmitting(true)
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      })
      const body = await res.json()
      if (res.ok) {
        if (body.inviteUrl) setPendingUrls((p) => ({ ...p, [body.id]: body.inviteUrl }))
        const createdName = form.name
        setForm({ name: "", email: "", role: "operator", departments: [] })
        setShowForm(false)
        const listRes = await fetch("/api/admin/usuarios")
        if (listRes.ok) setUsers(await listRes.json())
        if (body.emailSent) {
          toast({ title: "Invitación enviada", description: `Se envió un mail a ${body.email ?? "el usuario"}.`, tone: "success" })
        } else if (body.inviteUrl) {
          // Sin servidor de mail: mostramos el link para que el admin se lo pase a la persona
          await openInviteModal(body.inviteUrl, createdName)
        }
      } else {
        setFormError(body.error ?? "Error al crear usuario")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const isSuperadmin = currentRole === "superadmin"

  async function confirmDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/admin/usuarios/${deleteId}`, { method: "DELETE" })
      const body = await res.json()
      if (res.ok) {
        setUsers((prev) => prev.filter((u) => u.id !== deleteId))
        toast({ title: "Usuario eliminado", tone: "neutral" })
      } else {
        toast({ title: body.error ?? "Error al eliminar", tone: "danger" })
      }
    } finally {
      setDeleting(false)
      setDeleteId(null)
    }
  }

  return (
    <div>
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null) }}
        title="Eliminar usuario"
        description="Se eliminará la cuenta permanentemente. Esta acción no se puede deshacer."
        headerBorder={false}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDeleteId(null)}>Cancelar</Button>
            <Button variant="danger" loading={deleting} onClick={confirmDelete}>Eliminar</Button>
          </div>
        }
      >
        <p className="text-sm" style={{ color: "var(--ink)" }}>¿Estás seguro que querés eliminar este usuario?</p>
      </Dialog>

      <Dialog
        open={inviteModal !== null}
        onOpenChange={(open) => { if (!open) setInviteModal(null) }}
        title="Compartí el link de invitación"
        description={inviteModal ? `Enviale este link a ${inviteModal.name} para que cree su contraseña y acceda a su cuenta.` : undefined}
        headerBorder={false}
        footer={
          <div className="flex gap-2 justify-end">
            <Button onClick={() => setInviteModal(null)}>Listo</Button>
          </div>
        }
      >
        {inviteModal && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteModal.url} className="flex-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(inviteModal.url)
                  setModalCopied(true)
                  setTimeout(() => setModalCopied(false), 2000)
                }}
              >
                {modalCopied ? <><Check size={14} /> Copiado</> : <><Link size={14} /> Copiar</>}
              </Button>
            </div>
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              El link vence en 7 días. Podés volver a copiarlo desde la columna <strong>Estado</strong>{" "}
              mientras la invitación siga pendiente.
            </p>
          </div>
        )}
      </Dialog>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Usuarios</h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>Operadores del backoffice</p>
        </div>
        {isSuperadmin && (
          <Button onClick={() => { setShowForm((p) => !p); setFormError("") }}>
            <UserPlus size={15} strokeWidth={1.6} />
            Invitar usuario
          </Button>
        )}
      </div>

      {showForm && (
        <div
          className="mb-4 p-5 rounded-[var(--radius)]"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h2 className="text-sm font-semibold mb-4" style={{ color: "var(--ink)" }}>Invitar nuevo usuario</h2>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <Field label="Departamentos">
                <DepartmentPicker
                  options={departments}
                  value={form.departments}
                  onChange={(v) => setForm((p) => ({ ...p, departments: v }))}
                />
              </Field>
            </div>
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

<div className="rounded-[var(--radius)] overflow-x-auto" style={{ border: "1px solid var(--border)" }}>
        <table className="w-full min-w-[720px] text-sm" style={{ background: "var(--card)" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Usuario", "Departamento", "Rol", "Estado", "Alta", ""].map((h, i) => (
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

                  {/* Departamento */}
                  <td className="px-4 py-3">
                    {isEditing && isSuperadmin && !isSelf ? (
                      <DepartmentPicker
                        options={departments}
                        value={editForm.departments}
                        onChange={(v) => setEditForm((p) => ({ ...p, departments: v }))}
                      />
                    ) : user.departments.length ? (
                      <div className="flex flex-wrap gap-1">
                        {user.departments.map((key) => (
                          <span
                            key={key}
                            className="text-xs px-1.5 py-0.5 rounded"
                            style={{ background: "var(--elevated)", color: "var(--ink)" }}
                          >
                            {departmentLabel(key)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm" style={{ color: "var(--ink-faint)" }}>—</span>
                    )}
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
                    <InviteStatus
                      user={user}
                      knownUrl={pendingUrls[user.id]}
                      onResend={async () => {
                        const res = await fetch(`/api/admin/usuarios/${user.id}/resend-invite`, { method: "POST" })
                        if (!res.ok) {
                          toast({ title: "No se pudo reenviar la invitación", tone: "danger" })
                          return
                        }
                        const data = await res.json()
                        if (data.inviteUrl) setPendingUrls((p) => ({ ...p, [user.id]: data.inviteUrl }))
                        if (data.emailSent) {
                          if (data.inviteUrl) await navigator.clipboard.writeText(data.inviteUrl)
                          toast({ title: "Invitación reenviada", description: `Mail enviado a ${user.email}. Link copiado.`, tone: "success" })
                        } else if (data.inviteUrl) {
                          // Sin servidor de mail: mostramos el link nuevo para compartir
                          await openInviteModal(data.inviteUrl, user.name)
                        }
                        const listRes = await fetch("/api/admin/usuarios")
                        if (listRes.ok) setUsers(await listRes.json())
                      }}
                    />
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
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" onClick={() => startEdit(user)} title="Editar">
                            <Pencil size={13} strokeWidth={1.6} />
                          </Button>
                          {user.id !== currentUserId && (
                            <Button variant="ghost" size="icon" onClick={() => setDeleteId(user.id)} title="Eliminar">
                              <Trash2 size={13} strokeWidth={1.6} />
                            </Button>
                          )}
                        </div>
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

// Selector multi-departamento: dropdown con checkboxes (queda abierto al tildar).
// El panel se renderiza por portal en <body> para que no lo recorte el overflow de la tabla.
function DepartmentPicker({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, top: r.bottom + 4, width: r.width })
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const close = () => setOpen(false)
    document.addEventListener("mousedown", onDown)
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onDown)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [open])

  if (options.length === 0) {
    return <span className="text-xs" style={{ color: "var(--ink-faint)" }}>No hay departamentos configurados</span>
  }

  const toggle = (key: string) =>
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key])
  const selectedLabels = options.filter((o) => value.includes(o.key)).map((o) => o.label)
  const buttonLabel = selectedLabels.length ? selectedLabels.join(", ") : "Sin departamento"

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-48 flex items-center justify-between gap-2 text-sm px-3 py-2 rounded-[var(--radius)] border text-left"
        style={{ borderColor: "var(--border)", background: "var(--card)", color: selectedLabels.length ? "var(--ink)" : "var(--ink-faint)" }}
      >
        <span className="truncate">{buttonLabel}</span>
        <ChevronDown size={14} className="shrink-0" style={{ color: "var(--ink-soft)" }} />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, zIndex: 50, border: "1px solid var(--border)", background: "var(--card)" }}
          className="rounded-[var(--radius)] shadow-lg overflow-hidden py-1"
        >
          {options.map((o) => {
            const on = value.includes(o.key)
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => toggle(o.key)}
                className="w-full flex items-center gap-2 text-sm px-3 py-2 text-left transition-colors"
                style={{ background: on ? "var(--blue-soft)" : "transparent", color: "var(--ink)" }}
              >
                <span
                  className="flex items-center justify-center rounded shrink-0"
                  style={{ width: 16, height: 16, border: `1.5px solid ${on ? "var(--blue)" : "var(--border)"}`, background: on ? "var(--blue)" : "transparent" }}
                >
                  {on && <Check size={11} strokeWidth={3} style={{ color: "#fff" }} />}
                </span>
                {o.label}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

function InviteStatus({
  user,
  knownUrl,
  onResend,
}: {
  user: AdminUser
  knownUrl?: string
  onResend?: () => Promise<void>
}) {
  const [copied, setCopied] = useState(false)
  const [resending, setResending] = useState(false)

  if (user.hasPassword) {
    const acceptedAt = user.inviteAcceptedAt
      ? new Date(user.inviteAcceptedAt).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })
      : null
    return (
      <div className="inline-flex flex-col gap-0.5">
        <Badge tone="success">Activo</Badge>
        {acceptedAt && (
          <span className="text-[10px]" style={{ color: "var(--ink-faint)" }}>Aceptó el {acceptedAt}</span>
        )}
      </div>
    )
  }

  const expired = user.inviteExpiresAt && new Date(user.inviteExpiresAt) < new Date()

  async function handleCopy() {
    if (!knownUrl) return
    await navigator.clipboard.writeText(knownUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleResend() {
    if (!onResend) return
    setResending(true)
    try {
      await onResend()
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } finally {
      setResending(false)
    }
  }

  const expiresAt = user.inviteExpiresAt
    ? new Date(user.inviteExpiresAt).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })
    : null

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Badge tone={expired ? "danger" : "warning"}>
          {expired ? "Invitación vencida" : "Invitación pendiente"}
        </Badge>
        {/* Si tenemos la URL en memoria → botón copiar directo */}
        {knownUrl && !expired && (
          <button
            onClick={handleCopy}
            title={copied ? "¡Copiado!" : "Copiar link de invitación"}
            className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors"
            style={{
              color: copied ? "var(--green)" : "var(--blue)",
              background: copied ? "var(--green-soft)" : "var(--blue-soft)",
            }}
          >
            {copied ? <Check size={10} /> : <Link size={10} />}
            {copied ? "Copiado" : "Copiar link"}
          </button>
        )}
        {/* Si no tenemos URL (recargó la página) → regenerar y copiar */}
        {!knownUrl && (
          <button
            onClick={handleResend}
            disabled={resending}
            title="Regenerar y copiar link"
            className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors"
            style={{ color: "var(--ink-soft)", background: "var(--elevated)" }}
          >
            <RefreshCw size={10} className={resending ? "animate-spin" : ""} />
            {copied ? "¡Copiado!" : expired ? "Regenerar link" : "Obtener link"}
          </button>
        )}
      </div>
      {expiresAt && !expired && (
        <span className="text-[10px]" style={{ color: "var(--ink-faint)" }}>Vence el {expiresAt}</span>
      )}
    </div>
  )
}
