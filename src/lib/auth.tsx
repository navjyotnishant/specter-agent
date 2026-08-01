import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { AuthUser } from "./types";

const TOKEN_KEY = "sdlc_auth_token";
const USER_KEY = "sdlc_auth_user";

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsSetup: boolean;
  login: (email: string, password: string) => Promise<void>;
  bootstrap: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredUser(): AuthUser | null {
  const value = localStorage.getItem(USER_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as AuthUser;
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());
  const [needsSetup, setNeedsSetup] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const storeSession = (nextToken: string, nextUser: AuthUser) => {
    localStorage.setItem(TOKEN_KEY, nextToken);
    localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
    setNeedsSetup(false);
  };

  const clearSession = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  };

  const refresh = async () => {
    setIsLoading(true);
    try {
      const status = await api.authStatus();
      setNeedsSetup(status.needs_setup);
      const storedToken = localStorage.getItem(TOKEN_KEY);
      if (storedToken && !status.needs_setup) {
        const response = await api.me(storedToken);
        localStorage.setItem(USER_KEY, JSON.stringify(response.user));
        setUser(response.user);
        setToken(storedToken);
      }
    } catch {
      // The backend is unreachable or the stored token is no longer valid. Drop
      // the session rather than inventing one -- a fake signed-in state makes
      // every backend-gated feature report a confident false negative.
      setNeedsSetup(false);
      clearSession();
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    token,
    isLoading,
    isAuthenticated: Boolean(user && token),
    needsSetup,
    login: async (email: string, password: string) => {
      const response = await api.login(email, password);
      storeSession(response.token, response.user);
    },
    bootstrap: async (email: string, password: string) => {
      await api.bootstrap(email, password);
      const response = await api.login(email, password);
      storeSession(response.token, response.user);
    },
    logout: async () => {
      const currentToken = localStorage.getItem(TOKEN_KEY);
      clearSession();
      if (currentToken) await api.logout(currentToken);
    },

    refresh,
  }), [user, token, isLoading, needsSetup]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}
