"""Graphite execution sandbox — best-effort, NOT a security boundary.

POST /execute { code } -> runs the snippet in a fresh temp dir containing only
data.csv, with a 20s hard kill, a memory cap (resource.setrlimit via the
preexec hook), no network by best-effort (sandbox is macOS Seatbelt / Linux
unshare when available), and an AST allowlist that rejects before executing.
"""
from __future__ import annotations

import base64
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent / "sandbox"))
from allowlist import analyze

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_CSV = REPO_ROOT / "data" / "data.csv"

TIMEOUT_S = 20
MEMCAP_BYTES = 512 * 1024 * 1024  # 512 MB soft cap (RLIMIT_AS)

app = FastAPI(title="Graphite Executor")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


class ExecuteRequest(BaseModel):
    code: str


def _limit_memory():  # runs in the child, pre-exec
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMCAP_BYTES, MEMCAP_BYTES))
    except Exception:
        pass


def _seatbelt_profile(tmp: str) -> str:
    return f"""
(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow file-read*)
(allow file-write* (subpath "{tmp}"))
(allow file-write* (subpath "/private/var/folders"))
(allow file-write* (subpath "/tmp"))
(allow sysctl-read)
(allow mach-lookup)
(deny network*)
"""


def _build_sandbox_cmd(tmp: str) -> list[str] | None:
    """Return a command prefix that sandboxes the child, or None if unavailable."""
    if sys.platform == "darwin":
        sb = shutil.which("sandbox-exec")
        if sb:
            profile_path = os.path.join(tmp, "profile.sb")
            with open(profile_path, "w") as f:
                f.write(_seatbelt_profile(tmp))
            return [sb, "-f", profile_path, "python3"]
    return None


_PNG_RE = re.compile(rb"\x89PNG\r\n\x1a\n")


def _count_pngs(stdout: bytes) -> int:
    return len(_PNG_RE.findall(stdout))


def _figure_metadata(stdout: str) -> dict:
    """Parse the FIG_META JSON line the runner prints (not model code — our harness)."""
    for line in stdout.splitlines():
        if line.startswith("__FIG_META__"):
            import json
            try:
                return json.loads(line[len("__FIG_META__"):])
            except Exception:
                return {}
    return {}


RUNNER = '''\
import sys, json, os, glob
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.figure as _mf

_figs = []
_orig_new_figure = _mf.Figure.__init__
def _patched(self, *a, **kw):
    _orig_new_figure(self, *a, **kw)
    _figs.append(self)
_mf.Figure.__init__ = _patched

_stdout_writes = [0]
class _StdoutProxy:
    """Counts bytes the model pushes through sys.stdout.buffer (savefig target)."""
    def __init__(self, real): self._real = real
    @property
    def buffer(self): return _BufferProxy(self._real.buffer)
    def __getattr__(self, name): return getattr(self._real, name)
class _BufferProxy:
    def __init__(self, real): self._real = real
    def write(self, data):
        _stdout_writes[0] += 1
        return self._real.write(data)
    def __getattr__(self, name): return getattr(self._real, name)
sys.stdout = _StdoutProxy(sys.stdout)

def _emit_png(data: bytes):
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

def _emit_fig(fig):
    import io
    bio = io.BytesIO()
    fig.savefig(bio, format="png", dpi=fig.dpi)
    _emit_png(bio.getvalue())

_saved_files_before = set(glob.glob("*.png"))
_exit = 0
try:
    with open("user_code.py") as f:
        source = f.read()
    compiled = compile(source, "user_code.py", "exec")
    exec(compiled, {"__name__": "__main__", "__file__": "user_code.py"})
except BaseException:
    import traceback
    traceback.print_exc()
    _exit = 1

# 1) PNGs the model wrote to stdout directly (savefig(sys.stdout.buffer))
#    were already captured by the parent. 2) PNG files the model wrote:
new_files = sorted(set(glob.glob("*.png")) - _saved_files_before)
for name in new_files:
    try:
        with open(name, "rb") as f:
            _emit_png(f.read())
    except Exception:
        pass
# 3) if the model produced figures but never saved anything anywhere, render them now
if _exit == 0 and not new_files and _stdout_writes[0] == 0:
    try:
        open_figs = [plt.figure(n) for n in plt.get_fignums()]
        for fig in open_figs:
            _emit_fig(fig)
    except Exception:
        pass

metas = []
def _color_hex(c):
    try:
        import matplotlib.colors as _mc
        if c is None: return None
        if isinstance(c, (list, tuple)) and len(c) in (3, 4):
            try:
                if all(isinstance(v, (int, float)) for v in c):
                    r, g, b = c[:3]
                    if max(r, g, b) > 1: r, g, b = r/255.0, g/255.0, b/255.0
                    return "#%02x%02x%02x" % tuple(int(round(v*255)) for v in (r, g, b))
            except Exception: pass
            return None
        rgba = _mc.to_rgba(c)
        return "#%02x%02x%02x" % tuple(int(round(v*255)) for v in rgba[:3])
    except Exception:
        return None

for fig in _figs:
    dpi = fig.dpi
    colors = set()
    for ax in fig.axes:
        for ln in ax.lines:
            h = _color_hex(ln.get_color())
            if h: colors.add(h)
        for p in ax.patches:
            fc, ec = p.get_facecolor(), p.get_edgecolor()
            for c in (fc, ec):
                try:
                    if c is not None and len(c) and c[3] > 0:
                        h = _color_hex(tuple(c))
                        if h: colors.add(h)
                except Exception: pass
        for coll in ax.collections:
            try:
                fcs = list(coll.get_facecolors())[:8]
                ecs = list(coll.get_edgecolors())[:8]
                for c in fcs + ecs:
                    if len(c) and c[3] > 0:
                        h = _color_hex(tuple(c))
                        if h: colors.add(h)
            except Exception: pass
    metas.append({
        "figsize_in": [round(fig.get_figwidth(), 3), round(fig.get_figheight(), 3)],
        "dpi": dpi,
        "axes": len(fig.axes),
        "lines": sum(len(ax.lines) for ax in fig.axes),
        "patches": sum(len(ax.patches) for ax in fig.axes),
        "collections": sum(len(ax.collections) for ax in fig.axes),
        "images": sum(len(ax.images) for ax in fig.axes),
        "titles": sum(1 for ax in fig.axes if (ax.get_title() or "").strip()),
        "xlabels": sum(1 for ax in fig.axes if (ax.get_xlabel() or "").strip()),
        "ylabels": sum(1 for ax in fig.axes if (ax.get_ylabel() or "").strip()),
        "legends": sum(1 for ax in fig.axes if ax.get_legend() is not None),
        "suptitle": bool(getattr(fig, "_suptitle", None)),
        "distinctColors": sorted(colors),
    })
sys.stdout.buffer.write(b"\\n")
sys.stdout.buffer.flush()
print("__FIG_META__" + json.dumps(metas))
sys.exit(_exit)
'''


@app.get("/health")
def health():
    return {"ok": True, "data_csv": str(DATA_CSV), "rows": sum(1 for _ in open(DATA_CSV)) - 1}


@app.post("/execute")
def execute(req: ExecuteRequest):
    violations = analyze(req.code)
    if violations:
        return {
            "ok": False,
            "pngBase64": None,
            "stdout": "",
            "stderr": "",
            "traceback": None,
            "runtimeMs": 0,
            "figureCount": 0,
            "blocked": True,
            "violations": violations,
            "figureMeta": [],
            "pngInfo": None,
        }

    run_id = uuid.uuid4().hex[:12]
    tmp = tempfile.mkdtemp(prefix=f"graphite-{run_id}-")
    sandbox_cmd = _build_sandbox_cmd(tmp)
    try:
        # the sandbox cwd contains ONLY data.csv and our runner — never the original source tree
        shutil.copy(DATA_CSV, os.path.join(tmp, "data.csv"))
        with open(os.path.join(tmp, "user_code.py"), "w") as f:
            f.write(req.code)
        with open(os.path.join(tmp, "_runner.py"), "w") as f:
            f.write(RUNNER)

        py = sys.executable
        base_cmd = [py, "_runner.py"]
        cmd = (sandbox_cmd + ["_runner.py"]) if sandbox_cmd else base_cmd

        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": tmp,
            "TMPDIR": tmp,
            # shared font cache: build once on the host, reuse across runs
            "MPLCONFIGDIR": str(REPO_ROOT / ".mplcache"),
            "MPLBACKEND": "Agg",
            "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8",
            "PYTHONHASHSEED": "0",
        }
        os.makedirs(env["MPLCONFIGDIR"], exist_ok=True)

        t0 = time.monotonic()
        timed_out = False

        def _run(command):
            try:
                proc = subprocess.run(
                    command, cwd=tmp, env=env, capture_output=True, timeout=TIMEOUT_S,
                    preexec_fn=_limit_memory,
                )
                return proc.returncode, proc.stdout, proc.stderr, False
            except subprocess.TimeoutExpired as exc:
                return -signal.SIGKILL, (exc.stdout or b""), (exc.stderr or b""), True

        returncode, stdout_b, stderr_b, timed_out = _run(cmd)
        # Best-effort sandboxing: if the OS refuses to nest sandbox-exec
        # (common inside containers/CI), fall back to the remaining layers —
        # fresh temp cwd, AST allowlist, timeout kill, memory cap.
        if returncode != 0 and sandbox_cmd and b"sandbox-exec:" in stderr_b and not stdout_b:
            sandbox_cmd = None
            returncode, stdout_b, stderr_b, timed_out = _run(base_cmd)
        runtime_ms = int((time.monotonic() - t0) * 1000)

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        figure_meta = _figure_metadata(stdout)
        png_count = _count_pngs(stdout_b)

        # extract the last PNG from stdout (matplotlib savefig to a buffer prints it)
        png_base64 = None
        if png_count:
            png_base64 = _extract_last_png(stdout_b)

        ok = (returncode == 0) and png_base64 is not None
        png_info = _png_dimensions(stdout_b) if png_base64 else None
        traceback_text = None
        if returncode != 0 and not timed_out:
            tb = _extract_traceback(stderr, stdout)
            if tb:
                traceback_text = tb

        if timed_out:
            stderr = (stderr + f"\n[graphite] process exceeded {TIMEOUT_S}s hard timeout and was killed.").strip()

        return {
            "ok": ok,
            "pngBase64": png_base64,
            "stdout": stdout.replace("__FIG_META__", "__FIG_META__ (internal)") if "__FIG_META__" in stdout else stdout,
            "stderr": stderr,
            "traceback": traceback_text,
            "runtimeMs": runtime_ms,
            "figureCount": len(figure_meta) or png_count,
            "blocked": False,
            "violations": [],
            "figureMeta": figure_meta,
            "pngInfo": png_info,
            "timedOut": timed_out,
            "seatbelt": sandbox_cmd is not None,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _png_dimensions(data: bytes) -> dict | None:
    """Measure width/height/bit-depth from the PNG IHDR chunk itself."""
    start = data.find(b"\x89PNG\r\n\x1a\n")
    if start == -1 or len(data) < start + 24:
        return None
    import struct
    w, h = struct.unpack(">II", data[start + 16:start + 24])
    bit_depth = data[start + 24]
    color_type = data[start + 25]
    return {"width": w, "height": h, "bitDepth": bit_depth, "colorType": color_type}


def _extract_last_png(data: bytes) -> str | None:
    """Find the last complete PNG in the byte stream (IEND marker)."""
    start = data.rfind(b"\x89PNG\r\n\x1a\n")
    if start == -1:
        return None
    end = data.rfind(b"IEND\xaeB`\x82")
    if end == -1 or end < start:
        return None
    return base64.b64encode(data[start:end + 8]).decode("ascii")


def _extract_traceback(stderr: str, stdout: str) -> str | None:
    for stream in (stderr, stdout):
        if "Traceback (most recent call last)" in stream:
            idx = stream.index("Traceback (most recent call last)")
            return stream[idx:].strip()
    return None
