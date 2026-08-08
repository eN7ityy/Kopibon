#!/usr/bin/env bash
#
# Registers the runner with GitHub, then hands off to it.
#
# A registration token is minted from a PAT on every start rather than being
# supplied directly, because registration tokens expire after about an hour —
# supplying one directly makes the stack undeployable after the first restart,
# which is exactly when you least want to go hunting for a fresh token.
set -euo pipefail

cd /opt/actions-runner

: "${GITHUB_REPO:?set GITHUB_REPO, e.g. eN7ityy/Doujinshi-Downloader}"
: "${GITHUB_PAT:?set GITHUB_PAT (needs permission to manage self-hosted runners)}"

echo "Requesting a registration token for ${GITHUB_REPO}..."
REG_TOKEN="$(curl -fsSL -X POST \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${GITHUB_REPO}/actions/runners/registration-token" \
  | jq -er .token)"

# --replace so restarting the stack takes over the existing registration
# instead of failing on a duplicate name. --unattended so a prompt can never
# wedge the container waiting on stdin nobody is attached to.
./config.sh --unattended --replace \
  --url "https://github.com/${GITHUB_REPO}" \
  --token "${REG_TOKEN}" \
  --name "${RUNNER_NAME:-doujin-builder-01}" \
  --labels "${RUNNER_LABELS:-linux,doujin-builder}" \
  --work /home/runner/_work

# exec so run.sh becomes PID 1 and receives SIGTERM directly — it drains the
# current job before exiting, which is what stop_grace_period is there for.
exec ./run.sh
