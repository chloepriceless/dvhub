#!/usr/bin/env python3
"""ci-check.py — Stand der GitHub-CI für einen Commit abfragen (und darauf warten).

    scripts/ci-check.py                 # Commit von origin/main, einmal nachsehen
    scripts/ci-check.py --wait 900      # bis zu 15 Minuten auf das Ergebnis warten
    scripts/ci-check.py --wait 900 <sha>

Rückgabe: 0 = grün, 1 = rot, 3 = läuft noch / kein Lauf gefunden, 4 = Abfrage
nicht möglich (kein Zugang, kein Netz).

Anlass (08.10.2026): die CI war eine Woche lang über rund 50 Pushes rot, ohne
dass es jemand merkte — geprüft wurde nur lokal. Dieses Skript ist die eine
Stelle, an der der Stand abgefragt wird: von Hand, aus dem pre-push-Hook
(scripts/git-hooks/) und aus den Claude-Code-Hooks (scripts/ci-hook.py).

Zugang: das GitHub-Token aus dem Git-Zugangsspeicher (`git credential fill`);
es wird weder ausgegeben noch gespeichert. Ohne Token wird ohne Anmeldung
gefragt (reicht für das öffentliche Repo, mit engerem Abfrage-Limit).
"""
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

WORKFLOW = "CI"


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True).stdout.strip()


def repo_slug():
    url = git("config", "--get", "remote.origin.url")
    m = re.search(r"github\.com[:/]+([^/]+/[^/.]+?)(?:\.git)?$", url)
    return m.group(1) if m else None


def token():
    try:
        out = subprocess.run(
            ["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
            capture_output=True, text=True, timeout=10,
            env={**__import__("os").environ, "GIT_TERMINAL_PROMPT": "0"},
        ).stdout
    except Exception:
        return None
    return dict(l.split("=", 1) for l in out.splitlines() if "=" in l).get("password")


def api(path, tok):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "dvhub-ci-check"}
    if tok:
        headers["Authorization"] = "Bearer " + tok
    req = urllib.request.Request("https://api.github.com" + path, headers=headers)
    return json.load(urllib.request.urlopen(req, timeout=30))


def find_run(slug, sha, tok):
    runs = api(f"/repos/{slug}/actions/runs?head_sha={sha}&per_page=20", tok).get("workflow_runs", [])
    runs = [r for r in runs if r.get("name") == WORKFLOW]
    return runs[0] if runs else None


def failed_jobs(slug, run, tok):
    lines = []
    for job in api(f"/repos/{slug}/actions/runs/{run['id']}/jobs?per_page=50", tok).get("jobs", []):
        if job.get("conclusion") in ("success", "skipped", None):
            continue
        steps = [s["name"] for s in job.get("steps", []) if s.get("conclusion") == "failure"]
        lines.append(f"  ✖ {job['name']}" + (f" — Schritt: {', '.join(steps)}" if steps else ""))
    return lines


def check(sha=None, wait_s=0, quiet=False):
    """Gibt (code, text) zurück."""
    slug = repo_slug()
    if not slug:
        return 4, "CI: kein GitHub-Remote 'origin' gefunden."
    if not sha:
        sha = git("rev-parse", "origin/main") or git("rev-parse", "HEAD")
    short = sha[:8]
    tok = token()
    deadline = time.time() + max(0, wait_s)
    run = None
    try:
        while True:
            run = find_run(slug, sha, tok)
            if run and run.get("status") == "completed":
                break
            if time.time() >= deadline:
                break
            if not quiet:
                print(f"CI {short}: {'läuft' if run else 'noch kein Lauf'} …", file=sys.stderr, flush=True)
            time.sleep(20)
    except (urllib.error.URLError, OSError, ValueError) as error:
        return 4, f"CI {short}: Abfrage nicht möglich ({error})."

    if not run:
        return 3, f"CI {short}: kein Lauf gefunden (noch nicht gestartet, oder der Commit ist nicht auf GitHub)."
    if run.get("status") != "completed":
        return 3, f"CI {short}: läuft noch — {run['html_url']}"
    if run.get("conclusion") == "success":
        return 0, f"CI {short}: grün — {run['html_url']}"
    try:
        jobs = failed_jobs(slug, run, tok)
    except Exception:
        jobs = []
    return 1, "\n".join([f"CI {short}: ROT ({run.get('conclusion')}) — {run['html_url']}", *jobs])


def main(argv):
    wait_s = 0
    sha = None
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--wait":
            wait_s = int(args.pop(0))
        elif a in ("-h", "--help"):
            print(__doc__)
            return 0
        else:
            sha = git("rev-parse", a) or a
    code, text = check(sha, wait_s)
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
