# Self-hosted GitHub Actions runner for this project's release builds.
#
# Deliberately a first-party image rather than a third-party one: this
# container receives a token that can publish releases, and 30 readable lines
# are easier to audit than someone else's entrypoint.
#
# Build and push once, then deploy ci/runner/docker-compose.yml as a
# Portainer stack:
#
#   docker build -t ghcr.io/en7ityy/doujin-ci-runner:1 ci/runner
#   docker push  ghcr.io/en7ityy/doujin-ci-runner:1

FROM ubuntu:24.04

# Bump as needed — https://github.com/actions/runner/releases
# The runner self-updates in place, so this only sets the starting point.
ARG RUNNER_VERSION=2.321.0
ARG DEBIAN_FRONTEND=noninteractive

# Node is NOT installed here: the workflows use actions/setup-node, which
# downloads its own copy into the tool cache. Only curl/tar are needed for
# that to work.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq tar unzip xz-utils zstd \
      # electron-builder's .rpm and .deb targets shell out to these.
      # poppler-utils and python3-pikepdf are deliberately absent — they are
      # runtime dependencies declared in the packages, not build-time ones.
      rpm fakeroot dpkg-dev binutils \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash runner

# The runner install lives outside $HOME so the cache volumes can mount into
# /home/runner without shadowing it.
RUN mkdir -p /opt/actions-runner && cd /opt/actions-runner \
 && curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && tar xzf runner.tar.gz \
 && rm runner.tar.gz \
 && ./bin/installdependencies.sh \
 && chown -R runner:runner /opt/actions-runner

# Created here, owned by runner, so the named volumes inherit that ownership
# when Docker first populates them. Without this they are created root-owned
# and the runner cannot write to its own workspace.
RUN mkdir -p /home/runner/_work /home/runner/.npm /home/runner/.cache \
 && chown -R runner:runner /home/runner

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# run.sh refuses to start as root unless RUNNER_ALLOW_RUNASROOT is set, and
# there is no reason to grant it that.
USER runner
WORKDIR /opt/actions-runner

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
