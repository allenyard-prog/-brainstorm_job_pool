import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./components.jsx";
import {
  drawerKeys,
  filterDraft,
  validateDraft,
  appliedDraft,
  scoreRanges,
} from "./job-filters.js";

export default function JobFilterDrawer({
  filters,
  profiles,
  sites,
  onApply,
  onClose,
}) {
  const ref = useRef(null),
    title = useId();
  const [draft, setDraft] = useState(() => filterDraft(filters)),
    [errors, setErrors] = useState({});
  useEffect(() => {
    const opener = document.activeElement,
      dialog = ref.current;
    dialog.showModal();
    dialog.querySelector("input")?.focus();
    return () => {
      dialog.close();
      opener?.focus?.({ preventScroll: true });
    };
  }, []);
  function change(key, value) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors({});
  }
  function submit(event) {
    event.preventDefault();
    const next = validateDraft(draft);
    for (const input of event.currentTarget.querySelectorAll(
      "input[data-error-group]",
    ))
      if (input.validity.badInput)
        next[input.dataset.errorGroup] = "Enter a valid date or number.";
    setErrors(next);
    if (Object.keys(next).length) return;
    onApply(appliedDraft(draft));
  }
  function keyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = [
      ...ref.current.querySelectorAll(
        'button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),a[href],[tabindex="0"]',
      ),
    ].filter((element) => element.tabIndex >= 0 && !element.hidden);
    const first = elements[0],
      last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return (
    <dialog
      ref={ref}
      className="filter-drawer"
      aria-labelledby={title}
      onKeyDown={keyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="drawer-heading">
        <div>
          <span className="eyebrow">REFINE YOUR COLLECTION</span>
          <h2 id={title}>Job filters</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close filters"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <form className="drawer-form" onSubmit={submit} noValidate>
        <div className="drawer-body">
          <label className="drawer-field">
            Company name
            <input
              type="search"
              aria-label="Company name"
              value={draft.company}
              maxLength={200}
              placeholder="e.g. Google"
              onChange={(event) => change("company", event.target.value)}
            />
            <small>Matches any part of the stored company name.</small>
          </label>
          {draft.companyId && (
            <p className="drawer-hint">
              Also limited to company directory #{draft.companyId}.{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => change("companyId", "")}
              >
                Remove directory filter
              </button>
            </p>
          )}
          {[
            [
              "posted",
              "Posted date",
              "Uses the calendar date provided by the job website.",
            ],
            [
              "registered",
              "Registered date",
              "When first saved to this database. Dates use your local time zone.",
            ],
          ].map(([key, label, hint]) => (
            <fieldset className="drawer-group" key={key}>
              <legend>{label}</legend>
              <div className="drawer-range">
                {[
                  ["From", "from"],
                  ["To", "to"],
                ].map(([suffix, word]) => (
                  <label key={suffix}>
                    {suffix}
                    <input
                      type="date"
                      data-error-group={key}
                      aria-label={`${label.split(" ")[0]} ${word}`}
                      value={draft[key + suffix]}
                      aria-invalid={!!errors[key]}
                      aria-describedby={
                        errors[key] ? `${title}-${key}` : undefined
                      }
                      onChange={(event) =>
                        change(key + suffix, event.target.value)
                      }
                    />
                  </label>
                ))}
              </div>
              <small>{hint}</small>
              {errors[key] && (
                <p className="drawer-error" id={`${title}-${key}`} role="alert">
                  {errors[key]}
                </p>
              )}
            </fieldset>
          ))}
          <div className="drawer-section-label">
            MATCH SCORES <span>0–100%</span>
          </div>
          {scoreRanges.map(([key, label]) => (
            <fieldset className="drawer-group" key={key}>
              <legend>{label}</legend>
              <div className="drawer-range">
                {[
                  ["Min", "Minimum"],
                  ["Max", "Maximum"],
                ].map(([suffix, word]) => (
                  <label key={suffix}>
                    {word}
                    <div className="score-input">
                      <input
                        type="number"
                        data-error-group={key}
                        min="0"
                        max="100"
                        step="any"
                        inputMode="decimal"
                        aria-label={`${label} ${word.toLowerCase()}`}
                        value={draft[key + suffix]}
                        placeholder={suffix === "Min" ? "0" : "100"}
                        aria-invalid={!!errors[key]}
                        aria-describedby={
                          errors[key] ? `${title}-${key}` : undefined
                        }
                        onChange={(event) =>
                          change(key + suffix, event.target.value)
                        }
                      />
                      <span>%</span>
                    </div>
                  </label>
                ))}
              </div>
              {errors[key] && (
                <p className="drawer-error" id={`${title}-${key}`} role="alert">
                  {errors[key]}
                </p>
              )}
            </fieldset>
          ))}
          <p className="drawer-hint">
            An active date or score range excludes jobs whose value is unknown.
          </p>
          <div className="drawer-blacklist">
            <label>
              <input
                type="checkbox"
                checked={draft.excludeBlacklistedCompanies === "true"}
                onChange={(event) =>
                  change(
                    "excludeBlacklistedCompanies",
                    event.target.checked ? "true" : "",
                  )
                }
                aria-describedby={`${title}-blacklist-help`}
              />
              Exclude blacklisted companies
            </label>
            <p id={`${title}-blacklist-help`}>
              Only linked jobs are excluded. Run Sync companies to include newly
              collected jobs in company filtering.
            </p>
          </div>
          <label className="drawer-field">
            Profile
            <select
              aria-label="Profile"
              value={draft.connectionId}
              onChange={(event) => change("connectionId", event.target.value)}
            >
              <option value="">All profiles</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </label>
          <label className="drawer-field">
            Job site
            <select
              aria-label="Job site"
              value={draft.site}
              onChange={(event) => change("site", event.target.value)}
            >
              <option value="">All sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
          <label className="drawer-field">
            Tracking status
            <select
              aria-label="Tracking status"
              value={draft.status}
              onChange={(event) => change("status", event.target.value)}
            >
              <option value="">All tracking</option>
              <option value="available">Available (unassigned)</option>
              <option value="assigned">Assigned</option>
              <option value="saved">Saved</option>
              <option value="mark_pending">Update unconfirmed</option>
              <option value="mark_confirmed">Marked applied</option>
            </select>
          </label>
          {(draft.collectedFrom || draft.collectedTo) && (
            <p className="drawer-hint">
              A legacy last-refreshed range is also active.{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  change("collectedFrom", "");
                  change("collectedTo", "");
                }}
              >
                Remove last-refreshed filter
              </button>
            </p>
          )}
        </div>
        <div className="drawer-footer">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft(Object.fromEntries(drawerKeys.map((key) => [key, ""])));
              setErrors({});
            }}
          >
            Reset
          </button>
          <button type="button" className="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Apply filters
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
