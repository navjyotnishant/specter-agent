// Author: Navjyot Nishant
// Created: 2026-06-19
// Last updated: 2026-08-02
// Description: Account settings and local user administration.
//
// Two tabs, per the design: "My account" (your own credentials and password)
// and "Users & roles" (everyone on this instance). Personal credentials used to
// sit wedged between the create-user form and the account list, under an
// org-admin heading — which split admin work in half and buried your own
// settings inside somebody else's.

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getStoredToken, useAuth } from "@/lib/auth";
import { TelegramConfigForm } from "@/components/agents/TelegramConfigForm";
import { api } from "@/lib/api";
import type { AuthUser } from "@/lib/types";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Timestamps arrive as SQLite `YYYY-MM-DD HH:MM:SS` (UTC, no zone marker) or
 *  as ISO with an offset. Appending "Z" to the latter yields an invalid date, so
 *  normalise rather than assuming one shape. */
function parseUTC(value: string) {
  return new Date(value.endsWith("Z") || value.includes("+") ? value : `${value.replace(" ", "T")}Z`);
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  return parseUTC(value).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

/** "now" / "2d ago". A null last-seen means the account has not signed in since
 *  tracking shipped — unknown, not never. Saying "never" would accuse a live
 *  account of being abandoned. */
function formatLastSeen(value?: string | null) {
  if (!value) return "unknown";
  const seconds = Math.floor((Date.now() - parseUTC(value).getTime()) / 1000);
  if (seconds < 120) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function Users() {
  const { user } = useAuth();
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "operator">("operator");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => api.users(token ?? ""),
    enabled: Boolean(token),
    retry: false,
  });
  // No fallback to [user]: a failed fetch rendering "just you" is indistinguishable
  // from a one-user system, so an admin whose request 403'd concludes the other
  // accounts were deleted.
  const accounts = usersQuery.data ?? [];
  const isAdmin = user?.role === "admin";

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });
  const fail = (fallback: string) => (err: unknown) =>
    setError(err instanceof Error ? err.message : fallback);

  const create = useMutation({
    mutationFn: () => api.createUser(token ?? "", email, password, role),
    onSuccess: () => {
      setEmail(""); setPassword(""); setRole("operator"); setError(""); invalidate();
    },
    onError: fail("Unable to create user"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteUser(token ?? "", id),
    // Without this a refused delete (last admin, FK constraint, 403) left the row
    // in place with no message, reading as a UI bug.
    onSuccess: () => { setError(""); invalidate(); },
    onError: fail("Unable to delete user"),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, next }: { id: string; next: "admin" | "operator" }) =>
      api.changeUserRole(token ?? "", id, next),
    onSuccess: (updated) => {
      setError("");
      setNotice(`${updated.email} is now ${updated.role}.`);
      invalidate();
    },
    onError: fail("Unable to change role"),
  });

  const resetPassword = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) =>
      api.resetUserPassword(token ?? "", id, next),
    onSuccess: () => {
      setError("");
      setNotice("Password reset. Their existing sessions were signed out.");
    },
    onError: fail("Unable to reset password"),
  });

  const changeOwnPassword = useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) =>
      api.changeOwnPassword(token ?? "", current, next),
    onSuccess: () => { setError(""); setNotice("Your password has been changed."); },
    onError: fail("Unable to change password"),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    create.mutate();
  };

  return (
    <div className="space-y-4">
      {/* Outside the admin gate: an error must reach every viewer, not only the
          people who can act on it. */}
      {error && (
        <Alert variant="destructive" className="rounded-[8px]">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && !error && (
        <Alert className="rounded-[8px] border-emerald-200 bg-emerald-50">
          <AlertDescription className="text-emerald-900">{notice}</AlertDescription>
        </Alert>
      )}

      <div className="sp-frame">
        <div className="sp-hdr">
          <h1>Account</h1>
          <p>{user?.email ?? "Not signed in"}</p>
        </div>

        <Tabs defaultValue="account">
          <TabsList className="sp-tabs sp-tabs-lg h-auto justify-start rounded-none bg-transparent p-0">
            <TabsTrigger value="account" className="sp-tb rounded-none">My account</TabsTrigger>
            <TabsTrigger value="users" className="sp-tb rounded-none">Users &amp; roles</TabsTrigger>
          </TabsList>

          {/* ── My account ── */}
          <TabsContent value="account" className="mt-0">
            <div className="sp-sec sp-sec-lg">
              <h2>My integrations</h2>
              <div className="sp-sub">
                Credentials stored against your account, shared by every workflow you run.
                Encrypted at rest.
              </div>
              {token
                ? <TelegramConfigForm variant="page" />
                : <p className="text-sm text-slate-500">Sign in to manage your integrations.</p>}
            </div>

            <div className="sp-sec sp-sec-lg">
              <h2>Password</h2>
              <div className="sp-sub">Change your own sign-in password.</div>
              <ChangeOwnPassword
                pending={changeOwnPassword.isPending}
                onSubmit={(current, next) => changeOwnPassword.mutate({ current, next })}
              />
            </div>
          </TabsContent>

          {/* ── Users & roles ── */}
          <TabsContent value="users" className="mt-0">
            <div className="sp-sec sp-sec-lg">
              {usersQuery.isLoading && <p className="text-sm text-slate-500">Loading accounts…</p>}
              {usersQuery.isError && (
                <p className="text-sm text-red-600">
                  Could not load the account list — this is an error, not an empty instance.{" "}
                  {usersQuery.error instanceof Error ? usersQuery.error.message : ""}
                </p>
              )}

              {!usersQuery.isLoading && !usersQuery.isError && (
                <table className="sp-table w-full">
                  <thead>
                    <tr><th>Account</th><th>Role</th><th>Created</th><th>Last seen</th><th /></tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        isSelf={account.id === user?.id}
                        isAdmin={isAdmin}
                        busy={changeRole.isPending || resetPassword.isPending || remove.isPending}
                        onChangeRole={(next) => changeRole.mutate({ id: account.id, next })}
                        onResetPassword={(next) => resetPassword.mutate({ id: account.id, next })}
                        onDelete={() => remove.mutate(account.id)}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="sp-sec sp-sec-lg">
              <h2>Add a user</h2>
              <div className="sp-sub">Admins can create operators or additional admins.</div>

              {/* Gated on role, not merely labelled. The form and the Delete
                  buttons used to render for operators too, who filled them in
                  and got a raw backend error — while the copy right above them
                  already said "Admins can create…". */}
              {!isAdmin ? (
                <div className="sp-gate">Visible to admins only — operators do not see this form.</div>
              ) : !token ? (
                <p className="text-sm text-slate-500">Sign in to manage users.</p>
              ) : (
                <form onSubmit={onSubmit} className="grid gap-3 lg:grid-cols-[1fr_1fr_170px_auto] lg:items-end">
                  <div className="space-y-1.5">
                    <Label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Email</Label>
                    <Input type="email" className="rounded-[6px]" value={email}
                      onChange={(e) => setEmail(e.target.value)} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Password</Label>
                    <Input type="password" className="rounded-[6px]" value={password}
                      onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={72} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Role</Label>
                    <Select value={role} onValueChange={(v: "admin" | "operator") => setRole(v)}>
                      <SelectTrigger className="rounded-[6px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="operator">Operator</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <button type="submit" className="sp-btn sp-btn-compact sp-btn-primary" disabled={create.isPending}>
                    {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Create user
                  </button>
                </form>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/** One account row.
 *
 *  Delete confirms — it is the highest-risk interaction in the app. Change role
 *  and reset password confirm for the same reason: both are silent from the
 *  other person's side until they try to sign in. */
function AccountRow({
  account, isSelf, isAdmin, busy, onChangeRole, onResetPassword, onDelete,
}: {
  account: AuthUser;
  isSelf: boolean;
  isAdmin: boolean;
  busy: boolean;
  onChangeRole: (next: "admin" | "operator") => void;
  onResetPassword: (next: string) => void;
  onDelete: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const nextRole: "admin" | "operator" = account.role === "admin" ? "operator" : "admin";

  return (
    <tr>
      <td>
        {account.email}{" "}
        {isSelf && <span className="sp-badge sp-badge-you">you</span>}
      </td>
      <td>
        <span className={`sp-badge ${account.role === "admin" ? "sp-badge-adm" : "sp-badge-opr"}`}>
          {account.role}
        </span>
      </td>
      <td>{formatDate(account.created_at)}</td>
      <td>{formatLastSeen(account.last_seen_at)}</td>
      <td>
        <div className="sp-ra">
          {/* Your own account: no self-delete and no self-demote. Both would
              lock you out of the page you are standing on. */}
          {isAdmin && !isSelf && (
            <>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button type="button" className="sp-btn sp-btn-sm" disabled={busy}>Change role</button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-[10px]">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Make {account.email} {nextRole}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {nextRole === "admin"
                        ? "Admins can create and delete accounts, and approve repositories for agent access."
                        : "Operators cannot manage accounts or approve repositories."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="rounded-[6px]">Cancel</AlertDialogCancel>
                    <AlertDialogAction className="rounded-[6px] bg-slate-900 hover:bg-slate-800"
                      onClick={() => onChangeRole(nextRole)}>
                      Change to {nextRole}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button type="button" className="sp-btn sp-btn-sm" disabled={busy}>Reset password</button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-[10px]">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Reset the password for {account.email}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      They will be signed out everywhere and will need this new password to
                      sign back in. Give it to them over a channel you trust.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <Input
                    type="password" className="rounded-[6px]" placeholder="New password (8+ characters)"
                    minLength={8} maxLength={72}
                    value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <AlertDialogFooter>
                    <AlertDialogCancel className="rounded-[6px]" onClick={() => setNewPassword("")}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="rounded-[6px] bg-slate-900 hover:bg-slate-800"
                      disabled={newPassword.length < 8}
                      onClick={() => { onResetPassword(newPassword); setNewPassword(""); }}
                    >
                      Reset password
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button type="button" className="sp-btn sp-btn-sm sp-btn-danger" disabled={busy}>
                    Delete…
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-[10px]">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {account.email}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes the {account.role} account and any integration
                      credentials stored against it. It cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="rounded-[6px]">Cancel</AlertDialogCancel>
                    <AlertDialogAction className="rounded-[6px] bg-red-600 hover:bg-red-700" onClick={onDelete}>
                      Delete account
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
          {isSelf && (
            <button type="button" className="sp-btn sp-btn-sm" disabled style={{ opacity: 0.35 }}>
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Self-service password change.
 *
 *  Requires the current password: a stolen session token should not be enough to
 *  take the account over permanently. */
function ChangeOwnPassword({ pending, onSubmit }: {
  pending: boolean;
  onSubmit: (current: string, next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const reset = () => { setCurrent(""); setNext(""); setConfirm(""); };
  const mismatch = next.length > 0 && confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= 8 && next === confirm;

  if (!open) {
    return (
      <button type="button" className="sp-btn sp-btn-compact" onClick={() => setOpen(true)}>
        Change password…
      </button>
    );
  }

  return (
    <form
      className="grid max-w-2xl gap-3 sm:grid-cols-3"
      onSubmit={(e) => { e.preventDefault(); onSubmit(current, next); reset(); setOpen(false); }}
    >
      <div className="space-y-1.5">
        <Label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Current</Label>
        <Input type="password" className="rounded-[6px]" value={current}
          onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">New</Label>
        <Input type="password" className="rounded-[6px]" value={next}
          onChange={(e) => setNext(e.target.value)} minLength={8} maxLength={72} required />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Confirm</Label>
        <Input type="password" className="rounded-[6px]" value={confirm}
          onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      <div className="flex items-center gap-2 sm:col-span-3">
        <button type="submit" className="sp-btn sp-btn-compact sp-btn-primary" disabled={!ready || pending}>
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Change password
        </button>
        <button type="button" className="sp-btn sp-btn-compact" onClick={() => { setOpen(false); reset(); }}>
          Cancel
        </button>
        {mismatch && <span className="text-xs text-red-600">The new passwords do not match.</span>}
      </div>
    </form>
  );
}
