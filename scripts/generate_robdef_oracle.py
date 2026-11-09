#!/usr/bin/env python3
"""Dump how the reference Core parser reads the test robdefs, for comparison with the TypeScript parser."""
import glob
import json
import os

import RobotRaconteur.RobotRaconteurPython as RRPy

ROOT = os.path.join(os.path.dirname(__file__), "..")


def entry(e):
    return {
        "name": e.Name,
        "implements": list(e.Implements),
        "options": list(e.Options),
        "constants": [c.ToString() for c in e.Constants],
        "members": [m.ToString() for m in e.Members],
    }


out = {}
for path in sorted(glob.glob(os.path.join(ROOT, "test/robdef/*.robdef"))):
    with open(path) as f:
        d = RRPy.ServiceDefinition()
        d.FromString(f.read())
    out[os.path.basename(path)] = {
        "name": d.Name,
        "imports": list(d.Imports),
        "options": list(d.Options),
        "using": [[u.QualifiedName, u.UnqualifiedName] for u in d.Using],
        "constants": [c.ToString() for c in d.Constants],
        "exceptions": [e.Name for e in d.Exceptions],
        "enums": [{"name": e.Name, "values": [[v.Name, v.Value] for v in e.Values]} for e in d.Enums],
        "structures": [entry(e) for e in d.Structures],
        "pods": [entry(e) for e in d.Pods],
        "namedArrays": [entry(e) for e in d.NamedArrays],
        "objects": [entry(e) for e in d.Objects],
    }

with open(os.path.join(ROOT, "test/fixtures/robdef_oracle.json"), "w") as f:
    json.dump(out, f, indent=1, sort_keys=True)
    f.write("\n")
