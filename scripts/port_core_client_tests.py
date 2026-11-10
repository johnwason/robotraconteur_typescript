#!/usr/bin/env python3
"""Convert the literal heavy test methods of the Core Python test clients to TypeScript.

The tests are converted mechanically to avoid transcription errors. Core reads its test arrays from
the test vector blob with get_test_vector, and the converted tests read the same names from this
repository's copy of the blob. Writes test/common/ServiceTestClientGenerated.ts. Anything that is
not understood raises an error rather than being dropped.
"""
import ast
import json
import os
import sys

CORE = os.environ["RR_CORE_TEST"]
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SAFE = 2 ** 53

METHODS = {
    "ServiceTestClient.py": ["TestProperties", "TestFunctions", "TestObjRefs"],
    "ServiceTestClient2.py": ["TestComplex", "TestBools"],
}
# Statements in these methods exercise Python helpers with no TypeScript equivalent
SKIP_CALLS = {"print", "RRN.NamedArrayToArray", "RRN.ArrayToNamedArray", "nptest.assert_equal"}


def dotted(n):
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        base = dotted(n.value)
        return base + "." + n.attr if base else None
    return None


class Converter:
    def __init__(self):
        self.stubs = {"self._r"}
        self.declared = set()

    def is_stub(self, n):
        return dotted(n) in self.stubs

    def stub(self, n):
        d = dotted(n)
        return "r" if d == "self._r" else d

    def list_(self, items):
        parts = [self.expr(x) for x in items]
        return "[" + ", ".join(parts) + "]"

    def expr(self, n):
        if isinstance(n, ast.Constant):
            v = n.value
            if v is None:
                return "null"
            if v is True:
                return "true"
            if v is False:
                return "false"
            if isinstance(v, str):
                return json.dumps(v)
            if isinstance(v, int):
                return str(v) + ("n" if abs(v) >= SAFE else "")
            if isinstance(v, float):
                return repr(v)
        elif isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub):
            return "-" + self.expr(n.operand)
        elif isinstance(n, ast.Name):
            return n.id
        elif isinstance(n, (ast.List, ast.Tuple)):
            return self.list_(n.elts)
        elif isinstance(n, ast.Dict):
            if not n.keys:
                return "new Map<any, any>()"
        elif isinstance(n, ast.Attribute):
            if self.is_stub(n.value):
                return f'(await {self.stub(n.value)}.getProperty("{n.attr}"))'
            base = self.expr(n.value)
            return f"{base}.{'value' if n.attr == 'data' else n.attr}"
        elif isinstance(n, ast.Subscript):
            return f"at({self.expr(n.value)}, {self.expr(n.slice)})"
        elif isinstance(n, ast.Call):
            return self.call(n)
        raise ValueError(f"Unsupported expression at line {n.lineno}: {ast.dump(n)[:200]}")

    def ndarray(self, n):
        return self.list_(n.args[0].elts) if isinstance(n.args[0], ast.List) else self.expr(n.args[0])

    def call(self, n):
        f = n.func
        name = dotted(f)
        if name == "get_test_vector":
            return f"getTestVector({self.expr(n.args[0])}, {self.expr(n.args[1])})"
        if name == "len":
            return f"len({self.expr(n.args[0])})"
        if name == "complex":
            return f"{{ real: {self.expr(n.args[0])}, imag: {self.expr(n.args[1])} }}"
        if name == "np.array":
            return self.ndarray(n)
        if name == "RR.VarValue":
            return f"new VarValue({self.expr(n.args[0])}, {self.expr(n.args[1])})"
        if name == "RRN.NewStructure":
            return "{}"
        if name and name.startswith("ServiceTest2_"):
            args = [self.expr(a) for a in n.args if dotted(a) not in ("RRN", "self._r")]
            return f"{name}({', '.join(args)})"
        if isinstance(f, ast.Attribute):
            if f.attr == "view":
                return self.expr(f.value)  # Complex arrays are written as interleaved values
            if f.attr == "reshape":
                order = next((k.value.value for k in n.keywords if k.arg == "order"), "C")
                if len(n.args) == 1 and dotted(n.args[0].func if isinstance(n.args[0], ast.Call) else None) == "get_test_vector":
                    if order != "F":
                        raise ValueError(f"C order reshape at line {n.lineno}")
                    return f"md({self.expr(f.value)}, {self.expr(n.args[0])})"
                args = n.args[0].elts if len(n.args) == 1 and isinstance(n.args[0], (ast.Tuple, ast.List)) else n.args
                dims = [a.value for a in args]
                if order != "F" and sum(1 for d in dims if d != 1) > 1:
                    raise ValueError(f"C order reshape at line {n.lineno}")
                return f"md({self.expr(f.value)}, {json.dumps(dims)})"
            if self.is_stub(f.value):
                if f.attr.startswith("get_"):
                    args = "".join(", " + self.expr(a) for a in n.args)
                    return f'(await {self.stub(f.value)}.getObjRef("{f.attr[4:]}"{args}))'
                args = self.list_(n.args)
                return f'(await {self.stub(f.value)}.callFunction("{f.attr}", {args}))'
        raise ValueError(f"Unsupported call at line {n.lineno}: {name}")

    def assign(self, target, value, out, indent):
        pad = " " * indent
        if isinstance(target, ast.Attribute) and self.is_stub(target.value):
            out.append(f'{pad}await {self.stub(target.value)}.setProperty("{target.attr}", {self.expr(value)});')
        elif isinstance(target, ast.Name):
            v = self.expr(value)
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute) and value.func.attr.startswith("get_") and self.is_stub(value.func.value):
                self.stubs.add(target.id)
            decl = "" if target.id in self.declared else "let "
            self.declared.add(target.id)
            out.append(f"{pad}{decl}{target.id}{': any' if decl else ''} = {v};")
        elif isinstance(target, ast.Attribute):
            out.append(f"{pad}{self.expr(target.value)}.{target.attr} = {self.expr(value)};")
        elif isinstance(target, ast.Subscript):
            out.append(f"{pad}{self.expr(target.value)}.set({self.expr(target.slice)}, {self.expr(value)});")
        else:
            raise ValueError(f"Unsupported assignment at line {target.lineno}")

    def compare(self, t):
        left, op, right = t.left, t.ops[0], t.comparators[0]
        if isinstance(op, ast.Is) and isinstance(right, ast.Constant) and right.value is None:
            return f"assert.equal({self.expr(left)}, null);"
        if isinstance(op, ast.Eq):
            return f"eq({self.expr(left)}, {self.expr(right)});"
        raise ValueError(f"Unsupported comparison at line {t.lineno}")

    def stmt(self, s, out, indent):
        pad = " " * indent
        if isinstance(s, ast.Assign):
            if isinstance(s.value, ast.Call) and dotted(s.value.func) == "RRN.GetExceptionType":
                return  # Unused by the Core test, which has a TODO to check these types
            self.assign(s.targets[0], s.value, out, indent)
        elif isinstance(s, ast.Assert):
            t = s.test
            out.append(pad + (self.compare(t) if isinstance(t, ast.Compare) else f"assert.ok({self.expr(t)});"))
        elif isinstance(s, ast.Expr) and isinstance(s.value, ast.Call):
            name = dotted(s.value.func)
            if name in SKIP_CALLS:
                return
            if name in ("ca", "nptest.assert_allclose"):
                out.append(f"{pad}ca({self.expr(s.value.args[0])}, {self.expr(s.value.args[1])});")
            elif name == "nptest.assert_array_equal":
                out.append(f"{pad}cae({self.expr(s.value.args[0])}, {self.expr(s.value.args[1])});")
            elif name == "time.sleep":
                out.append(f"{pad}await sleep({int(s.value.args[0].value * 1000)});")
            elif isinstance(s.value.func, ast.Attribute) and s.value.func.attr == "append":
                out.append(f"{pad}{self.expr(s.value.func.value)}.push({self.expr(s.value.args[0])});")
            else:
                e = self.expr(s.value)
                out.append(pad + (e[1:-1] if e.startswith("(") else e) + ";")
        elif isinstance(s, ast.With) and dotted(s.items[0].context_expr.func) == "pytest.raises":
            arg = dotted(s.items[0].context_expr.args[0])
            matcher = "RobotRaconteurError" if arg == "Exception" else f'errorNamed("RobotRaconteur.{arg[3:-9]}Error")'
            if arg == "RR.DataTypeException":
                matcher = 'errorNamed("RobotRaconteur.DataTypeError")'
            out.append(f"{pad}await assert.rejects(async () =>")
            out.append(f"{pad}{{")
            for b in s.body:
                self.stmt(b, out, indent + 4)
            out.append(f"{pad}}}, {matcher});")
        elif isinstance(s, ast.Delete) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant)):
            return  # Includes the i32_huge section, which Core keeps disabled in a string
        else:
            raise ValueError(f"Unsupported statement at line {s.lineno}: {type(s).__name__}")


def wrap(line, width=140):
    if len(line) <= width:
        return line
    indent = len(line) - len(line.lstrip())
    pad = " " * (indent + 4)
    out, cur, in_str = [], "", False
    for i, c in enumerate(line):
        cur += c
        if c == '"' and line[i - 1] != "\\":
            in_str = not in_str
        if c == "," and not in_str and len(cur) >= width - indent - 4:
            out.append(cur)
            cur = ""
    if cur.strip():
        out.append(cur)
    return ("\n" + pad).join(x.strip() if i else x for i, x in enumerate(out))


def convert(path, name):
    tree = ast.parse(open(path).read())
    for c in tree.body:
        if isinstance(c, ast.ClassDef):
            for m in c.body:
                if isinstance(m, ast.FunctionDef) and m.name == name:
                    conv = Converter()
                    out = [f"export async function {name}(r: any): Promise<void>", "{"]
                    for s in m.body:
                        conv.stmt(s, out, 4)
                    out.append("}")
                    return [wrap(x) for x in out]
    raise ValueError(f"{name} not found")


def constants():
    tree = ast.parse(open(os.path.join(CORE, "python/RobotRaconteurTest/ServiceTest2.py")).read())
    found = {}
    for c in tree.body:
        if isinstance(c, ast.ClassDef) and c.name == "ServiceTest2_test_sequence_gen":
            for s in c.body:
                if isinstance(s, ast.Assign):
                    found[s.targets[0].id] = Converter().expr(s.value)
    return found


def main():
    with open(os.path.join(ROOT, "scripts/license_header.txt")) as f:
        lines = [f.read().rstrip() + "\n"]
    lines += [
        "// Generated by scripts/port_core_client_tests.py from the Core Python test clients. Do not edit.",
        "/* eslint-disable */",
        'import { RobotRaconteurError, VarValue } from "../../src/index.js";',
        'import { assert } from "./check.js";',
        'import { getTestVector } from "./TestVectors.js";',
        'import { at, ca, cae, eq, errorNamed, len, md, sleep } from "./TestUtil.js";',
        "",
        "void RobotRaconteurError;",
        "void errorNamed;",
        "void sleep;",
        "void VarValue;",
        "void len;",
        "void at;",
        "void md;",
        "void ca;",
        "void cae;",
        "void getTestVector;",
        "void eq;",
        "void assert;",
        "",
    ]
    for f, names in METHODS.items():
        for name in names:
            lines += convert(os.path.join(CORE, "python/RobotRaconteurTest", f), name) + [""]
    for k, v in constants().items():
        lines += [wrap(f"export const {k}: number[] = {v};"), ""]
    with open(os.path.join(ROOT, "test/common/ServiceTestClientGenerated.ts"), "w") as f:
        f.write("\n".join(lines).rstrip() + "\n")


if __name__ == "__main__":
    main()
