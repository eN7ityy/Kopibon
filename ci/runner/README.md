# Self-hosted runner: deployment

The release workflows (`release.yml`, `test.yml`) target
`runs-on: [self-hosted, linux, doujin-builder]`. Until a runner carrying
those labels is online, those workflows queue forever rather than failing,
so nothing will look broken. It will just silently never run.

This directory builds that runner as a container. It is designed to be
disposable: all persistent state lives in three named volumes, and the
runner re-registers itself on every start. If it misbehaves, delete the
stack and redeploy. Nothing is lost except the build cache.

## Before you start

**Check free disk on the Docker host.** Named volumes live under
`/var/lib/docker/volumes`. A release build pulls the full npm tree plus
Electron (~100 MB on its own) and then writes an AppImage, a `.deb` and an
`.rpm`. Budget **10 GB**; a host with a small root partition will fail
partway through packaging, which reads as a confusing build error rather
than an out-of-space one.

```bash
df -h /var/lib/docker
```

**Mint a PAT** that may manage self-hosted runners on this repository:

- *Classic* → `repo` scope
- *Fine-grained* → this repository only, **Administration: Read and write**

This is the only secret involved, and it is used for exactly one API call:
exchanging it for a registration token at container start. Registration
tokens expire after an hour, which is why one is minted per start rather
than supplied directly. See `entrypoint.sh`.

Note that the PAT is *not* what builds anything. Workflows authenticate
with `GITHUB_TOKEN`, which GitHub mints per job and injects automatically,
so checkout and release publishing never touch this token and it is never
exposed to workflow code. It needs no `workflow` scope and no package
permissions.

**Set a calendar reminder for the expiry date.** Because registration
happens on every start, an expired PAT does not stop a running container. It
stops the *next* redeploy, months later, with the runner simply never
coming back. Fine-grained tokens expire within a year at most. The log
line for this is `HTTP 401`. The fix is a new token in the stack variable.

## 1. Build the image on the Docker host

Portainer's web-editor stacks have no build context and cannot build a
Dockerfile. Building on the host itself sidesteps that, and means no
registry is involved anywhere.

```bash
ssh <your-ubuntu-host>
git clone git@github.com:eN7ityy/Doujinshi-Downloader.git
cd Doujinshi-Downloader
docker build -t doujin-ci-runner:1 ci/runner
```

Only `ci/runner/` is used as the build context. The clone is just a
convenient way to get those three files onto the host. `scp -r ci/runner`
works equally well if you would rather not clone a repo there.

## 2. Deploy the stack in Portainer

**Stacks → Add stack → Web editor.** Paste the contents of
`docker-compose.yml`, then add one environment variable:

| Name         | Value        |
| ------------ | ------------ |
| `GITHUB_PAT` | *your token* |

Setting it as a stack variable rather than editing it into the compose
text keeps the token out of the stack definition Portainer stores.

**Leave "Pull latest image" off.** The image reference is unqualified, so
a forced pull would go looking on Docker Hub for something that only
exists in the local image store.

Deploy.

## 3. Confirm it registered

GitHub → **Settings → Actions → Runners**. Within a few seconds
`doujin-builder-01` should appear as **Idle**, labelled `self-hosted`,
`linux`, `doujin-builder`.

If it does not, check the container logs. Portainer's log view is
enough, and the entrypoint names the specific cause rather than leaving
you with an HTTP code:

| Log line                    | Fix                                                      |
| --------------------------- | -------------------------------------------------------- |
| `HTTP 401` / Bad credentials | Token invalid, expired, or pasted with stray whitespace  |
| `HTTP 403`                  | Token valid but lacks runner administration rights        |
| `HTTP 404`                   | `GITHUB_REPO` wrong, or a fine-grained PAT scoped to other repositories; GitHub reports those as 404, not 403 |

Note that credentials are checked before repository existence, so a bad
token reports 401 even when the repository name is also wrong. Fix the
token first, then re-read the error.

## 4. Prove it actually builds

Push any commit to `test`. That triggers `test.yml`, which should produce
a `v1.0.1-beta.<n>` **pre-release** carrying four artifacts: the AppImage,
the `.rpm`, the `.deb`, and `latest-linux.yml`.

Do this before trusting the pipeline with a real tag. The first build is
also the slowest by a wide margin. The caches are cold, so it downloads
the full dependency tree and Electron once.

## Operating notes

**Restarting is safe.** `config.sh --replace` takes over the existing
registration rather than colliding with it, so a redeploy does not leave a
stale offline runner behind in the GitHub UI.

**Stopping mid-build is safe.** `run.sh` is PID 1 and receives `SIGTERM`
directly, and `stop_grace_period: 5m` gives it room to finish the job in
flight instead of being killed halfway through writing an artifact.

**The Docker socket is deliberately not mounted.** The base image ships a
Docker CLI, but no workflow here needs it, and mounting the socket would
hand anything running in a workflow full root on the host.

**Runner updates handle themselves.** The version pinned in the Dockerfile
is only a starting point. The runner self-updates in place when GitHub
requires a newer one. Rebuilding occasionally is still worth doing to pick
up base-image security patches.
