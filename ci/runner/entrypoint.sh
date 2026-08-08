#!/usr/bin/env bash
#
# Registers the runner with GitHub, then hands off to it.
#
# A registration token is minted from a PAT on every start rather than being
# supplied directly, because registration tokens expire after about an hour —
# supplying one directly makes the stack undeployable after the first restart,
# which is exactly when you least want to go hunting for a fresh token.
set -euo pipefail

# Where the official base image installs the runner (its WORKDIR).
cd /home/runner

: "${GITHUB_REPO:?set GITHUB_REPO, e.g. eN7ityy/Kopibon}"
: "${GITHUB_PAT:?set GITHUB_PAT (needs permission to manage self-hosted runners)}"

echo "Requesting a registration token for ${GITHUB_REPO}..."

# The status is captured rather than using `curl -f`, because -f aborts the
# pipeline before the body can be read and reports only `curl: (22) ... 401`
# — which does not say whether the token is wrong, expired, or merely
# missing a permission. Every one of those is a five-second fix once named.
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

STATUS="$(curl -sSL -o "$BODY" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${GITHUB_REPO}/actions/runners/registration-token")"

if [ "$STATUS" != "201" ]; then
  echo "" >&2
  echo "GitHub refused the registration-token request (HTTP ${STATUS})." >&2
  case "$STATUS" in
    401) echo "  The PAT is invalid, expired, or was pasted with whitespace." >&2 ;;
    403) echo "  The PAT is valid but may not manage self-hosted runners." >&2
         echo "  Classic: needs 'repo'. Fine-grained: Administration = Read and write." >&2 ;;
    404) echo "  Either GITHUB_REPO is wrong, or the PAT cannot see this repo." >&2
         echo "  A fine-grained PAT scoped to other repositories reports 404, not 403." >&2 ;;
  esac
  echo "  GitHub said: $(jq -r '.message // "(no message)"' "$BODY" 2>/dev/null)" >&2
  exit 1
fi

REG_TOKEN="$(jq -er .token < "$BODY")"

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
