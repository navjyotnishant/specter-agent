import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";

export function ProtectedRoute() {
  const { isAuthenticated, isLoading, needsSetup } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f7fbff] text-slate-700">
        <div className="rounded-3xl border border-white/80 bg-white/85 p-6 shadow-sm">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-indigo-600" />
          <p className="mt-3 text-sm font-semibold">Checking local session…</p>
        </div>
      </div>
    );
  }

  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}
