# PM Dev Stack roadmap

PM Dev Stack is a fork of [CloudCLI](https://github.com/siteboon/claudecodeui) tuned for one workflow: a person who
runs many client engagements end to end, both the project management side (schedule, deadlines, negotiation) and
the implementation side (code), each in its own Claude Code session. Instead of one terminal tab per client and
topic, the app becomes the single place where those sessions live: dormant until clicked, grouped by client, with
each client's management view one click away.

The fork only receives from upstream (`scripts/sync-upstream.sh`); nothing here is sent back. New features live in
their own modules, and upstream files get only small registration hooks, so syncs conflict in predictable places.

The app runs as a systemd user service (`scripts/install-autostart.sh`) from a separate deploy directory that
`scripts/deploy.sh` builds from `main`, so building or testing in the checkout never changes the running app. A
deploy skips the restart while any Shell is live, since a restart would kill it.

## Configuration

Everything personal stays in the gitignored `.env` (see `.env.example`). Nothing in the repo is specific to one
machine, and no client data is ever committed: the app reads it at runtime from the configured workspace.

| Key | What it is |
|---|---|
| `CLAUDE_CONFIG_DIR` | Claude Code config dir whose sessions the app shows (one account per install). |
| `HU360_DIR` | Root of the workspace that holds the client folders (`docs/clients/<slug>/`) and the schedule skill. |
| `HUBSPOT_TOKEN` | HubSpot Private App token; HubSpot Projects are the source of truth for schedules. |
| `SHELL_IDLE_TIMEOUT_HOURS` | How long an idle, unwatched Shell process lives (default 4). |

A missing workspace path or token degrades with a clear message; the grouped sidebar keeps working without them.

## Milestones

### M1: Sidebar

- New "Clients" sidebar tab, selected by default; upstream tabs stay.
- Clicking a session opens the Shell tab by default.
- A Shell's `claude` process is never killed while it is working. Idle and unwatched, it dies after
  `SHELL_IDLE_TIMEOUT_HOURS`.
- Sessions are grouped by title prefix (text before ` / `); titles without one fall into an "ungrouped" bucket. The
  grouped view loads every session, not one page.
- A pinned "Management" section on top, with cross-client sessions and an "Upcoming deadlines" entry (M4).
- Inside each client group, the `<Client> / Management` session is pinned and highlighted.
- App-level session status: Active, Paused, Closed, Ignored. Paused and Closed return to Active on newer activity;
  Ignored never does. Status never touches the title.
- One-time migration of title markers (`✅`, `<ignore>`) into status, with a preview before applying.
- A "Branch" button replaces the CLI's `/branch`: forks the session, asks what the branch is for, names it
  `<Client> / <Topic>` and opens it in the Shell.

### M2: Client panel (read only)

- Clicking a client group header opens the client panel.
- Clients with a schedule: the schedule is rendered locally from live HubSpot data with the workspace's own template.
- Clients without one: the client's README and notes, plus a "Create schedule" button that launches the client's
  management session with the schedule-init skill.
- Prefix to client folder mapping: optional aliases in `docs/clients/<slug>/client.json`, else the slug itself.

### M3: Full schedule editing

- Edit the project window, phases and activities (create, edit, reorder, delete) straight to HubSpot.
- Extending the deadline of an activity that is already late records the original deadline as a baseline, so
  replanning never hides a delay.
- Edit the schedule's editorial texts; saving commits only that file in the workspace and pushes when safe.
- After edits, the shared published copy of the schedule is republished automatically, debounced.

### M4: Upcoming deadlines

- A live list of the next activities across every client with a schedule, sorted by due date, late ones highlighted.

## Out of scope

- Manual groups or dragging sessions between groups; status embedded in titles; integration with editors.
- Sending changes upstream.
- Several Claude accounts in one install.

## Status

| Milestone | State |
|---|---|
| M1 | in progress |
| M2 | planned |
| M3 | planned |
| M4 | planned |
