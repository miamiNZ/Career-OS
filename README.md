# Career OS

**AI-assisted, local-first job-hunting pipeline for the New Zealand market.**

Career OS is a standalone Node + TypeScript application that turns a stream of
job-alert emails into a ranked, tailored, human-gated application pipeline. It
reads and writes an [Obsidian](https://obsidian.md) vault as its datastore, so
every job, score, resume draft and decision lives in plain Markdown you own —
no cloud database, no lock-in.

It runs **local-first**: scoring and document tailoring default to a local
[Ollama](https://ollama.com) model, with optional Anthropic Claude as a
higher-quality cloud backend. The web dashboard binds to `127.0.0.1` only and is
never exposed to the network.

---

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running it](#running-it)
  - [The dashboard](#the-dashboard)
  - [Running in Docker](#running-in-docker)
  - [CLI commands](#cli-commands)
  - [The scheduler](#the-scheduler)
- [Vault layout](#vault-layout)
  - [What to search for](#what-to-search-for)
- [How fit is scored](#how-fit-is-scored)
- [Hard filters](#hard-filters)
- [Status flow](#status-flow)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security & privacy](#security--privacy)

---

## How it works

```
ingest → normalize → score → report → [GATE 1: you pick] → tailor → preview → [GATE 2: you approve] → submit
```

| Stage | What happens | Source |
|---|---|---|
| **ingest** | Read job-alert emails (Seek / LinkedIn / TradeMe) from Outlook / M365, or parse local `.eml`/`.txt` files | `src/ingest/` |
| **normalize** | Parse each alert into a structured `Job` (title, company, salary, url, JD) and dedupe | `src/pipeline.ts` |
| **score** | Match each job against your vault `Profile/` (skills, prefs). Hard filters auto-reject. Scoring runs on local Ollama, or Claude if a key is set | `src/score.ts` |
| **report** | Write a ranked Markdown report plus one job note per job back into the vault | `src/report.ts` |
| **GATE 1** | _You_ mark the jobs worth pursuing (`lead → interested`) | _human_ |
| **tailor** | Draft a tailored resume + cover letter from your master resume + the JD | `src/agents/`, `src/tailor.ts` |
| **preview** | Render the drafts for review | `src/apply.ts` |
| **GATE 2** | _You_ approve before anything is submitted | _human_ |
| **submit** | You submit from the vault (automated submit is a future phase) | `src/apply.ts` |

> Job sites forbid scraping, so ingestion is **email-alert based** (ToS-safe).
> No automated submission happens without your explicit approval.

---

## Requirements

| Requirement | Version / notes |
|---|---|
| **Node.js** | 20 LTS or newer (uses native ESM + `node:` imports) |
| **npm** | Bundled with Node |
| **An Obsidian vault** | Any folder of Markdown files; see [Vault layout](#vault-layout) |
| **Ollama** _(recommended)_ | For local scoring/tailoring. Pull a model, e.g. `ollama pull qwen3:32b` (~20 GB, the default) or `ollama pull qwen3:14b` (~9 GB) on a smaller GPU |
| **Anthropic API key** _(optional)_ | Enables cloud Claude scoring/tailoring instead of / alongside Ollama |
| **Outlook / M365** _(optional)_ | For live email ingestion via Microsoft Graph or IMAP. Not needed for `INGEST_SOURCE=file` |
| **OS** | Cross-platform. Use `make run` (Git Bash on Windows) or the npm scripts directly; or run it in [Docker](#running-in-docker) |
| **Docker** _(optional)_ | To run in a container — Docker Desktop on Windows/macOS, Docker Engine on Linux |

Ollama is *recommended* but not strictly required: if neither Ollama nor an
Anthropic key is available, scoring falls back to a cheaper keyword-overlap
heuristic.

---

## Installation

```bash
# 1. Clone
git clone <your-private-repo-url> Career-OS
cd Career-OS

# 2. Install dependencies
npm install

# 3. Create your config from the template
cp .env.example .env          # Windows: copy .env.example .env

# 4. Edit .env — set VAULT_PATH (required) and anything else you need
#    (see Configuration below)

# 5. Build (optional — dev/dashboard run straight from TypeScript via tsx)
npm run build
```

Or skip steps 2–5 and run **`make run`**, which creates `.env` from the template
if missing, installs dependencies, checks Node + Ollama, opens the browser, and
launches the dashboard. To run it in a container instead, see
[Running in Docker](#running-in-docker).

---

## Configuration

All configuration is environment variables, loaded from `.env`. Start from
[`.env.example`](.env.example) and fill in the values. `.env` is git-ignored.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `VAULT_PATH` | **Yes** | — | Absolute path to your Obsidian vault (the datastore) |
| `ANTHROPIC_API_KEY` | No | _(empty)_ | Enables cloud Claude scoring/tailoring. Blank = local-only |
| `INGEST_SOURCE` | No | `file` | `graph` \| `imap` \| `file`. `file` parses `./inbox/*.eml`/`.txt` |
| `GRAPH_CLIENT_ID` / `GRAPH_TENANT_ID` / `GRAPH_CLIENT_SECRET` | If `graph` | — | Azure AD app creds (grant `Mail.Read`) |
| `GRAPH_MAIL_FOLDER` | No | `JobAlerts` | Mail folder your job alerts are filtered into |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` / `IMAP_PASSWORD` | If `imap` | `outlook.office365.com` / `993` | IMAP fallback (use an app password) |
| `IMAP_FOLDER` | No | `JobAlerts` | IMAP mail folder |
| `DASHBOARD_PORT` | No | `8787` | Local dashboard port (bound to `127.0.0.1`) |
| `DASHBOARD_HOST` | No | `127.0.0.1` | Bind address. Stays loopback-only natively; the Docker targets set `0.0.0.0` in-container and publish to `127.0.0.1` on the host |
| `SCHEDULE_ENABLED` | No | `false` | Auto-run the read-side pipeline daily |
| `SCHEDULE_TIME` | No | `08:00` | Local time (`HH:MM`) for the daily auto-run |
| `OLLAMA_MODEL` | No | `qwen3:32b` | Local model used for scoring/tailoring |
| `OLLAMA_SCORE_MODEL` | No | `OLLAMA_MODEL` | Model used for scoring only, leaving the big model for tailoring. Faster, but scoring gates `min_fit_to_keep`, so a weaker scorer silently drops jobs off the board — validate a candidate with `npx tsx scripts/score-agreement.ts <model> 20` before setting this. qwen3:8b flipped 5/20 real jobs across the threshold here |
| `OLLAMA_URL` | No | `http://localhost:11434` | Override if Ollama runs elsewhere |
| `SCORE_CONCURRENCY` | No | `6` with an API key, else `2` | Jobs scored at once. Ollama serialises inference anyway unless `OLLAMA_NUM_PARALLEL` says otherwise, so the local default is only there to overlap the vault write of one job with the next job's inference |

**Minimum to get running locally:** set `VAULT_PATH`, leave `INGEST_SOURCE=file`,
have Ollama running. That's it.

### Choosing an ingest source

- **`file`** — drop exported `.eml` or `.txt` job alerts into `./inbox/`. Best
  for dev/offline and trying it out.
- **`imap`** — point at Outlook IMAP with an app password. Simplest live setup.
- **`graph`** — Microsoft Graph with a registered Azure AD app (`Mail.Read`).
  Recommended for live M365 use.

---

## Running it

### The dashboard

The primary interface is a local web board.

```bash
npm run dashboard          # → http://127.0.0.1:8787
```

Or via `make` (creates `.env`, installs deps, checks Ollama, opens the browser):

```bash
make run                   # → http://127.0.0.1:8787
make run PORT=9000         # override the port
make run NO_BROWSER=1      # don't auto-open the browser
```

In the dashboard:

- **Columns** are the [status flow](#status-flow); cards show the persisted
  **fit** score and an auto-reject badge.
- **▶ Run pipeline** runs `ingest → score → report` on demand and writes scores
  back onto each note so the board can rank.
- Per-card gate actions: **Pick** (GATE 1: `lead → interested`), **Tailor**,
  **Review ▸**, plus a `move…` dropdown for any allowed transition.
- Click a card → drawer with the full JD, matched/missing skills, and the
  **GATE 2** approve/reject panel.

### Running in Docker

Run the dashboard in a container while keeping your vault and Ollama on the host.
Requires Docker (Docker Desktop on Windows/macOS). Set `VAULT_PATH` in `.env`
first — it is bind-mounted into the container, so your Markdown never leaves the
host.

```bash
make docker-up        # build image + create & start the container → http://127.0.0.1:8787
make docker-logs      # follow the logs
make docker-stop      # stop it          make docker-start    # start it again
make docker-restart   # restart          make docker-down     # stop & remove
make docker-shell     # shell inside     make docker-ps       # status
make docker-rebuild   # down + rebuild image + up (after code changes)
```

How it stays local-only and wired up:

- The container binds `0.0.0.0`, but the port is **published to `127.0.0.1` only**
  (`-p 127.0.0.1:8787:8787`), so it's reachable from your machine and nowhere else.
- Your vault is mounted read-write at `/vault` (`VAULT_PATH` is overridden to
  `/vault` inside the container).
- Ollama runs on the host: the container reaches it via
  `http://host.docker.internal:11434` (set automatically).
- All other settings come from `.env` via `--env-file`.
- The targets are pinned to Docker's `desktop-linux` context (Docker Desktop), since
  only it can bind-mount Windows host paths. `make docker-up` starts Docker Desktop
  for you if it isn't running. If your default Docker context already points at a
  daemon that can see the vault, override with `make docker-up DOCKER_CONTEXT=default`.

Override the port with `make docker-up PORT=9000`, the image/container name with
`DOCKER_IMAGE=…` / `DOCKER_NAME=…`, the Docker context with `DOCKER_CONTEXT=…`.

**Deploy to an Unraid server** (private image, no Docker Hub / Community Apps):
`make docker-save` exports the image to `career-os-image.tar.gz`; follow
[deploy/unraid/README.md](deploy/unraid/README.md) to `docker load` it and install the
[template](deploy/unraid/career-os.xml) via the Unraid web UI.

### CLI commands

Run any stage directly without the dashboard:

```bash
npm run agents     # full agentic run: resume → search → score → tailor
npm run ingest     # ingest alerts → structured jobs
npm run score      # ingest + score + write the ranked report
npm run report     # alias of score
npm run rescore    # re-score every live job note with the current scorer
                   #   (skips Dropped; add -- --include-dropped for those too)
npm run rescore:stale
                   # re-score only the notes scored against an older resume/model
npm run dedupe     # report Opportunities that duplicate an Applied/Dropped role
                   #   (or are listed twice across sites); add -- --apply to drop them
npm run archive-applied
                   # clear the Applied + Unsuccessful columns off the board; add
                   #   -- --apply to write. The notes move to Career/Jobs/Archive/ and
                   #   every role is recorded in Career/applied-history.json, which
                   #   search keeps excluding for good — clearing the board never makes
                   #   a role you applied for eligible again
npm run dev        # watch-mode dev runner (tsx)
npm run build      # type-check + emit to dist/
npm run typecheck  # type-check only, no emit
```

(`tailor` and `apply` are folded into the `agents` run / human GATE 2 — the bare
commands print guidance.)

### The scheduler

Optionally auto-run the read-side pipeline daily, hosted by the dashboard
process:

```ini
SCHEDULE_ENABLED=true
SCHEDULE_TIME=08:00        # local time
```

Last-run time and result persist to `.career-os-state.json` (git-ignored) so the
dashboard shows them after a restart.

---

## Vault layout

Career OS reads/writes these paths under `VAULT_PATH` (see `src/config.ts`):

```
<VAULT_PATH>/
└── Career/
    ├── Profile/                     # your skills + preferences (scoring input)
    ├── Jobs/                        # one Markdown note per job
    │   ├── _template.md             # job-note template
    │   ├── Applications/            # tailored resumes + cover letters
    │   └── Archive/                 # notes cleared off the board (archive-applied)
    ├── applied-history.json         # every role you applied for — search excludes these
    │                                #   for good, even once their notes are archived
    ├── Resume/
    │   └── resume-master.md         # master resume the tailor draws from
    ├── Supporting/
    │   └── cover-letter-template.md
    └── Applications/
        ├── tracker.md
        └── report-YYYY-MM-DD.md     # generated ranked reports
```

### What to search for

`Career/Profile/job-search.md` is the one place you say what kind of job you want. Its
frontmatter drives the search agents:

- `primary_searches` — the main career track: one job **title** per entry, each run as
  its own search. Leave it empty and the titles come from `## Target roles` in
  `preferences.md`.
- `search_tracks` — extra job categories, each with its own `searches` list and its own
  `location` list. They run alongside the primary search, ignore the
  `employment_type` / `engagement` filters, and are exempt from the `min_fit_to_keep`
  cut, so casual and off-profile local work still reaches the board.

```yaml
search_tracks:
  - name: local-it
    searches: [information technology, it support, help desk]
    location: [Waikato, Hamilton, Cambridge]
    title_match: [it, software, developer, help desk, network, data]
```

The **first** `location` entry is the area the job boards are actually searched in; the
full list then keeps only results whose location text names one of those places. That
order matters: a nationwide search for "it support" returns 20 relevance-ranked results
that contain no local job at all, so filtering afterwards yields nothing — searching
the region directly returns the local listings. Drop `location` to run a track
nationwide.

`title_match` is optional and keeps a broad track on topic: the boards match a keyword
against the whole ad body, so "information technology" also returns every local ad that
merely mentions computers (Office Administrator, Customer Experience Specialist). Only
titles containing one of the terms as a **whole word** are kept — "it" hits
"Operations & IT Support" but not "Unit Manager". The primary track solves the same
problem with `min_fit_to_keep`, which tracks are exempt from by design.

The older `extra_searches` / `extra_location` pair still works and behaves as a single
unnamed track.

---

## How fit is scored

Every scorer — Claude, local Ollama, and the keyword fallback — is given the same
candidate description, built by `src/profile.ts` from the vault:

- `Career/Resume/resume-master.md` — its `role` / `location` / `work_rights`
  frontmatter, **Professional Summary**, **Technical Skills**, and the role headings
  under **Work Experience**
- `Career/Profile/preferences.md` — target roles, roles to deprioritise, location and
  work mode, domains of interest, hard requirements
- `Career/Profile/skills.md` — only as a fallback, when the master resume has no
  Technical Skills section

The master CV leads deliberately: it is the document you actually send, so a skill you
add there counts towards fit without having to be back-ported into `skills.md`.

A run only scores jobs it has never scored, so after editing your CV the board still
shows the old numbers. Each note records the profile it was scored against
(`profileHash`) and the model that produced it (`scorer`), so:

```bash
npm run rescore:stale   # re-score only the notes that are out of date
npm run rescore         # re-score every live note
```

Both skip **Dropped** roles — a board holds far more of those than live ones, and
re-scoring a role you already said no to changes nothing you look at. Add
`-- --include-dropped` if you want them too.

---

## Hard filters

Jobs are auto-rejected before scoring if they fail any hard filter. The values live in
the frontmatter of `Career/Profile/preferences.md`, not in code:

```yaml
min_salary: 80000                     # or "80k"; 0 / absent = no salary floor
reject_if_citizenship_required: false # true = reject citizen-only / clearance roles
```

- Salary advertised below `min_salary` (only when a maximum is actually parsed —
  "Negotiable" / unstated salary is never rejected on this rule)
- Requires NZ **citizenship** or a security clearance with no residency pathway
  (only when `reject_if_citizenship_required: true`)
- Preferred engagement type: **permanent**

### Title fit caps

A CV full of evidence for a kind of role you don't want (say, management work when you
want hands-on engineering) makes those listings outscore the ones you do. List them in the
same frontmatter and their fit is held at a ceiling — they still show on the board, just
below `min_fit_to_apply` — and searches for that title are skipped:

```yaml
title_fit_caps:
  - title: manager                   # whole word, any case
    max_fit: 40                      # fit never shown above this
    unless: [engineering]            # …unless the title also names one of these
```

No list means nothing is capped.

---

## Status flow

Each job note's frontmatter carries a status that the dashboard columns mirror:

```
lead → interested → tailoring → applied → interview → offer / rejected / dropped
```

`lead → interested` is **GATE 1** (you choose what to pursue); the approve step
before submission is **GATE 2**. The state machine lives in `src/workflow.ts`.

---

## Project structure

```
src/
├── agents/            # agentic resume / search / application steps
│   └── search/        # seek, trademe, linkedin, indeed, zeil, classify, describe
├── ingest/            # email/file ingestion sources
├── web/               # dashboard UI (static: index.html, app.js, styles.css)
├── config.ts          # env → typed config + vault paths + hard filters
├── pipeline.ts        # ingest → normalize → score → report
├── orchestrator.ts    # full agentic run + rescore
├── score.ts           # scoring (Ollama / Claude / heuristic fallback)
├── report.ts          # ranked report + per-job notes
├── tailor.ts          # resume / cover-letter tailoring
├── apply.ts           # preview + submission (GATE 2)
├── scheduler.ts       # optional daily auto-run
├── server.ts          # dashboard HTTP server (127.0.0.1)
├── workflow.ts        # status state machine
├── vault.ts           # vault read/write helpers
├── llm.ts             # local Ollama client
└── cli.ts             # command dispatch

scripts/
└── score-agreement.ts # compare a candidate scoring model against recorded fits
```

---

## Troubleshooting

**`Missing required env var: VAULT_PATH`**
`VAULT_PATH` isn't set. Copy `.env.example → .env` and set it to the absolute
path of your Obsidian vault.

**Scores all come back low / generic, or "LLM unavailable"**
Ollama isn't running or the model isn't pulled. Start Ollama and run
`ollama pull qwen3:32b` (or set `OLLAMA_MODEL` to a model you have).
`make run` prints whether Ollama is reachable. Alternatively set
`ANTHROPIC_API_KEY` to use Claude instead. In Docker, Ollama must be reachable at
`host.docker.internal:11434` (the default the `docker-*` targets set).

**Dashboard won't open / "port already in use"**
Another instance may already be running. Open `http://127.0.0.1:8787` directly,
or set `DASHBOARD_PORT` (or `make run PORT=9000`) to a free port.

**No jobs appear after running the pipeline**
- `INGEST_SOURCE=file`: confirm there are `.eml`/`.txt` alerts in `./inbox/`.
- `imap`/`graph`: confirm credentials and that your alert emails actually land
  in the configured folder (`IMAP_FOLDER` / `GRAPH_MAIL_FOLDER`).

**IMAP login fails with the right password**
Outlook/M365 requires an **app password** (not your account password) and IMAP
must be enabled on the mailbox.

**Build errors after pulling changes**
Run `npm install` (dependencies may have changed), then `npm run build`. The dev
server (`npm run dev`) and dashboard run straight from TypeScript via `tsx` and
don't need a build.

**Nothing writes to the vault**
Check `VAULT_PATH` points at the right folder and that the `Career/…`
sub-folders exist (see [Vault layout](#vault-layout)).

**`make` fails with "The system cannot find the path specified." / `Error 255`**
On Windows, `bash` on the PATH may resolve to `C:\Windows\System32\bash.exe` (the
WSL launcher), which can't run the recipes. The Makefile auto-detects Git Bash
(`PROGRA~1\Git\…\bash.exe`). If your Git is installed elsewhere, point it at the
right binary explicitly:

```
make run GIT_BASH_EXE=C:/Path/To/Git/bin/bash.exe
```

Or just run `make` from a Git Bash terminal. (GnuWin32 `make` can't use a shell
path containing spaces, so the 8.3 short path is used.)

---

## Security & privacy

- **Local-first.** Scoring/tailoring default to local Ollama; the dashboard
  binds `127.0.0.1` only and is never exposed to the network.
- **Your data stays in your vault.** Jobs, scores and drafts are plain Markdown
  in your Obsidian vault — no external database.
- **Secrets live in `.env`**, which is git-ignored. Never commit it. Share only
  `.env.example`.
- **Job-board terms.** The search agents call the job boards' public and
  unofficial search endpoints (Seek, TradeMe, LinkedIn's guest API, Indeed's app
  API, ZEIL with your own login). Some boards' terms of use restrict automated
  access — check them, keep only the boards you are comfortable with in `sites`,
  and use the agents at a modest rate, or rely on the email-alert ingest instead. Nothing is ever submitted to an
  employer without your explicit approval (GATE 2).

---

## Licence

[MIT](LICENSE).
