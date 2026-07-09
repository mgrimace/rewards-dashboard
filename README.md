# Rewards Dashboard

A simple companion dashboard for [microsoft-rewards-script](https://github.com/thenetsky/microsoft-rewards-script) that reads the bot's container logs and shows account status, point totals, and trends at `http://<host-ip>:8890`. It makes zero changes to the bot itself.

## Screenshots

| Desktop | Mobile |
| --- | --- |
| ![Desktop screenshot](./docs/Screenshot-dash.png) | ![Mobile screenshot](./docs/Screenshot-mobile.png) |

## Features
- **Local only** - all data is stored locally, your account data is your own.
- **Account overview** — points per account, run status, and error highlights
- **Point accumulation bars** — see trends and errors at a glance with daily blocks per account, with weekly dividers; hover for exact date/points/total
- **Passwordless codes** — displays passwordless two-digit codes with a live 60-second countdown so you never miss them in the logs
- **History** — parsed events stored in a local SQLite db so data survives restarts and isn't limited by Docker's log retention
- **Theme support** — Includes themes: Nord, Dracula, Catppuccin, Gruvbox, Tokyo Night, and more!
- **Responsive** - Features a simplified mobile view

> [!TIP]
> Use the privacy toggle (eye/sunglasses icon) when taking screenshots or copying logs.

## Quick start

1. Review the provided Docker `compose.yaml`
2. Build and start the container using `docker compose up -d`

> [!TIP]
> If you've changed the name of your microsoft-rewards-script container, change `TARGET_CONTAINER: 'microsoft-rewards-script'` to match.

3. Visit the dash at `http://<host-ip>:8890`.

> [!TIP]
> You can alternatively add the services in this compose to your microsoft-rewards-script `compose.yaml` for a single stack.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TARGET_CONTAINER` | `microsoft-rewards-script` | Name of the bot container to watch |
| `BACKFILL_HOURS` | `720` (30 days) | How far back to read on first start; `0` = all |

## Support

If you've found this project helpful and would like to support further development, please consider donating. Thank you:

[![Donate with PayPal](https://img.shields.io/badge/PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=R4QX73RWYB3ZA)
[![Liberapay](https://img.shields.io/badge/Liberapay-F6C915?logo=liberapay&logoColor=black)](https://liberapay.com/cammarata.m/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://www.ko-fi.com/mgrimace)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/cammaratam)