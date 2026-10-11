-include .env
export
# ---------------------------------------------------------------------------
# Shell  -- bash everywhere.
#   On Windows we MUST use Git Bash, never C:\Windows\System32\bash.exe (the WSL
#   launcher), which breaks these recipes ("The system cannot find the path
#   specified."). The glob below finds Git Bash without hard-coding the space in
#   "Program Files". Override with:  make GIT_BASH_EXE=C:/path/to/bash.exe <target>
# ---------------------------------------------------------------------------
ifeq ($(OS),Windows_NT)
  # Use the 8.3 short path (PROGRA~1) so SHELL has no spaces - GnuWin32 make
  # cannot launch a shell whose path contains spaces.
  GIT_BASH := $(firstword \
    $(wildcard C:/PROGRA~1/Git/bin/bash.exe) \
    $(wildcard C:/PROGRA~2/Git/bin/bash.exe) \
    $(wildcard C:/PROGRA~1/Git/usr/bin/bash.exe) \
    $(wildcard C:/PROGRA~2/Git/usr/bin/bash.exe))
  SHELL := $(or $(GIT_BASH_EXE),$(GIT_BASH),bash)
else
  SHELL := /bin/bash
endif
.SHELLFLAGS := -euo pipefail -c

# -- Config (override on cmd line: make run PORT=9000) -----------------------
PORT       ?= $(or $(DASHBOARD_PORT),8787)
GHPAT   := $(shell grep -m1 '^GHPAT='   .env 2>/dev/null | cut -d= -f2-)
GHUNAME := $(shell grep -m1 '^GHUNAME=' .env 2>/dev/null | cut -d= -f2-)
# Version = the canonical one in package.json (same value the app serves at runtime).
# Parsed with grep/sed (no node dependency) so docker-build/push need only docker.
VERSION := $(shell grep -m1 '"version"' package.json 2>/dev/null | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | grep . || echo 0.0.0)
MAJOR   := $(firstword $(subst ., ,$(VERSION)))
IMAGE    := career-os
REGISTRY := ghcr.io/$(GHUNAME)/$(IMAGE)
export DOCKER_BUILDKIT=1
export DASHBOARD_PORT := $(PORT)

# Ollama model to pull (defaults to OLLAMA_MODEL from .env, else the app default).
# Override on the command line: make ollama-pull MODEL=qwen3:30b-a3b
OLLAMA_MODEL ?= qwen3:32b
MODEL        ?= $(OLLAMA_MODEL)

# -- Spinner: $(call spin,LABEL,COMMAND) -------------------------------------
# Runs COMMAND in background, animates braille spinner, shows [OK]/[ERROR].
# Output captured to temp file; only printed on failure.
define spin
	out=$$(mktemp); \
	( $(2) ) > "$$out" 2>&1 & \
	pid=$$!; \
	while kill -0 $$pid 2>/dev/null; do \
		for f in '|' '/' '-' '\'; do \
			printf '\r\033[34m%s\033[0m %s ' "$$f" "$(1)"; \
			sleep 0.12; \
		done; \
	done; \
	if wait $$pid; then \
		printf '\r\033[42;30m[OK]\033[0m %s\033[K\n' "$(1)"; \
		rm -f "$$out"; \
	else \
		rc=$$?; \
		printf '\r\033[41;37m[ERROR]\033[0m %s\033[K\n' "$(1)"; \
		cat "$$out"; rm -f "$$out"; exit $$rc; \
	fi
endef

# VERBOSE=1 streams the command's output live instead of hiding it behind the
# spinner - use it to diagnose a failing build/push (e.g. make push VERBOSE=1).
ifeq ($(VERBOSE),1)
override define spin
	printf '\033[34m>>>\033[0m %s\n' "$(1)"; \
	$(2)
endef
endif

.DEFAULT_GOAL := help

DOCKER_IMAGE ?= career-os
DOCKER_NAME  ?= career-os
# Pin to Docker Desktop. If your default docker context points at a remote daemon, that
# daemon can't see a local Windows vault, so the docker-* targets force the desktop-linux
# context, which bind-mounts Windows paths. Override if needed:
#   make docker-up DOCKER_CONTEXT=default
DOCKER_CONTEXT ?= desktop-linux
DOCKER         := docker --context $(DOCKER_CONTEXT)
# Docker wants forward slashes in bind-mount paths; convert any Windows backslashes
# from VAULT_PATH here (at make level) rather than with fragile in-recipe sed.
VAULT_MOUNT  := $(subst \,/,$(VAULT_PATH))

.PHONY: help install build run dev stop kill rebuild clean audit outdated env \
        docker-daemon docker-build docker-up docker-start docker-stop docker-restart \
        docker-down docker-logs docker-shell docker-ps docker-rebuild docker-save \
        login push ollama-pull ollama-list ollama-rm

help:
	@echo "Career OS  -- local-first NZ job-hunting pipeline"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@echo "Native targets:"
	@echo "  install     Install npm dependencies"
	@echo "  build       Type-check + compile to ./dist"
	@echo "  run         Start the dashboard  -- http://127.0.0.1:$(PORT)"
	@echo "              (auto-creates .env, installs deps, checks Ollama, opens browser)"
	@echo "  dev         Watch-mode dev runner (tsx)"
	@echo "  stop        Stop the dashboard on port $(PORT)  (alias: kill)"
	@echo "  rebuild     stop + clean + build"
	@echo "  clean       Remove ./dist"
	@echo "  audit       npm security audit"
	@echo "  outdated    List outdated packages"
	@echo "  ollama-pull Pull the local LLM ($(MODEL))  [override: MODEL=qwen2.5:32b-instruct]"
	@echo "  ollama-list List installed Ollama models"
	@echo "  ollama-rm   Delete an Ollama model (interactive picker, or MODEL=name to skip prompt)"
	@echo ""
	@echo "Docker targets (run Career OS in a container):"
	@echo "  docker-daemon   Ensure Docker is running (starts Docker Desktop if not)"
	@echo "  docker-build    Build the image ($(DOCKER_IMAGE))"
	@echo "  docker-up       Build + create & start the container  -- http://127.0.0.1:$(PORT)"
	@echo "  docker-start    Start the existing stopped container"
	@echo "  docker-stop     Stop the running container"
	@echo "  docker-restart  Restart the container"
	@echo "  docker-down     Stop & remove the container"
	@echo "  docker-logs     Follow container logs"
	@echo "  docker-shell    Open a shell inside the container"
	@echo "  docker-ps       Show container status"
	@echo "  docker-rebuild  down + build + up"
	@echo "  docker-save     Save the image to career-os-image.tar.gz (deploy to Unraid: docker load)"
	@echo ""
	@echo "Registry targets (publish to GitHub Container Registry):"
	@echo "  login           Log in to ghcr.io  (needs GHPAT + GHUNAME in .env)"
	@echo "  push            Build, tag (v$(VERSION)/v$(MAJOR)/latest) & push to ghcr.io/$(GHUNAME)/$(IMAGE)"
	@echo ""
	@echo "Config (current values):"
	@echo "  PORT = $(PORT)   (override: make run PORT=9000)"
	@echo "  NO_BROWSER       set to skip auto-opening the browser (make run NO_BROWSER=1)"
	@echo "  VERBOSE=1        stream docker build/push output instead of the spinner"

install:
	@$(call spin,Installing dependencies,npm install)

build:
	@$(call spin,Building,npm run build)

# Create .env from the template if it is missing (mirrors the old start.ps1 step).
env:
	@if [ ! -f .env ]; then \
		if [ -f .env.example ]; then \
			cp .env.example .env; \
			printf '\033[33m>>>\033[0m Created .env from .env.example - set VAULT_PATH before running\n'; \
		else \
			printf '\033[33m>>>\033[0m No .env / .env.example found (continuing with defaults)\n'; \
		fi; \
	fi

# Real (non-phony) target: only installs when node_modules is absent.
node_modules:
	@$(call spin,Installing dependencies,npm install)

# Start the dashboard natively. Replaces start.ps1: ensures .env + deps, checks
# Node + Ollama, opens the browser, and falls through to a running message if the
# port is already in use. Skip the browser with NO_BROWSER=1.
run: env node_modules
	@command -v node >/dev/null 2>&1 || { printf '\033[41;37m[ERROR]\033[0m Node.js not found on PATH. Install Node 20+ from https://nodejs.org\n'; exit 1; }; \
	printf '\033[34m>>>\033[0m node %s\n' "$$(node --version)"; \
	if curl -fsS -m 2 "$${OLLAMA_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then \
		printf '\033[34m>>>\033[0m ollama reachable\n'; \
	else \
		printf '\033[33m>>>\033[0m ollama not reachable (LLM scoring/tailoring unavailable)\n'; \
	fi; \
	open_url() { \
		case "$$(uname -s)" in \
		  MINGW*|MSYS*|CYGWIN*|Windows*) MSYS_NO_PATHCONV=1 cmd //c start "" "$$1" >/dev/null 2>&1 || true ;; \
		  Darwin) open "$$1" >/dev/null 2>&1 || true ;; \
		  *) xdg-open "$$1" >/dev/null 2>&1 || true ;; \
		esac; }; \
	case "$$(uname -s)" in \
	  MINGW*|MSYS*|CYGWIN*|Windows*) busy=$$(netstat -ano | grep -E ':$(PORT)[[:space:]]' | grep -i LISTENING || true) ;; \
	  *) busy=$$( (command -v lsof >/dev/null && lsof -ti tcp:$(PORT) -sTCP:LISTEN) || true ) ;; \
	esac; \
	if [ -n "$$busy" ]; then \
		printf '\033[33m>>>\033[0m Port $(PORT) already in use - dashboard may already be running\n'; \
		[ -n "$(NO_BROWSER)" ] || open_url "http://127.0.0.1:$(PORT)"; \
		exit 0; \
	fi; \
	[ -n "$(NO_BROWSER)" ] || ( sleep 3; open_url "http://127.0.0.1:$(PORT)" ) & \
	printf '\033[34m>>>\033[0m Dashboard on http://127.0.0.1:$(PORT) (Ctrl+C to stop)\n'; \
	npm run dashboard || true; \
	printf '\033[42;30m[OK]\033[0m Dashboard stopped\n'

dev:
	@printf '\033[34m>>>\033[0m Watch-mode dev runner (Ctrl+C to stop)\n'
	npm run dev

stop kill:
	@case "$$(uname -s)" in \
	  MINGW*|MSYS*|CYGWIN*|Windows*) \
	    pids=$$(netstat -ano | grep -E ':$(PORT)[[:space:]]' | grep -i LISTENING | awk '{print $$5}' | sort -u); \
	    killer() { MSYS_NO_PATHCONV=1 taskkill /F /PID "$$1" >/dev/null 2>&1 || true; } ;; \
	  *) \
	    pids=$$( (command -v lsof >/dev/null && lsof -ti tcp:$(PORT) -s tcp:LISTEN) \
	             || (command -v fuser >/dev/null && fuser $(PORT)/tcp 2>/dev/null) \
	             || true ); \
	    killer() { kill -9 "$$1" >/dev/null 2>&1 || true; } ;; \
	esac; \
	pids=$$(printf '%s\n' $$pids | sort -u | grep -E '^[0-9]+$$' || true); \
	if [ -n "$$pids" ]; then \
		for pid in $$pids; do killer "$$pid"; done; \
		printf '\033[42;30m[OK]\033[0m Killed dashboard on port $(PORT)\n'; \
	else \
		printf '\033[42;30m[OK]\033[0m No dashboard on port $(PORT)\n'; \
	fi

rebuild: stop clean build

clean:
	@$(call spin,Cleaning,rm -rf dist)

audit:
	@npm audit || true

outdated:
	@npm outdated || true

# Pull the local LLM into Ollama. Uses MODEL (defaults to OLLAMA_MODEL from .env).
# If OLLAMA_URL points at a remote daemon, the model is pulled there; else locally.
ollama-pull:
	@command -v ollama >/dev/null 2>&1 || { printf '\033[41;37m[ERROR]\033[0m ollama not found on PATH. Install from https://ollama.com\n'; exit 1; }
	@host="$${OLLAMA_URL:-}"; host="$${host#http://}"; host="$${host#https://}"; host="$${host%/}"; \
	if [ -n "$$host" ]; then \
		export OLLAMA_HOST="$$host"; \
		printf '\033[34m>>>\033[0m Pulling %s on %s ...\n' "$(MODEL)" "$$host"; \
	else \
		printf '\033[34m>>>\033[0m Pulling %s (local Ollama) ...\n' "$(MODEL)"; \
	fi; \
	ollama pull "$(MODEL)" && printf '\033[42;30m[OK]\033[0m Pulled $(MODEL)\n'

# List installed Ollama models (on the remote daemon if OLLAMA_URL is set, else local).
ollama-list:
	@command -v ollama >/dev/null 2>&1 || { printf '\033[41;37m[ERROR]\033[0m ollama not found on PATH. Install from https://ollama.com\n'; exit 1; }
	@host="$${OLLAMA_URL:-}"; host="$${host#http://}"; host="$${host#https://}"; host="$${host%/}"; \
	if [ -n "$$host" ]; then export OLLAMA_HOST="$$host"; printf '\033[34m>>>\033[0m Installed models on %s:\n' "$$host"; \
	else printf '\033[34m>>>\033[0m Installed models (local Ollama):\n'; fi; \
	ollama list

# Delete an Ollama model. With MODEL=name on the command line, removes that model.
# Otherwise lists installed models and prompts you to pick one by number. Confirms
# before deleting (ollama rm is irreversible). Targets the remote daemon if OLLAMA_URL set.
ollama-rm:
	@command -v ollama >/dev/null 2>&1 || { printf '\033[41;37m[ERROR]\033[0m ollama not found on PATH. Install from https://ollama.com\n'; exit 1; }
	@host="$${OLLAMA_URL:-}"; host="$${host#http://}"; host="$${host#https://}"; host="$${host%/}"; \
	[ -n "$$host" ] && export OLLAMA_HOST="$$host" || true; \
	if [ "$(origin MODEL)" = "command line" ]; then \
		target="$(MODEL)"; \
	else \
		models=$$(ollama list | awk 'NR>1 && $$1 != "" {print $$1}'); \
		if [ -z "$$models" ]; then printf '\033[33m>>>\033[0m No models installed%s\n' "$${host:+ on $$host}"; exit 0; fi; \
		printf '\033[34m>>>\033[0m Installed models%s:\n' "$${host:+ on $$host}"; \
		i=0; declare -a arr; \
		while IFS= read -r m; do i=$$((i+1)); arr[$$i]="$$m"; printf '  %2d) %s\n' "$$i" "$$m"; done <<< "$$models"; \
		printf 'Delete which model? [1-%d, q to cancel]: ' "$$i"; \
		read -r choice || true; \
		case "$$choice" in q|Q|'') printf '\033[33m>>>\033[0m Cancelled\n'; exit 0;; esac; \
		target="$${arr[$$choice]:-}"; \
		if [ -z "$$target" ]; then printf '\033[41;37m[ERROR]\033[0m Invalid choice: %s\n' "$$choice"; exit 1; fi; \
	fi; \
	printf '\033[33m>>>\033[0m About to delete: %s%s\n' "$$target" "$${host:+ on $$host}"; \
	read -r -p 'Are you sure? [y/N]: ' ok || true; \
	case "$$ok" in y|Y|yes|YES) ;; *) printf '\033[33m>>>\033[0m Cancelled\n'; exit 0;; esac; \
	ollama rm "$$target" && printf '\033[42;30m[OK]\033[0m Removed %s\n' "$$target"

# -- Docker ------------------------------------------------------------------
# The image holds only the app; the Obsidian vault is bind-mounted at runtime so
# your Markdown stays on the host. The port is published to 127.0.0.1 ONLY, and
# the in-container server binds 0.0.0.0 - so it is reachable from the host but
# never from the network. Ollama on the host is reached via host.docker.internal.

# Ensure the Docker Desktop daemon (desktop-linux context) is up; launch Docker
# Desktop and wait if it isn't. (Pattern from vu-docker-vu/makefile.) We probe the
# pinned context specifically - the machine's default context is a remote daemon
# that is always "up", which would mask a stopped Docker Desktop.
docker-daemon:
	@if $(DOCKER) info >/dev/null 2>&1; then \
		printf '\033[42;30m[OK]\033[0m Docker Desktop ($(DOCKER_CONTEXT)) is running\n'; \
		exit 0; \
	fi; \
	printf '\033[34m>>>\033[0m Docker Desktop not running - starting it...\n'; \
	if [ "$(OS)" = "Windows_NT" ]; then \
		powershell.exe -Command "Start-Process 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'" 2>/dev/null || true; \
	else \
		open -a Docker 2>/dev/null \
			|| sudo systemctl start docker 2>/dev/null \
			|| sudo service docker start 2>/dev/null || true; \
	fi; \
	$(call spin,Starting Docker Desktop ($(DOCKER_CONTEXT)),for i in $$(seq 1 90); do $(DOCKER) info >/dev/null 2>&1 && exit 0; sleep 2; done; printf 'Docker Desktop did not become ready within 180s - start it manually and retry\n' >&2; exit 1)

docker-build: docker-daemon
	@$(call spin,Building image $(DOCKER_IMAGE),$(DOCKER) build -t $(DOCKER_IMAGE) .)

docker-up: env docker-build
	@if [ -z "$(VAULT_MOUNT)" ]; then \
		printf '\033[41;37m[ERROR]\033[0m VAULT_PATH not set in .env - cannot mount the vault\n'; exit 1; \
	fi; \
	$(DOCKER) rm -f $(DOCKER_NAME) >/dev/null 2>&1 || true; \
	MSYS_NO_PATHCONV=1 $(DOCKER) run -d --name $(DOCKER_NAME) \
		-p 127.0.0.1:$(PORT):$(PORT) \
		--env-file .env \
		-e DASHBOARD_HOST=0.0.0.0 \
		-e DASHBOARD_PORT=$(PORT) \
		-e VAULT_PATH=/vault \
		-e OLLAMA_URL="$${OLLAMA_URL:-http://host.docker.internal:11434}" \
		--add-host=host.docker.internal:host-gateway \
		--mount "type=bind,source=$(VAULT_MOUNT),target=/vault" \
		--mount "type=volume,source=career-os-logs,target=/logs" \
		$(DOCKER_IMAGE) >/dev/null \
		&& printf '\033[42;30m[OK]\033[0m $(DOCKER_NAME) running on http://127.0.0.1:$(PORT)  (logs: make docker-logs)\n' \
		|| { printf '\033[41;37m[ERROR]\033[0m docker run failed - check: $(DOCKER) logs $(DOCKER_NAME)\n' >&2; exit 1; }

docker-start: docker-daemon
	@$(DOCKER) start $(DOCKER_NAME) >/dev/null && \
		printf '\033[42;30m[OK]\033[0m Started $(DOCKER_NAME) on http://127.0.0.1:$(PORT)\n'

docker-stop:
	@$(DOCKER) stop $(DOCKER_NAME) >/dev/null 2>&1 && \
		printf '\033[42;30m[OK]\033[0m Stopped $(DOCKER_NAME)\n' || \
		printf '\033[42;30m[OK]\033[0m $(DOCKER_NAME) not running\n'

docker-restart: docker-daemon
	@$(DOCKER) restart $(DOCKER_NAME) >/dev/null && \
		printf '\033[42;30m[OK]\033[0m Restarted $(DOCKER_NAME)\n'

docker-down:
	@$(DOCKER) rm -f $(DOCKER_NAME) >/dev/null 2>&1 && \
		printf '\033[42;30m[OK]\033[0m Removed $(DOCKER_NAME)\n' || \
		printf '\033[42;30m[OK]\033[0m No $(DOCKER_NAME) container\n'

docker-logs: docker-daemon
	@$(DOCKER) logs -f $(DOCKER_NAME)

docker-shell: docker-daemon
	@$(DOCKER) exec -it $(DOCKER_NAME) sh

docker-ps: docker-daemon
	@$(DOCKER) ps -a --filter name=^/$(DOCKER_NAME)$$ --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

docker-rebuild: docker-down docker-build docker-up

# Export the built image as a portable tarball for offline deploy (e.g. to an Unraid
# server) without Docker Hub. Copy career-os-image.tar.gz to the server, then run
# `docker load -i career-os-image.tar.gz`. See deploy/unraid/README.md.
docker-save: docker-build
	@$(DOCKER) save $(DOCKER_IMAGE):latest | gzip > career-os-image.tar.gz && \
		printf '\033[42;30m[OK]\033[0m Saved career-os-image.tar.gz - copy to the server, then: docker load -i career-os-image.tar.gz\n'

# -- Publish to GitHub Container Registry (ghcr.io) --------------------------
# Pushes the same local image that docker-build produces, tagged three ways:
#   :vX.Y.Z  exact version (from git describe)
#   :vX      major, a moving "latest within this major"
#   :latest  newest overall
# Auth uses a GitHub PAT (write:packages scope) supplied as GHPAT in .env and
# piped on stdin, never on the command line. GHUNAME is your GitHub username/org.
login: docker-daemon
	@[ -n "$(GHUNAME)" ] || { printf '\033[41;37m[ERROR]\033[0m GHUNAME not set in .env\n' >&2; exit 1; }; \
	[ -n "$$GHPAT" ]     || { printf '\033[41;37m[ERROR]\033[0m GHPAT not set in .env\n'   >&2; exit 1; }; \
	printf '%s' "$$GHPAT" | $(DOCKER) login ghcr.io -u $(GHUNAME) --password-stdin >/dev/null 2>&1 \
		&& printf '\033[42;30m[OK]\033[0m Logged in to ghcr.io as $(GHUNAME)\n' \
		|| { printf '\033[41;37m[ERROR]\033[0m docker login failed  -- check GHPAT (needs write:packages) in .env\n' >&2; exit 1; }

push: login docker-build
	@$(DOCKER) tag $(DOCKER_IMAGE):latest $(REGISTRY):v$(VERSION); \
	 $(DOCKER) tag $(DOCKER_IMAGE):latest $(REGISTRY):v$(MAJOR); \
	 $(DOCKER) tag $(DOCKER_IMAGE):latest $(REGISTRY):latest
	@$(call spin,Pushing $(REGISTRY) v$(VERSION)/v$(MAJOR)/latest,$(DOCKER) push $(REGISTRY):v$(VERSION) && $(DOCKER) push $(REGISTRY):v$(MAJOR) && $(DOCKER) push $(REGISTRY):latest)
	@printf '\033[42;30m[OK]\033[0m Pushed $(REGISTRY)  -- tags: v$(VERSION), v$(MAJOR), latest\n'