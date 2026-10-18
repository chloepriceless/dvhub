"""Entfernt Python-Pakete samt allem, was nur noch von ihnen gebraucht wird.

Aufruf (im Image, mit dem Python der EOS-venv):
    python -I drop-packages.py bokeh matplotlib python-fasthtml monsterui

Ein Paket fällt mit, wenn ALLE Pakete, die es verlangen, entfernt werden.
Gelöscht werden die Dateien aus dem RECORD jedes Pakets (wie pip uninstall —
die venv hat kein pip). Bricht ab, wenn ein genanntes Paket fehlt.
"""
import importlib.metadata as md
import os
import re
import sys


def norm(name):
    return re.sub(r'[-_.]+', '-', name).lower()


dists = {norm(d.metadata['Name']): d for d in md.distributions()}


def requires(name):
    out = set()
    for r in dists[name].requires or []:
        if 'extra ==' in r:
            continue
        out.add(norm(re.split(r'[ ;<>=!~\[(]', r, maxsplit=1)[0]))
    return out


users = {n: set() for n in dists}
for n in dists:
    for r in requires(n):
        if r in users:
            users[r].add(n)

roots = [norm(a) for a in sys.argv[1:]]
missing = [r for r in roots if r not in dists]
if missing:
    sys.exit(f'drop-packages: nicht installiert: {missing}')

gone = set(roots)
changed = True
while changed:
    changed = False
    for n in dists:
        if n not in gone and users[n] and users[n] <= gone:
            gone.add(n)
            changed = True

total = 0
for n in sorted(gone):
    d = dists[n]
    size = 0
    dirs = set()
    for f in d.files or []:
        p = str(d.locate_file(f))
        try:
            size += os.path.getsize(p)
            os.remove(p)
        except OSError:
            pass
        dirs.add(os.path.dirname(p))
    for dpath in sorted(dirs, key=len, reverse=True):
        try:
            os.removedirs(dpath)          # nur leere Ordner
        except OSError:
            pass
    total += size
    print(f'  entfernt {n:26s} {size / 1e6:6.1f} MB')
print(f'drop-packages: {len(gone)} Pakete, {total / 1e6:.0f} MB')
