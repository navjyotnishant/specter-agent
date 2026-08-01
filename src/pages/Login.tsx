import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Login() {
  const { login, needsSetup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("admin@local.dev");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/dashboard";

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log in");
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
          <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-5xl">Welcome back to Specter Agent.</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-slate-600">Sign in to manage agent workflows, approvals, evidence, model providers, and connector policies.</p>
          {needsSetup && (
            <Alert className="mt-6 rounded-2xl border-amber-200 bg-amber-50 text-amber-950">
              <AlertDescription>No admin account exists yet. <Link to="/setup" className="font-bold underline">Bootstrap setup</Link></AlertDescription>
            </Alert>
          )}
        </section>

        <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-2xl shadow-slate-200/70 backdrop-blur-xl">
          <CardContent className="p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white"><Lock className="h-6 w-6" /></span>
              <div>
                <h2 className="text-3xl font-black">Log in</h2>
                <p className="text-slate-600">Use your Specter Agent credentials.</p>
              </div>
            </div>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" className="rounded-2xl" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" className="rounded-2xl" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={72} required />
              </div>
              {error && <Alert variant="destructive" className="rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
              <Button disabled={isSubmitting} className="w-full rounded-2xl bg-indigo-600 py-6 text-white hover:bg-indigo-700">
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Log in
              </Button>
              <p className="text-center text-sm text-slate-500">First run? <Link to="/setup" className="font-bold text-indigo-700">Create the admin account</Link></p>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
