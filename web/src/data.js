import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "./auth.jsx";
import { api, queryString, isActive, mergeEvents } from "./api.js";

export function invalidateJobs(cache, userId) {
  return cache.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "user" &&
      query.queryKey[1] === userId &&
      (["jobs", "companies"].includes(query.queryKey[2]) ||
        query.queryKey[2]?.startsWith("jobs/") ||
        query.queryKey[2]?.startsWith("companies/")),
  });
}

export function useVisible() {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
export function useResource(resource, params = {}, options = {}) {
  const { user } = useAuth();
  const visible = useVisible();
  const { interval, ...rest } = options;
  return useQuery({
    queryKey: ["user", user?.id, resource, params],
    queryFn: ({ signal }) =>
      api(`/${resource}${queryString(params)}`, { signal }),
    enabled: !!user,
    staleTime: 5000,
    refetchOnWindowFocus: true,
    refetchInterval: visible ? (interval ?? false) : false,
    refetchIntervalInBackground: false,
    ...rest,
  });
}
export function useAction() {
  const { user } = useAuth();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) =>
      api(path, { method, body }),
    retry: false,
    networkMode: "always",
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["user", user.id] });
    },
  });
}
export const isCompanySyncActive = (status) =>
  ["queued", "running"].includes(status);
export function useCompanySync() {
  const { user } = useAuth(),
    cache = useQueryClient();
  const query = useResource(
    "company-syncs/latest",
    {},
    {
      interval: (state) =>
        isCompanySyncActive(state.state.data?.status) ? 2000 : false,
    },
  );
  useEffect(() => {
    if (query.data && !isCompanySyncActive(query.data.status)) {
      invalidateJobs(cache, user.id);
    }
  }, [query.data?.id, query.data?.status, cache, user.id]);
  return query;
}
export function useLiveRuns() {
  const query = useResource(
    "runs",
    { status: "active", limit: 100 },
    { interval: 2000 },
  );
  const cache = useQueryClient();
  const { user } = useAuth();
  const previous = useRef("");
  const signature = JSON.stringify(
    query.data?.items?.map((run) => [
      run.id,
      run.status,
      run.counters.saved,
      run.counters.confirmed,
    ]),
  );
  useEffect(() => {
    if (previous.current && signature !== previous.current) {
      invalidateJobs(cache, user.id);
      cache.invalidateQueries({ queryKey: ["user", user.id, "connections"] });
    }
    previous.current = signature;
  }, [signature, cache, user.id]);
  return query;
}
export function useFilters() {
  const [params, setParams] = useSearchParams();
  function change(values) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("cursor");
      next.delete("stack");
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  }
  function next(cursor) {
    setParams((previous) => {
      const result = new URLSearchParams(previous);
      let stack;
      try {
        stack = JSON.parse(result.get("stack") ?? "[]");
      } catch {
        stack = [];
      }
      if (!Array.isArray(stack)) stack = [];
      result.set(
        "stack",
        JSON.stringify([...stack, result.get("cursor") ?? ""]),
      );
      result.set("cursor", cursor);
      return result;
    });
  }
  function back() {
    setParams((previous) => {
      const result = new URLSearchParams(previous);
      let stack;
      try {
        stack = JSON.parse(result.get("stack") ?? "[]");
      } catch {
        stack = [];
      }
      if (!Array.isArray(stack)) stack = [];
      const cursor = stack.pop();
      if (cursor) result.set("cursor", cursor);
      else result.delete("cursor");
      if (stack.length) result.set("stack", JSON.stringify(stack));
      else result.delete("stack");
      return result;
    });
  }
  return { params, change, next, back };
}
export function useRunEvents(run) {
  const { user } = useAuth(),
    visible = useVisible(),
    cache = useQueryClient();
  const queryKey = ["user", user.id, "run-events", run?.id];
  const query = useQuery({
    queryKey,
    enabled: !!run?.id,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const previous = cache.getQueryData(queryKey);
      const page = await api(
        `/runs/${run.id}/events${queryString({ after: previous?.nextCursor ?? 0, limit: 100 })}`,
        { signal },
      );
      return {
        ...page,
        events: mergeEvents(previous?.events ?? [], page.items),
      };
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: (state) =>
      !visible
        ? false
        : state.state.data?.items.length === 100
          ? 25
          : isActive(run?.status)
            ? 2000
            : false,
  });
  useEffect(() => {
    if (run && !isActive(run.status))
      cache.invalidateQueries({
        queryKey: ["user", user.id, "run-events", run.id],
      });
  }, [run?.id, run?.status, user.id, cache]);
  return { events: query.data?.events ?? [], error: query.error };
}
