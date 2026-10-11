# Deploying Career OS to Unraid (private, no Docker Hub / no Community Apps)

This deploys the container to your Unraid server using a **locally built image** and a
**hand-placed template** — nothing is published to Docker Hub, a public GitHub repo, or
the Unraid Community Apps store.

There are two ways to get the image onto the server. **Pulling from ghcr.io is the
simpler path** and is now the default; the tarball flow below is the offline fallback.

---

## Deploy from ghcr.io (recommended)

1. **Push from the dev machine** (already tagged from `package.json`):
   ```bash
   make push        # → ghcr.io/miaminz/career-os:vX.Y.Z, :vMAJOR, :latest
   ```
2. **Make the package pullable.** It is **private** by default. Either:
   - make it public — GitHub → your avatar → **Packages** → `career-os` → **Package settings**
     → *Change visibility* → **Public** (the image holds app code only — no `.env`, vault, or
     secrets, per `.dockerignore`), **or**
   - log Unraid in (keep it private): on the server,
     `docker login ghcr.io -u miaminz -p <PAT-with-read:packages>`.
3. **Add the container** — Docker tab → **Add Container** (or install the template, step 5 below):
   - **Repository:** `ghcr.io/miaminz/career-os:latest`
     — ⚠️ must be the **full** path. A bare `career-os` resolves to Docker Hub and fails with
     `pull access denied for career-os … repository does not exist`.
   - Set the **Vault** path, **WebUI Port**, and **OLLAMA_URL** as in step 6.
4. **Update later:** `make push` a new version, then in Unraid **Career-OS → Force update**
   (re-pulls `:latest`).

---

## Offline alternative — tarball (no registry)

The flow: build the image on your dev machine → export it to a tarball → copy it to the
server → `docker load` it → drop the template XML in Unraid's user-templates folder →
launch from the Unraid web UI. If you use this route, set the template's **Repository**
back to `career-os:latest` (the local image name).

---

## 1. Build + export the image (dev machine)

From the repo root (Docker Desktop running):

```bash
make docker-save
```

This builds `career-os:latest` and writes **`career-os-image.tar.gz`** (a gzipped
`docker save`). The image is `linux/amd64`, which matches Unraid.

> If your machine is ARM, force amd64 first:
> `docker --context desktop-linux build --platform linux/amd64 -t career-os:latest .`
> then `docker --context desktop-linux save career-os:latest | gzip > career-os-image.tar.gz`

## 2. Copy the tarball to the server

Any method works — SMB share, `scp`, or the Unraid web terminal. e.g.:

```bash
scp career-os-image.tar.gz root@<UNRAID_IP>:/mnt/user/appdata/career-os/
```

## 3. Load the image (on Unraid)

Open the Unraid web terminal (or SSH in) and run:

```bash
docker load -i /mnt/user/appdata/career-os/career-os-image.tar.gz
docker images | grep career-os        # confirm career-os:latest is present
```

Now `career-os:latest` exists locally on the server. The template references that tag, so
Unraid will **not** try to pull from any registry.

## 4. Put your Obsidian vault on the server

The app stores everything in your Obsidian vault (plain Markdown). Put it on a share, e.g.:

```
/mnt/user/appdata/career-os/vault/
```

It must contain the `Career/` folder structure (Profile/, Jobs/, Resume/, …). Copy your
existing vault there, or point the template's **Vault** path at wherever it already lives.

## 5. Install the template

Copy [`career-os.xml`](career-os.xml) to the Unraid user-templates folder, renamed with the
`my-` prefix Unraid expects:

```bash
cp career-os.xml /boot/config/plugins/dockerMan/templates-user/my-Career-OS.xml
```

(That folder is on the Unraid flash drive and persists across reboots.)

## 6. Launch from the web UI

1. **Docker** tab → **Add Container**.
2. **Template** dropdown → under *User templates*, pick **Career-OS**.
3. Review the fields:
   - **WebUI Port** — host port (default `8787`).
   - **Vault (Obsidian)** — set to your vault path from step 4.
   - **OLLAMA_URL** — if you run Ollama, point it at your server. `http://host.docker.internal:11434`
     reaches the Unraid host (the template adds `--add-host=host.docker.internal:host-gateway`).
     If Ollama is another container, use `http://<server-ip>:11434`.
   - **ANTHROPIC_API_KEY** — optional; leave blank for fully local (Ollama) operation.
   - **TZ** — timezone for the daily scheduler (default `Pacific/Auckland`).
4. **Apply**. Unraid creates the container from the local image.
5. Open the dashboard via the container's **WebUI** link → `http://<UNRAID_IP>:8787/`.

---

## Updating later

Rebuild + re-export on the dev machine (`make docker-save`), copy the new tarball over, then
on the server:

```bash
docker load -i career-os-image.tar.gz     # imports the new career-os:latest
```

In the Unraid Docker tab, **Career-OS → Force update** (or stop/remove and re-add from the
template) to recreate the container on the refreshed image.

## Notes

- **"Check for updates" shows *not available*** — expected and cosmetic. There's no registry
  to query for a local image; the container still runs fine.
- **Local-only by design.** The dashboard has no auth. Keep the host port on your LAN only —
  do **not** forward it through your router or put it behind a public reverse proxy.
- **Scheduler state** (`.career-os-state.json`) lives inside the container and resets if the
  container is recreated. The real data (jobs, scores, drafts) is all in the mounted vault, so
  nothing important is lost.
- **Icon** is intentionally blank (no public asset host). To add one, drop a PNG on the server
  and set the template's `<Icon>` to a URL the Unraid host can reach, or edit it in the UI.
