import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Shield, Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { getStoredToken, useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Users() {
  const { user } = useAuth();
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "operator">("operator");
  const [error, setError] = useState("");

  const { data = [] } = useQuery({ queryKey: ["users"], queryFn: () => api.users(token ?? ""), enabled: Boolean(token && token !== "preview-mode"), retry: false });
  const accounts = data.length ? data : user ? [user] : [];

  const create = useMutation({
    mutationFn: () => api.createUser(token ?? "", email, password, role),
    onSuccess: () => {
      setEmail("");
      setPassword("");
      setRole("operator");
      setError("");
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to create user"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteUser(token ?? "", id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    create.mutate();
  };

  return (
    <div className="space-y-6">
      <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex items-center gap-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-600 text-white">
              <UsersIcon className="h-8 w-8" />
            </span>
            <div>
              <Badge className="mb-2 rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">Local accounts</Badge>
              <h2 className="text-3xl font-black text-slate-950">Users and roles</h2>
              <p className="mt-2 text-slate-600">Manage administrator and operator access for Specter Agent.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-[2rem] border-white/80 bg-white/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><UserPlus className="h-5 w-5" /></span>
            <div>
              <h3 className="text-xl font-black text-slate-950">Create local user</h3>
              <p className="text-sm text-slate-600">Admins can create operators or additional admins.</p>
            </div>
          </div>
          <form onSubmit={onSubmit} className="grid gap-3 lg:grid-cols-[1fr_1fr_180px_auto] lg:items-end">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" className="rounded-2xl" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input type="password" className="rounded-2xl" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={72} required />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={(value: "admin" | "operator") => setRole(value)}>
                <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="operator">Operator</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button disabled={create.isPending || token === "preview-mode"} className="rounded-2xl bg-indigo-600 hover:bg-indigo-700">
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create
            </Button>
          </form>
          {token === "preview-mode" && <p className="mt-3 text-sm text-slate-500">User creation is available when the service is connected.</p>}
          {error && <Alert variant="destructive" className="mt-4 rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {accounts.map((account) => (
          <Card key={account.id} className="rounded-3xl border-white/80 bg-white/80">
            <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800">
                  <Shield className="h-6 w-6" />
                </span>
                <div>
                  <h3 className="font-black text-slate-950">{account.email}</h3>
                  <div className="mt-1 flex gap-2">
                    <Badge variant="outline" className="rounded-full bg-white">{account.role}</Badge>
                    {account.id === user?.id && <Badge className="rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-100">You</Badge>}
                  </div>
                </div>
              </div>
              <Button disabled={account.id === user?.id || remove.isPending || token === "preview-mode"} onClick={() => remove.mutate(account.id)} variant="outline" className="rounded-2xl border-red-200 bg-white text-red-700 hover:bg-red-50">
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
