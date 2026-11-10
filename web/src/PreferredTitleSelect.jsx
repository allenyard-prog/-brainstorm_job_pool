import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth.jsx";
import { api } from "./api.js";
import { invalidateJobs } from "./data.js";
import { ErrorNotice } from "./components.jsx";

export default function PreferredTitleSelect({ job, profile }) {
  const { user } = useAuth(),
    cache = useQueryClient();
  const action = useMutation({
    mutationFn: (preferredTitleId) =>
      api(`/jobs/${job.id}`, {
        method: "PATCH",
        body: { preferredTitleId: preferredTitleId || null },
      }),
    retry: false,
    networkMode: "always",
    onSuccess: (confirmed) => {
      cache.setQueriesData(
        {
          predicate: (query) =>
            query.queryKey[0] === "user" &&
            query.queryKey[1] === user.id &&
            (query.queryKey[2] === "jobs" ||
              query.queryKey[2] === `jobs/${job.id}`),
        },
        (data) =>
          !data
            ? data
            : data.items
              ? {
                  ...data,
                  items: data.items.map((item) =>
                    item.id === job.id ? { ...item, ...confirmed } : item,
                  ),
                }
              : { ...data, ...confirmed },
      );
      return invalidateJobs(cache, user.id);
    },
    onError: () => {
      void cache.invalidateQueries({
        queryKey: ["user", user.id, "connections"],
      });
    },
  });
  const archived =
    job.preferredTitleArchived ||
    profile?.titles?.some(
      (title) => title.id === job.preferredTitleId && title.isArchived,
    );
  const choices = (profile?.titles ?? []).filter(
    (title) =>
      !title.isArchived && !(archived && title.id === job.preferredTitleId),
  );
  const retained =
    job.preferredTitleId &&
    !choices.some((title) => title.id === job.preferredTitleId);
  return (
    <div className="preferred-title-control">
      <select
        aria-label={`Preferred title for ${job.title}`}
        value={job.preferredTitleId ?? ""}
        disabled={action.isPending || !profile}
        onChange={(event) => action.mutate(event.target.value)}
      >
        <option value="">No title selected</option>
        {retained && (
          <option value={job.preferredTitleId} disabled={archived}>
            {job.preferredTitle}
            {archived ? " (archived)" : ""}
          </option>
        )}
        {choices.map((title) => (
          <option key={title.id} value={title.id}>
            {title.title}
          </option>
        ))}
      </select>
      {action.isPending && <small role="status">Saving preferred title…</small>}
      {profile && !choices.length && (
        <small>
          <Link to="/profiles">Manage specializations on Profiles</Link>
        </small>
      )}
      <ErrorNotice error={action.error} />
    </div>
  );
}
