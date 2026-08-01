import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { KeyRound, Loader2, ShieldCheck, UserCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Setup() {
  const { bootstrap } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@local.dev");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await bootstrap(email, password);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to bootstrap admin account");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f7fbff] px-4 py-8 text-slate-950">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-10 h-80 w-80 rounded-full bg-cyan-200/60 blur-3xl" />
        <div className="absolute right-0 top-36 h-96 w-96 rounded-full bg-indigo-200/60 blur-3xl" />
      </div>
      <div className="relative mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 lg:grid-cols-[0.95fr_1.05fr]">
        <section>
          <div className="mb-8 inline-flex items-center gap-3 rounded-3xl border border-white/80 bg-white/80 p-3 shadow-sm backdrop-blur-xl">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-cyan-300"><ShieldCheck className="h-6 w-6" /></span>
            <span className="font-black">Specter Agent</span>
          </div>
          <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-5xl">Create your Specter Agent administrator.</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-slate-600">Set up the first administrator account for governed workflows, approvals, and agent operations.</p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <div className="rounded-3xl border border-cyan-100 bg-cyan-50 p-4">
              <UserCheck className="mb-3 h-6 w-6 text-cyan-700" />
              <h3 className="font-black">Role-based access</h3>
              <p className="mt-1 text-sm text-slate-600">Administrators manage users, workflows, providers, and operational controls.</p>
            </div>
            <div className="rounded-3xl border border-indigo-100 bg-indigo-50 p-4">
              <KeyRound className="mb-3 h-6 w-6 text-indigo-700" />
              <h3 className="font-black">Secure sign-in</h3>
              <p className="mt-1 text-sm text-slate-600">Access is protected with administrator-controlled user accounts.</p>
            </div>
          </div>
        </section>

        <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-2xl shadow-slate-200/70 backdrop-blur-xl">
          <CardContent className="p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="text-3xl font-black">Create administrator</h2>
              <p className="mt-2 text-slate-600">Use at least 8 characters for the password.</p>
            </div>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Admin email</Label>
                <Input id="email" type="email" className="rounded-2xl" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" className="rounded-2xl" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={72} required />
              </div>
              {error && <Alert variant="destructive" className="rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
              <Button disabled={isSubmitting} className="w-full rounded-2xl bg-indigo-600 py-6 text-white hover:bg-indigo-700">
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create admin and continue
              </Button>
              <p className="text-center text-sm text-slate-500">Already configured? <Link to="/login" className="font-bold text-indigo-700">Log in</Link></p>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
