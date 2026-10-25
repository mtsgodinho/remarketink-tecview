"use client";
import { useState, useEffect, useCallback } from "react";
export async function api(path: string, method = "GET", body?: unknown) {
  const form = body instanceof FormData;
  const r = await fetch("/api/" + path, {
    method,
    headers: body && !form ? { "Content-Type": "application/json" } : undefined,
    body: body ? ((form ? body : JSON.stringify(body)) as BodyInit) : undefined,
  });
  if (r.status === 401) {
    window.location.href = "/login";
    throw Error("Sessão expirada.");
  }
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Falha ao processar a solicitação.");
  return data;
}
export function useDashboard() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setData(await api("overview"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);
  return { data, error, loading, refresh };
}
