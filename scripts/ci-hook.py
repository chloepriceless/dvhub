#!/usr/bin/env python3
"""ci-hook.py — Claude-Code-Hooks: nach jedem Push die GitHub-CI abwarten.

Eingebunden in .claude/settings.json (Vorlage: scripts/claude-settings.example.json):

  PostToolUse (Bash)  →  ci-hook.py pushed
      Merkt sich den Commit, wenn der Befehl ein `git push` war.
  Stop                →  ci-hook.py stop
      Wartet auf die CI dieses Commits. Grün: nichts weiter. Rot oder nach der
      Wartezeit noch offen: Ausgabe {"decision": "block", "reason": …} — Claude
      bekommt die Meldung und kann die Arbeit nicht als erledigt abschließen,
      ohne darauf einzugehen.

Jeder Commit wird nur einmal gemeldet (sonst hinge die Sitzung an einer roten
CI fest, die sich gerade nicht beheben lässt). Der Merkzettel liegt unter
.git/ci-watch/ und ist damit nie Teil eines Commits.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location("ci_check", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ci-check.py"))
ci_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_check)

WAIT_S = int(os.environ.get("DVHUB_CI_HOOK_WAIT_S", "780"))


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    out = subprocess.run(["git", "-C", here, "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    return out or os.path.dirname(here)


def watch_dir(root):
    git_dir = subprocess.run(["git", "-C", root, "rev-parse", "--absolute-git-dir"], capture_output=True, text=True).stdout.strip()
    path = os.path.join(git_dir or os.path.join(root, ".git"), "ci-watch")
    os.makedirs(path, exist_ok=True)
    return path


def read_input():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def is_branch_push(command):
    """`git push` eines Zweigs — reine Tag-Pushes lösen keine CI aus."""
    for part in re.split(r"&&|\|\||;|\n", command or ""):
        if not re.search(r"\bgit\b(?:\s+-C\s+\S+)?\s+push\b", part):
            continue
        if re.search(r"refs/tags/|--tags\b|--delete\b|--dry-run\b", part):
            continue
        return True
    return False


def pushed(root):
    data = read_input()
    command = (data.get("tool_input") or {}).get("command", "")
    if not is_branch_push(command):
        return 0
    os.chdir(root)
    sha = ci_check.git("rev-parse", "origin/main")
    if not sha:
        return 0
    with open(os.path.join(watch_dir(root), "pending"), "w") as fh:
        fh.write(sha)
    return 0


def stop(root):
    read_input()
    os.chdir(root)
    wd = watch_dir(root)
    pending_file = os.path.join(wd, "pending")
    if not os.path.exists(pending_file):
        return 0
    sha = open(pending_file).read().strip()
    reported_file = os.path.join(wd, "reported")
    reported = open(reported_file).read().split() if os.path.exists(reported_file) else []
    if not sha or sha in reported:
        return 0
    code, text = ci_check.check(sha, WAIT_S, quiet=True)
    if code == 0:
        os.remove(pending_file)
        return 0
    if code == 4:
        # Kein Netz / kein Zugang: nicht blockieren, beim nächsten Mal erneut versuchen.
        return 0
    with open(reported_file, "a") as fh:
        fh.write(sha + "\n")
    hint = (
        "Die GitHub-CI für den zuletzt gepushten Commit ist nicht grün. Bitte die Ursache klären und beheben "
        "(Job-Logs über die API, siehe scripts/ci-check.py) oder klar melden, dass die CI rot ist und warum."
        if code == 1 else
        "Die GitHub-CI für den zuletzt gepushten Commit ist nach der Wartezeit noch nicht fertig. "
        "Bitte mit `python3 scripts/ci-check.py --wait 600` nachsehen, bevor die Arbeit als erledigt gilt."
    )
    # Stop-Hook: mit {"decision": "block"} bleibt die Sitzung offen und Claude
    # bekommt den Text als Grund (Rückgabe 0, Ausgabe als JSON auf stdout).
    print(json.dumps({"decision": "block", "reason": text + "\n" + hint}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    root = repo_root()
    try:
        sys.exit(pushed(root) if mode == "pushed" else stop(root) if mode == "stop" else 0)
    except Exception as error:  # ein kaputter Hook darf die Sitzung nie aufhalten
        print(f"ci-hook: {error}", file=sys.stderr)
        sys.exit(0)
