---
name: end-work
description: Use when finishing work on a kata-tracked issue in this repo, or when the user invokes /skill:end-work with a kata ref — e.g. "end work on 9t8x", "ship kata 9t8x", "wrap up <ref>". Takes the worktree branch through PR, green checks, squash merge, verified green run on main, then closes the kata and the worktree.
---

# End Work

Argument: optional `<kata-ref>` (short_id like `9t8x`). If omitted, derive it from the current
branch name (`<ref>-<slug>` — you should be inside `.worktrees/<ref>-<slug>`). If it can't be
derived, ask. Run from inside the worktree unless stated otherwise.

## 1. Commit, push, open PR (skip what's done)

```bash
git status --short                                   # commit anything pending
git add -A && git commit -m "<type>(<scope>): <summary> (kata <ref>)"
git push -u origin <branch>
gh pr view --json url 2>/dev/null || gh pr create \
  --title "<type>(<scope>): <summary> (kata <ref>)" \
  --body "kata <ref> — <what + how verified>"
```

The PR title becomes the squash commit message — use the repo's conventional style
(see `git log --oneline main`).

## 2. Wait for green

```bash
gh pr checks --watch --fail-fast
```

Red check → investigate (`gh run view --log-failed`), fix, push; the loop repeats from here.
Never merge red.

## 3. Squash merge

```bash
gh pr merge --squash --delete-branch
```

## 4. Wait for green on main

The check workflow (`.github/workflows/check.yml`) also runs on every push, including
main. Grab the run for the squash-merge commit and watch it to completion:

```bash
sha=$(gh pr view --json mergeCommit -q .mergeCommit.oid)
run_id=$(gh run list --workflow check.yml --commit "$sha" --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$run_id" --exit-status
```

A run that skips because no checkable paths changed counts as success.

## 5. If checks failed

Diagnose (`gh run view <id> --log-failed`), fix forward: from a fresh `git pull`ed main
create a new fix branch off the worktree convention (`<ref>-<slug>-fix` or similar),
commit, push, PR, then repeat steps 2–4 until main is green. Do not close the kata
on a red main.

## 6. Close kata + worktree

Only after main is green:

```bash
kata close <ref> --done --message "<scope + how main was verified>" --commit <squash-sha>
cd <repo-root>   # leave the worktree first
rm -f .worktrees/<ref>-<slug>.lock   # release the liveness lock (see begin-work step 2)
git worktree remove .worktrees/<ref>-<slug>
git branch -D <ref>-<slug>
git pull
```

If handing the worktree off to another session instead of closing, remove the lock at
the handoff so the next session isn't blocked by a stale-looking claim.

## Releasing (optional, separate from the kata)

Publishing is tag-driven and is **not** part of the close gate: `publish.yml` fires on
`v*` tags and ships via npm Trusted Publishing (`npm run check` gates the tag). Bump
the version and tag only when a release is actually intended.
