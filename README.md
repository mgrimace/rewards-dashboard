# Rewards Dashboard

A companion dashboard for [microsoft-rewards-script](https://github.com/thenetsky/microsoft-rewards-script), driven entirely over HTTP by the bot's [Control API](https://github.com/thenetsky/microsoft-rewards-script/tree/v4/scripts/api) (`API_MODE=true`). It shows account status, point totals, and trends at `http://<host-ip>:8890`, and can start/stop/schedule runs and edit the bot's config.

## Screenshots

| Desktop | Mobile |
| --- | --- |
| ![Desktop screenshot](./docs/Screenshot-dash.png) | ![Mobile screenshot](./docs/Screenshot-mobile.png) |

## Features
- **Local only** - all data is stored locally, your account data is your own.
- **Account overview** — points per account, run status, and error highlights
- **Point accumulation bars** — see trends and errors at a glance with daily blocks per account, with weekly dividers; hover for exact date/points/total
- **Passwordless codes** — displays passwordless two-digit codes with a live 60-second countdown so you never miss them in the logs
- **History** — parsed events stored in a local SQLite db so data survives restarts, independent of the bot's own in-memory log buffer
- **Theme support** — Includes themes: Nord, Dracula, Catppuccin, Gruvbox, Tokyo Night, and more!
- **Responsive** - Features a simplified mobile view

## Quick start (Docker)

1. On the bot side, enable the Control API — set `API_MODE=true` and `API_TOKEN=<some-long-random-string>` on the `microsoft-rewards-script` service, and expose port `3010`.

> [!CAUTION]
> These script-side permissions are optional: `API_ALLOW_CONFIG_WRITE=true` allows config changes, `API_ALLOW_CONFIG_REVEAL=true` allows revealing sensitive config values, and `API_ALLOW_SCHEDULE_WRITE=true` allows changing the bot-container schedule. Enable only the capabilities you need; these flags are not required to start the dashboard.

2. Review this repo's `compose.yaml` and set `API_TOKEN` (in a `.env` file next to it) to that same token for the initial connection.
3. Build and start the container: `docker compose up -d`.
4. Visit the dash at `http://<host-ip>:8890`. Use **Connections** to manage servers.

> [!WARNING]
> Both services need to share a Docker network so the dashboard can reach the Control API by container name. 
> The easiest way to do this is copy the full rewards-dashboard service into your script's compose.yaml. See [sample-stack-compose.yaml](sample-stack-compose.yaml)
> Alternatively, create a docker network (e..g, `rewards`), and add the following to both the script and the dash compose.yaml

```yaml
  networks:
    - rewards

networks:
  rewards:
    driver: bridge
    external: true

```

## Quick start (Bare metal)
Requires Node 22.13+ (uses the built-in `node:sqlite`). Zero npm packages.

```bash
# in the bot repo
API_TOKEN=some-long-random-string node scripts/api/server.js
```

Then point the dashboard at it - `CONTROL_API_TOKEN` must equal the API's `API_TOKEN`:

```bash
cd rewards-dashboard
cp env.example .env       # initial CONTROL_API_URL + CONTROL_API_TOKEN
npm start                 # http://localhost:8890
```

> [!TIP]
> The initial `.env` connection is imported once as **Default Server**; manage later changes in **Connections**.

> [!WARNING]
> Back up `dashboard.sqlite` before upgrading; databases with custom schemas may require manual migration.

## Authentication
Dashboard login protection is configured separately with `DASHBOARD_USERNAME`
and `DASHBOARD_PASSWORD`. Basic authentication is enabled only when both values
are non-empty. Leave either one empty to open the dashboard without a browser
login prompt. This does not disable authentication between the dashboard and the
Control API; each saved connection token must match its API's `API_TOKEN`.

> [!CAUTION]
> Tokens are stored unencrypted in SQLite; protect the data directory, `.env`, Docker host and backups, and enable dashboard authentication when accessible to others.

## Optional API flags

Two features are gated on the _API_ side, and are off by default:

| Set on the Control API         | What it unlocks                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `API_ALLOW_CONFIG_WRITE=true`  | The **Config** tab can save changes. Without it, config is read-only and saving returns a 403 (the tab tells you so). |
| `API_ALLOW_CONFIG_REVEAL=true` | The **Config** tab's "reveal secrets" toggle. Without it, webhook URLs and tokens stay `***REDACTED***`.              |

---

## Tabs

**Connections** - add, edit, test, enable, disable, reorder and remove servers.

> [!TIP]
> Drag a connection's handle to reorder it, or focus the handle and use the arrow keys.

> [!TIP]
> Select a server in the control strip for run controls, Schedule, Config and Diagnostics; Overview and Accounts combine enabled servers.

**Overview** - stat cards (accounts, combined balance, last run, accounts in error, next scheduled run), run progress and per-account rows.

**Accounts** - every configured account, joined with what the logs actually observed: current balance, daily accumulation bars, today's gain, success/error state, current streak, streak protection status and remaining protection days, and a details drawer (slot, geo, language, TOTP, recovery email, proxy, lifetime collected). Accounts live in the bot's `.env`, so this tab reports on them rather than editing them.

> [!TIP]
> Browse retained history in Runs and Logs, or enable **Include removed and disabled servers** in Accounts; removal clears the connection's URL and token.

**Logs** - live log viewer over SSE. Server and level filters, text search, pause (buffers while paused), autoscroll, load-more, download, clear. For removed or disabled servers only the dashboard's retained parsed activity is available, not complete upstream logs.

**Runs** - points collected per day (14/30/90-day views) plus a server-filtered run history table, with **Load older runs** and **Show all recorded runs** controls. A collapsible list of process exits is pulled from each enabled API; exits that existed only in an upstream API are unavailable once it is removed.

**Schedule** - the dashboard's own cron. Presets, a live-validated cron field with a plain-English description, account exclusions, missed-run recovery, "skip if already running", next/last run times and the last result. It's stored in the dashboard's database and fires a run by pressing Start on the API for you.

**Config** - the bot's `config.json`. Quick toggles for the common booleans, plus a raw JSON editor. Saving sends a **PATCH of only the fields you changed**, never a full document - so the redacted webhook secrets in your view can't be written over the real ones. If you do edit a redacted field, the save is refused with an explanation. Validation errors from the bot's own validator come back inline.

**Diagnostics** - the bot's error captures. Error text, screenshot, and the HTML dump, streamed through the dashboard.

Above the tabs, a control strip is always visible: **Start**, **Stop**, **Restart**, and behind the ⋮ menu, **Force stop** and **Shut down API**. Login approval codes appear at the top of the page the moment they show up in the logs, with a countdown.

---

## How it works

**One SSE connection per enabled server, fanned out.** Each Control API has an independent stream, `Last-Event-ID` cursor and reconnect backoff. The dashboard shares one browser stream across servers and associates events with their originating server.

**Two data paths.** Log lines go to the browser live, _and_ through the parser into SQLite (`lib/store.js`). The API keeps a 2,000-line in-memory buffer that dies with the process; the dashboard's point history, run records, activity and schedule survive restarts of both.

**Live points.** The bot prints its balance and every gain as it earns them, and the API folds those lines into a running tally (`GET /points`). So the Overview shows points climbing _during_ a run, not just the final total. When an account finishes, the live tally is replaced by the authoritative `ACCOUNT-END` numbers.

**Separate authentication layers.** Each connection token is sent only from the dashboard to its Control API as a Bearer token. Browser access uses the optional `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` pair instead.

**No dependencies.** Charts are hand-rolled inline SVG (`public/charts.js`) that read their colors from CSS variables, so they follow the theme and work offline. The 14 themes from the original dashboard are untouched.

---

## Environment

| Variable              | Default                                |                                                                                           |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `CONTROL_API_URL`     | -                                      | Initial connection URL; legacy database fallback is `http://microsoft-rewards-script:3010` |
| `CONTROL_API_TOKEN`   | -                                      | Initial connection token; ignored after migration                                         |
| `DASHBOARD_USERNAME`  | -                                      | Optional Basic-auth username; auth is enabled only when username and password are set     |
| `DASHBOARD_PASSWORD`  | -                                      | Optional Basic-auth password; leave either dashboard credential empty to disable login    |
| `PORT`                | `8890`                                 |                                                                                           |
| `TZ`                  | `UTC`                                  | Buckets points into days - set it                                                         |
| `DASHBOARD_TITLE`     | `Microsoft Rewards`                    | Header title                                                                              |
| `POLL_MS`             | `5000`                                 | Status poll interval (logs are streamed)                                                  |
| `LOG_REPLAY`          | `300`                                  | Log lines to replay when the stream connects                                              |
| `DATA_DIR`            | `./data`                               | Where `dashboard.sqlite` lives - the only folder anything writes to. Docker sets `/data`. |

---

## Troubleshooting

**"Control API unreachable"** - the dashboard can't open a TCP connection. Check the URL in Connections. In Docker, `localhost` means the dashboard's own container: use the API's service name, or `host.docker.internal` with `extra_hosts`.

**"Control API rejected our token"** - replace the connection token with the Control API's `API_TOKEN`.

**Browser login prompt does not appear** - both `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` must be non-empty. Authentication is intentionally disabled when either value is empty.

**Saving config returns 403** - the API was started without `API_ALLOW_CONFIG_WRITE=true`.

**Daily bars roll over at the wrong time** - `TZ` isn't set.

**A scheduled run didn't fire** - check the Schedule tab's missed-run policy, excluded accounts, and "Last result".

## Support

If you've found this project helpful and would like to support further development, please consider donating. Thank you:

[![Donate with PayPal](https://img.shields.io/badge/PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=R4QX73RWYB3ZA)
[![Liberapay](https://img.shields.io/badge/Liberapay-F6C915?logo=liberapay&logoColor=black)](https://liberapay.com/cammarata.m/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://www.ko-fi.com/mgrimace)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/cammaratam)
