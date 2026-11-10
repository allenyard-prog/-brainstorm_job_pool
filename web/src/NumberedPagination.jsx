import { useEffect, useId, useState } from "react";
import { listPageSizes } from "./data.js";
import { Pagination } from "./components.jsx";

function pageNumbers(page, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const values = [
    ...new Set([
      1,
      total,
      ...Array.from({ length: 5 }, (_, i) => page - 2 + i),
    ]),
  ]
    .filter((value) => value >= 1 && value <= total)
    .sort((a, b) => a - b);
  return values.flatMap((value, i) =>
    i && value - values[i - 1] > 1 ? [null, value] : [value],
  );
}

export default function NumberedPagination({
  data,
  pagination,
  filters,
  busy,
  placeholder,
  label,
}) {
  const id = useId();
  const [jump, setJump] = useState(String(data?.page ?? 1));
  useEffect(() => {
    setJump(String(data?.page ?? 1));
  }, [data?.page, data?.pageSize, data?.totalPages]);
  useEffect(() => {
    if (
      !busy &&
      !placeholder &&
      data?.page &&
      data.page !== pagination.page &&
      data.pageSize === pagination.pageSize
    )
      pagination.goTo(data.page, { replace: true });
  }, [
    busy,
    placeholder,
    data?.page,
    data?.pageSize,
    pagination.page,
    pagination.pageSize,
    pagination.goTo,
  ]);
  if (!data) return null;
  // Older resource responses retain their existing cursor controls.
  if (!Number.isSafeInteger(data.total))
    return (
      <Pagination filters={filters} nextCursor={data.nextCursor} busy={busy} />
    );
  const { page, pageSize, total, totalPages } = data;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = total ? Math.min(start + data.items.length - 1, total) : 0;
  function submit(event) {
    event.preventDefault();
    const value = Number(jump);
    if (Number.isSafeInteger(value) && value >= 1 && value <= totalPages)
      pagination.goTo(value);
  }
  return (
    <nav
      className="numbered-pagination"
      aria-label={`${label} pagination`}
      aria-busy={busy}
    >
      <div className="pagination-summary" aria-live="polite">
        <span>
          Showing {start.toLocaleString()}–{end.toLocaleString()} of{" "}
          {total.toLocaleString()} {label.toLowerCase()}
        </span>
        <small>
          Page {page.toLocaleString()} of {totalPages.toLocaleString()}
        </small>
      </div>
      <label className="page-size-control">
        Rows per page
        <select
          aria-label="Rows per page"
          value={pagination.pageSize}
          disabled={busy}
          onChange={(event) => pagination.resize(event.target.value)}
        >
          {listPageSizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="page-number-controls">
        <button
          type="button"
          className="button subtle small"
          onClick={() => pagination.goTo(page - 1)}
          disabled={busy || page === 1}
        >
          Previous
        </button>
        {pageNumbers(page, totalPages).map((value, index) =>
          value === null ? (
            <span
              className="page-ellipsis"
              key={`gap-${index}`}
              aria-hidden="true"
            >
              …
            </span>
          ) : (
            <button
              type="button"
              key={value}
              className="button subtle small page-number"
              aria-label={`Page ${value}`}
              aria-current={value === page ? "page" : undefined}
              disabled={busy}
              onClick={() => {
                if (value !== page) pagination.goTo(value);
              }}
            >
              {value.toLocaleString()}
            </button>
          ),
        )}
        <button
          type="button"
          className="button subtle small"
          onClick={() => pagination.goTo(page + 1)}
          disabled={busy || page === totalPages}
        >
          Next
        </button>
      </div>
      <form className="page-jump-control" onSubmit={submit}>
        <label htmlFor={id}>Go to page</label>
        <input
          id={id}
          aria-label="Go to page"
          type="number"
          min="1"
          max={totalPages}
          step="1"
          required
          value={jump}
          disabled={busy || totalPages === 1}
          onChange={(event) => setJump(event.target.value)}
        />
        <button
          className="button subtle small"
          disabled={busy || totalPages === 1}
        >
          Go
        </button>
      </form>
    </nav>
  );
}
