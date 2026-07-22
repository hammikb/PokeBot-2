# PokeBot 2

Desktop monitoring and checkout assistant built with Electron, React, and Node.js. The app supports retailer tasks, persistent account sessions, proxy management, Supabase-backed monitoring, checkout telemetry, and Windows packaging.

## Requirements

- Node.js 20 or newer
- npm
- Windows for the primary packaged build and native input integration
- A Supabase project when using central monitoring
- Optional: Python 3 for the Pi monitoring and product-lookup scripts

## Local setup

```bash
git clone https://github.com/hammikb/PokeBot-2.git
cd PokeBot-2
npm install
copy .env.example .env
npm run dev
```

The checked-in `.env.example` contains the public client configuration used by the app. Put private credentials, overrides, and machine-specific values in `.env`; that file is ignored by Git.

## Validation

```bash
npm test
npm run build
```

## Packaging

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

## Optional Python lookup support

```bash
npm run scrapling:install
npm run scrapling:lookup
```

## Local data and credentials

The repository intentionally does not include:

- `.env` files or private API credentials
- imported proxy lists
- account cookies or browser profiles
- local databases
- logs, traces, screenshots, coverage, or compiled builds

Those remain on each user's machine. Clone the repository and configure them locally.

## Useful directories

- `src/main` — Electron main process, monitoring, tasks, retailer flows, and persistence
- `src/renderer` — React user interface
- `src/shared` — shared IPC constants
- `tests` — Vitest test suite
- `scripts` — optional Pi services, diagnostics, and Python integrations
- `docs` — architecture, setup, and retailer notes
