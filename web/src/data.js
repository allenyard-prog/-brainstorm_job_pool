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
  const { interval, keepPrevious = false, ...rest } = options;
  return useQuery({
    queryKey: ["user", user?.id, resource, params],
    queryFn: ({ signal }) =>
      api(`/${resource}${queryString(params)}`, { signal }),
    enabled: !!user,
    ...(keepPrevious
      ? {
          placeholderData: (previous, query) =>
            query?.queryKey[1] === user?.id && query?.queryKey[2] === resource
              ? previous
              : undefined,
        }
      : {}),
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
      next.delete("page");
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
  function setPage(page, { replace = false, pageSize } = {}) {
    setParams(
      (previous) => {
        const result = new URLSearchParams(previous);
        result.delete("cursor");
        result.delete("stack");
        if (page > 1) result.set("page", String(page));
        else result.delete("page");
        if (pageSize !== undefined) {
          if (pageSize === 20) result.delete("pageSize");
          else result.set("pageSize", String(pageSize));
        }
        return result;
      },
      { replace },
    );
  }
  return { params, change, next, back, setPage };
}
export const listPageSizes = [10, 20, 50, 100];
export function useListPagination(filters) {
  const rawPage = filters.params.get("page"),
    rawSize = filters.params.get("pageSize");
  const page =
    Number.isSafeInteger(Number(rawPage)) &&
    Number(rawPage) >= 1 &&
    Number(rawPage) <= 1000000
      ? Number(rawPage)
      : 1;
  const pageSize = listPageSizes.includes(Number(rawSize))
    ? Number(rawSize)
    : 20;
  // Legacy UI cursor bookmarks open page one; cursor API clients remain supported.
  useEffect(() => {
    if (
      filters.params.has("cursor") ||
      filters.params.has("stack") ||
      (rawPage !== null && Number(rawPage) !== page) ||
      (rawSize !== null && Number(rawSize) !== pageSize)
    ) {
      filters.setPage(page, { replace: true, pageSize });
    }
  }, [filters.params.toString(), page, pageSize]);
  return {
    page,
    pageSize,
    request: { page, limit: pageSize },
    goTo: (value, options) => filters.setPage(value, options),
    resize: (value) => filters.setPage(1, { pageSize: Number(value) }),
  };
}
export function useSorting(filters) {
  const sortBy = filters.params.get("sortBy") ?? "id";
  const sortOrder = filters.params.get("sortOrder") ?? "desc";
  return {
    sortBy,
    sortOrder,
    params: Object.fromEntries(
      ["sortBy", "sortOrder"].flatMap((key) =>
        filters.params.has(key) ? [[key, filters.params.get(key)]] : [],
      ),
    ),
    toggle(key) {
      filters.change({
        sortBy: key,
        sortOrder: sortBy === key && sortOrder === "asc" ? "desc" : "asc",
      });
    },
  };
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
