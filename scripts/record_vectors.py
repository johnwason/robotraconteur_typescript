#!/usr/bin/env python3
"""Record the operations performed by the Core Python test client against the Core Python test
server, so that the TypeScript client can replay them. The server checks the values it is sent and
the recorded responses are the values the reference client received."""
import json
import os
import subprocess
import sys
import time

import numpy as np

CORE = os.environ["RR_CORE_TEST"]
ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(CORE, "python"))
sys.dont_write_bytecode = True

import RobotRaconteur as RR  # noqa: E402
import RobotRaconteur.Client  # noqa: E402,F401  Initializes the client node transports
from RobotRaconteur import RobotRaconteurPythonUtil as RRU  # noqa: E402
from RobotRaconteurTest import ServiceTestClient as stc  # noqa: E402
from RobotRaconteurTest import ServiceTestClient2 as stc2  # noqa: E402

PORT = 22223


def encode_nd(a):
    if a.dtype.fields is not None:
        return {"$sa": {"shape": list(a.shape), "items": [encode_void(x) for x in a.flatten("F")]}}
    flat = a.flatten("F")
    if np.iscomplexobj(flat):
        data = [float(y) for x in flat for y in (x.real, x.imag)]
    elif flat.dtype.kind == "b":
        data = [bool(x) for x in flat]
    elif flat.dtype.kind == "f":
        data = [float(x) for x in flat]
    else:
        data = [str(int(x)) for x in flat]
    return {"$nd": {"shape": list(a.shape), "data": data}}


def encode_void(x):
    fields = x.dtype.fields
    if fields is None:
        raise TypeError("Expected structured value")
    if x.dtype.names == ("len", "array"):
        return encode_nd(x["array"][: int(x["len"])])
    return {n: encode(x[n]) for n in x.dtype.names}


def encode(v):
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, np.void):
        if v.dtype.names == ("len", "array"):
            return encode_void(v)
        return encode_nd(np.array([v], dtype=v.dtype))
    if isinstance(v, np.ndarray):
        return encode_nd(v)
    if isinstance(v, np.generic):
        return encode(v.item())
    if isinstance(v, int):
        return {"$i": str(v)}
    if isinstance(v, float):
        return v
    if isinstance(v, complex):
        return {"$c": [v.real, v.imag]}
    if isinstance(v, RR.VarValue):
        return {"$var": {"type": v.datatype, "data": encode(v.data)}}
    if isinstance(v, (list, tuple)):
        return {"$list": [encode(x) for x in v]}
    if isinstance(v, dict):
        return {"$map": [[(k if isinstance(k, str) else int(k)), encode(x)] for k, x in v.items()]}
    if isinstance(v, bytearray):
        return encode_nd(np.frombuffer(v, dtype=np.uint8))
    if type(v).__module__.endswith("RobotRaconteurPythonUtil"):
        return {"$struct": {k: encode(getattr(v, k)) for k in dir(v) if not k.startswith("_") and not callable(getattr(v, k))}}
    raise TypeError("Cannot encode " + repr(type(v)))


def is_member_object(v):
    return type(v).__name__.endswith(("Client", "Connection", "Pipe", "Wire"))


class Recorder:
    def __init__(self, path, log):
        self.path = path
        self.log = log


class Proxy:
    def __init__(self, target, recorder):
        object.__setattr__(self, "_t", target)
        object.__setattr__(self, "_r", recorder)

    def __getattr__(self, name):
        t = object.__getattribute__(self, "_t")
        r = object.__getattribute__(self, "_r")
        if name.startswith("get_") and callable(getattr(t, name, None)):
            method = getattr(t, name)

            def objref(*args):
                index = list(args)
                return Proxy(method(*args), Recorder(r.path + [[name[4:]] + index], r.log))
            return objref
        try:
            v = getattr(t, name)
        except Exception as e:
            r.log.append({"path": r.path, "op": "get", "name": name, "error": str(getattr(e, "errorname", type(e).__name__))})
            raise
        if is_member_object(v) or name.startswith(("async_", "rr", "Async")):
            return v
        if callable(v):
            def call(*args):
                try:
                    ret = v(*args)
                except Exception as e:
                    r.log.append({"path": r.path, "op": "call", "name": name, "args": [encode(a) for a in args], "error": str(getattr(e, "errorname", type(e).__name__))})
                    raise
                r.log.append({"path": r.path, "op": "call", "name": name, "args": [encode(a) for a in args], "value": encode(ret)})
                return ret
            return call
        r.log.append({"path": r.path, "op": "get", "name": name, "value": encode(v)})
        return v

    def __setattr__(self, name, value):
        t = object.__getattribute__(self, "_t")
        r = object.__getattribute__(self, "_r")
        try:
            setattr(t, name, value)
        except Exception as e:
            r.log.append({"path": r.path, "op": "set", "name": name, "value": encode(value), "error": str(getattr(e, "errorname", type(e).__name__))})
            raise
        r.log.append({"path": r.path, "op": "set", "name": name, "value": encode(value)})


class Unwrap:
    def __init__(self, node):
        self._node = node

    def __getattr__(self, name):
        v = getattr(self._node, name)
        if not callable(v):
            return v

        def call(*args):
            return v(*[object.__getattribute__(a, "_t") if isinstance(a, Proxy) else a for a in args])
        return call


def record(module, client_cls, service, tests):
    module.RRN = Unwrap(RR.RobotRaconteurNode.s)
    c = client_cls()
    c.ConnectService(f"rr+tcp://localhost:{PORT}?service={service}")
    log = []
    c._r = Proxy(c._r, Recorder([], log))
    out = {}
    for test in tests:
        del log[:]
        print("Recording", test, flush=True)
        getattr(c, test)()
        out[test] = list(log)
    c._r = object.__getattribute__(c._r, "_t")
    c.DisconnectService()
    return out


def main():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    server = subprocess.Popen([sys.executable, "-u", "-m", "RobotRaconteurTest.test_server"], cwd=os.path.join(CORE, "python"), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        for line in server.stdout:
            if "Server ready" in line:
                break
        time.sleep(0.5)
        RR.RobotRaconteurNode.s.RequestTimeout = 30
        vectors = {
            "RobotRaconteurTestService": record(stc, stc.ServiceTestClient, "RobotRaconteurTestService", ["TestProperties", "TestFunctions", "TestObjRefs"]),
            "RobotRaconteurTestService2": record(stc2, stc2.ServiceTestClient2, "RobotRaconteurTestService2", ["TestEnums", "TestPods", "TestNamedArrays", "TestComplex", "TestBools"]),
        }
        with open(os.path.join(ROOT, "test/fixtures/recorded_vectors.json"), "w") as f:
            json.dump(vectors, f, allow_nan=False, separators=(",", ":"))
    finally:
        server.kill()


if __name__ == "__main__":
    main()
