# Project documentation

This project collects job information through website plugins, stores it in SQLite, and provides a private React workspace for managing accounts and background runs. Jobright currently supports browser and API transports. Marking a job **Already applied** changes the website's tracking status; it does not submit an employer application.

## Reading guide

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Components, process boundaries, execution flow, authentication, and deployment |
| [Common patterns](common-patterns.md) | Conventions for backend features, workers, storage, frontend state, and testing |
| [Data model](data-model.md) | Ownership, tables, JSON details, lifecycle states, and migrations |
| [Company directory](companies.md) | Company identity, manual synchronization, progress, linked jobs, and APIs |
| [Profile specializations](profile-specializations.md) | Person names, role labels, archiving, manual job preferences, filters, and APIs |
| [Advanced job filters](job-filters.md) | Drawer controls, date/score semantics, shared APIs, and derived search fields |
| [Website plugins](website-plugins.md) | Plugin contract, browser-to-API discovery, and adding another website |
| [Jobright browser-to-API skill](../skills/jobright-browser-to-api/SKILL.md) | Reusable Codex workflow for browser discovery, captured request contracts, API implementation, and parity checks |
| [Backend and dashboard guide](backend.md) | Setup commands, API endpoints, dashboard usage, configuration, and operations |

Start with architecture when joining the project, then use common patterns while making changes. The backend guide is the operational reference. The [root README](../README.md) includes CLI commands and observed Jobright endpoints.

## Development commands

Run these from the repository root on Windows:

```powershell
# First-time dependency/runtime setup
.\setup.cmd

# Initialize a backend administrator interactively
.\npm.cmd run service:init -- --import-legacy

# Production dashboard and API: http://127.0.0.1:3000
.\npm.cmd run web:build
.\npm.cmd run service

# Development dashboard: http://127.0.0.1:5173
# Keep the backend running in another terminal.
.\npm.cmd run web:dev
```

Legacy import is optional; see the [backend guide](backend.md#initialize-and-run) before choosing it. Backend login credentials and connected job-site credentials are separate.

```powershell
# Core, storage, plugin, and backend regression tests
.\npm.cmd test

# React component tests
.\npm.cmd run web:test

# Production UI tests; build first
.\npm.cmd run web:build
.\npm.cmd run web:e2e
```

Tests use fixtures and temporary databases. Keep real credentials, browser sessions, database files, generated builds, and diagnostics out of Git.
