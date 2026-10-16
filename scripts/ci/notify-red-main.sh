#!/usr/bin/env bash
set -euo pipefail

title="main is red: ${RUN_NAME}"
existing_issue="$(gh issue list --state open --search "${title} in:title" --limit 1 --json number --jq '.[0].number')"

if [ -n "${existing_issue}" ]; then
  gh issue comment "${existing_issue}" --body "New failing run on main: ${RUN_URL}"
else
  gh issue create --title "${title}" --body "The ${RUN_NAME} workflow failed on main.

Failing run: ${RUN_URL}
"
fi
