"""AST allowlist analyzer for the Graphite execution sandbox.

Rejects code before it ever runs if it imports or references dangerous modules.
Best-effort only — see README: this is NOT a security boundary.
"""
from __future__ import annotations

import ast

BLOCKED_MODULES = {
    "os", "subprocess", "socket", "shutil", "requests", "urllib",
    "urllib2", "urllib3", "http", "httpx", "httplib2", "aiohttp",
    "ftplib", "telnetlib", "smtplib", "multiprocessing",
    "ctypes", "importlib", "pickle", "shelve", "sqlite3", "pathlib",
    "signal", "resource", "pty", "fcntl", "webbrowser", "turtle",
    "tkinter", "wx", "IPython", "notebook", "jupyter", "secrets",
    "plotly", "bokeh", "altair", "pygal", "graphviz", "h5py",
    "sqlalchemy", "pymysql", "psycopg2", "dask", "fabric", "paramiko",
}

ALLOWED_MODULES = {
    "pandas", "numpy", "matplotlib", "math", "statistics", "datetime",
    "collections", "itertools", "functools", "re", "json", "csv",
    "textwrap", "string", "decimal", "fractions", "warnings", "calendar",
    "operator", "heapq", "bisect", "time", "typing", "copy", "sys",
    "random", "glob", "tempfile", "threading", "asyncio", "seaborn",
    "scipy", "io", "abc", "enum", "dataclasses", "base64",
}

DANGEROUS_BUILTINS = {
    "eval", "exec", "compile", "open", "input", "breakpoint", "globals",
    "locals", "vars", "dir", "delattr", "setattr", "getattr", "memoryview",
    "super", "type", "__import__",
}

DANGEROUS_ATTRS = {
    "system", "popen", "popen2", "spawn", "fork", "execv", "execve",
    "remove", "unlink", "rmdir", "makedirs", "mkdir", "rename", "chmod",
    "chown", "kill", "terminate", "environ", "connect", "create_connection",
    "socket", "urlopen", "urlretrieve", "rmtree", "setuid", "setgid",
}


def _imported_modules(node: ast.AST) -> list[str]:
    """All module names an Import/ImportFrom node pulls in (every alias)."""
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if isinstance(node, ast.ImportFrom) and node.module:
        return [node.module]
    return []


def analyze(code: str) -> list[dict]:
    """Return a list of violations found in the source. Empty list = allowed."""
    violations: list[dict] = []
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return [{"kind": "syntax", "detail": f"SyntaxError: {exc.msg} (line {exc.lineno})"}]

    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for mod in _imported_modules(node):
                root = mod.split(".")[0]
                if root in BLOCKED_MODULES or mod in BLOCKED_MODULES:
                    violations.append({
                        "kind": "import",
                        "detail": f"import of blocked module '{mod}'",
                        "line": getattr(node, "lineno", 0),
                    })
                elif root not in ALLOWED_MODULES and mod not in ALLOWED_MODULES:
                    violations.append({
                        "kind": "import",
                        "detail": f"import of module '{mod}' is not on the allowlist "
                                  f"(allowed: {', '.join(sorted(ALLOWED_MODULES))})",
                        "line": getattr(node, "lineno", 0),
                    })

        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id == "__import__":
                violations.append({
                    "kind": "builtin", "detail": "call to __import__",
                    "line": getattr(node, "lineno", 0),
                })
            elif isinstance(func, ast.Name) and func.id in DANGEROUS_BUILTINS:
                violations.append({
                    "kind": "builtin", "detail": f"call to builtin '{func.id}'",
                    "line": getattr(node, "lineno", 0),
                })
            elif isinstance(func, ast.Attribute) and func.attr in DANGEROUS_ATTRS:
                violations.append({
                    "kind": "attribute",
                    "detail": f"access to dangerous attribute '.{func.attr}'",
                    "line": getattr(node, "lineno", 0),
                })

        elif isinstance(node, ast.Attribute) and node.attr in DANGEROUS_ATTRS:
            # attribute reads (not just calls) — e.g. `os.environ`
            violations.append({
                "kind": "attribute",
                "detail": f"access to dangerous attribute '.{node.attr}'",
                "line": getattr(node, "lineno", 0),
            })

        elif isinstance(node, ast.Name) and node.id in ("__builtins__", "__subclasses__", "__globals__"):
            violations.append({
                "kind": "dunder", "detail": f"reference to '{node.id}'",
                "line": getattr(node, "lineno", 0),
            })

    return violations
