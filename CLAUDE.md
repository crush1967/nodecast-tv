# CLAUDE.md

Instructions for any Claude Code session (cloud/remote or local) working in this repository.

## Read this first if you're a cloud/remote session

If you are running in a cloud/remote execution environment (not on the
user's own PC), **you have no access whatsoever to the user's actual running
NodeCast TV instance.** You can only read/edit/commit/push files in this git
checkout and interact with GitHub. Nothing you do here automatically reaches
the user's PC. Do not imply otherwise, and do not guess about the user's
local setup — verify or ask.

This exact confusion (a cloud session assuming it shares a filesystem with
the user's PC, or that pushing to GitHub deploys anywhere) has already
caused one extremely long, frustrating conversation with this user. Do not
repeat it. Specifically:

- If asked "is the fix live / loaded / working," do not answer for the
  user's PC — you cannot know that from here. Say so plainly, once, without
  re-explaining the cloud/local distinction over and over.
- If you need to know what's on the user's PC, ask for a screenshot or a
  copy-pasted file listing/content. Don't ask abstract yes/no questions
  about "how does it deploy" repeatedly — ask for one concrete, visual thing
  at a time (a folder listing, a file's contents).
- Prove claims about "which machine you're on" with hard evidence
  (`hostname`, `uname -a`, whether expected user files exist) before
  asserting them, and lead with that evidence rather than argument.
- The user does not want to type git commands ("I don't do git pull or any
  of that"). Don't instruct them to run git commands directly. If an update
  mechanism is needed, prefer a double-clickable `.bat` file already staged
  in the repo (see below) over spoken/typed commands.

## Actual deployment (as of this writing)

- The user's real, running instance lives on their own Windows PC, at
  `C:\Users\CRush\Documents\nodecast-tv`. It is a real git clone (`.git`
  exists there) of `crush1967/nodecast-tv` on GitHub.
- It runs as a **Windows background service** (see `service.log`,
  `start-nodecast-service.bat`, `start-service-task.ps1` in that folder) —
  not a visible terminal window, not (as far as confirmed) Docker. A
  service has no window/taskbar presence at all, which is expected and not
  a sign anything is broken.
- The repo's own root `docker-compose.yml` template points at
  `ghcr.io/technomancer702/nodecast-tv` (the upstream project this was
  forked from), NOT this fork's own image. If Docker is ever used for real
  deployment here, that image reference needs to point at
  `crush1967/nodecast-tv` instead, or it will never receive fixes made in
  this repo.
- `GET /api/version` (also mirrored on-page as a small `vN.N.N` label next
  to the "Recordings" heading, added for exactly this reason) reflects
  `package.json`'s `version` field. Bump this version on any fix intended to
  be checkable by the user, so they have a simple, single visible number to
  compare instead of needing to inspect file contents or dev tools. Note it
  requires an actual process restart to update (Node caches
  `require('../package.json')` for the life of the process) — unlike plain
  static frontend files under `public/`, which `express.static` reads fresh
  off disk on every request (see the `Cache-Control: no-cache` handling in
  `server/index.js`) and therefore need no restart, just a browser refresh.
- `update-nodecast.bat` (repo root) is a plain double-click helper that runs
  `git pull origin main` from wherever it's placed, then pauses so the
  output is visible. It intentionally does NOT restart the service — the
  user already has an existing, working way to do that
  (`start-nodecast-service.bat` et al.), and a cloud session should not
  guess at unfamiliar service-restart mechanics it hasn't actually seen.
