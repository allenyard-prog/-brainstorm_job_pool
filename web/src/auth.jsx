import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
export function AuthProvider({ children }) {
  const cache = useQueryClient();
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(null),
    [expired, setExpired] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const generation = useRef(0),
    currentUser = useRef(null),
    channel = useRef(null);
  const clear = useCallback(() => {
    cache.cancelQueries();
    cache.clear();
    currentUser.current = null;
    setUser(null);
  }, [cache]);
  const refresh = useCallback(
    async (hide = true) => {
      const attempt = ++generation.current;
      if (hide) {
        clear();
        setLoading(true);
      }
      setError(null);
      try {
        const next = await api("/auth/me", { publicRequest: true });
        if (attempt !== generation.current) return;
        if (currentUser.current?.id !== next.id) {
          cache.cancelQueries();
          cache.clear();
        }
        currentUser.current = next;
        setUser(next);
      } catch (failure) {
        if (attempt !== generation.current) return;
        if (failure.status === 401) {
          if (currentUser.current) {
            setExpired(true);
            setSignedOut(false);
          }
          clear();
        } else setError(failure);
      } finally {
        if (attempt === generation.current) setLoading(false);
      }
    },
    [cache, clear],
  );
  useEffect(() => {
    refresh();
    const expire = () => {
      ++generation.current;
      clear();
      setExpired(true);
      setSignedOut(false);
      setLoading(false);
    };
    const focus = () => refresh(false);
    window.addEventListener("gather:session-expired", expire);
    window.addEventListener("focus", focus);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("gather-session");
      channel.current.onmessage = (event) => {
        if (event.data === "logout") setSignedOut(true);
        refresh(true);
      };
    }
    return () => {
      ++generation.current;
      window.removeEventListener("gather:session-expired", expire);
      window.removeEventListener("focus", focus);
      channel.current?.close();
    };
  }, [refresh, clear]);
  async function login(email, password) {
    const next = await api("/auth/login", {
      method: "POST",
      body: { email, password },
      publicRequest: true,
    });
    ++generation.current;
    clear();
    currentUser.current = next;
    setUser(next);
    setLoading(false);
    setExpired(false);
    setError(null);
    channel.current?.postMessage("changed");
  }
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST", publicRequest: true });
    } catch (failure) {
      if (failure.status !== 401) throw failure;
    }
    ++generation.current;
    setSignedOut(true);
    clear();
    setExpired(false);
    setLoading(false);
    setError(null);
    channel.current?.postMessage("logout");
  }
  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        expired,
        signedOut,
        login,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
