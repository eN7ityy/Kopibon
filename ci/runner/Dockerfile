# Self-hosted GitHub Actions runner for this project's release builds.
#
# Built on GitHub's official runner image rather than installing the runner
# by hand. That image is maintained and versioned by GitHub, so the runner
# itself, its .NET dependencies and a current git all arrive already correct
# — this file only adds what it is genuinely missing.
#
# Two reasons it cannot be used unmodified:
#
#   1. It defines no ENTRYPOINT (its CMD is just /bin/bash) because it is
#      built for Actions Runner Controller on Kubernetes, where the
#      controller drives config.sh/run.sh. Under plain Docker nothing
#      registers the runner, so entrypoint.sh does it.
#   2. It ships no packaging tools, and this project builds .rpm and .deb.
#
# Build and push once, then deploy ci/runner/docker-compose.yml as a
# Portainer stack:
#
#   docker build -t ghcr.io/en7ityy/doujin-ci-runner:1 ci/runner
#   docker push  ghcr.io/en7ityy/doujin-ci-runner:1

# Pinned for reproducible rebuilds. The runner self-updates in place when
# GitHub requires a newer version, so this only sets the starting point —
# bump it occasionally to keep the base layers patched.
FROM ghcr.io/actions/actions-runner:2.336.0

# The base image ends on USER runner; apt needs root.
USER root

# electron-builder shells out to these for the .rpm and .deb targets.
# Everything else it needs — curl, jq, git, ca-certificates — is already in
# the base image, and Node is not installed anywhere because the workflows
# use actions/setup-node, which fetches its own into the tool cache.
#
# poppler-utils and python3-pikepdf are deliberately absent: those are
# runtime dependencies declared by the packages, not build-time ones.
RUN apt-get update && apt-get install -y --no-install-recommends \
      rpm fakeroot dpkg-dev binutils \
 && rm -rf /var/lib/apt/lists/*

# Created here, owned by runner, so the named volumes in the compose file
# inherit that ownership when Docker first populates them. A volume mounted
# at a path that does not exist in the image is created root-owned, and the
# runner then cannot write to its own workspace.
#
# These are all *below* /home/runner, which is where the base image installs
# the runner itself — so none of them shadow config.sh or run.sh.
RUN mkdir -p /home/runner/_work /home/runner/.npm /home/runner/.cache \
 && chown -R runner:runner /home/runner/_work /home/runner/.npm /home/runner/.cache

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER runner
WORKDIR /home/runner

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
