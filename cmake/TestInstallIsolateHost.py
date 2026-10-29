"""Exercise artifact verification and atomic installation without network access."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

cmake, script = sys.argv[1:]
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    source = root / "source"
    source.write_bytes(b"test host executable\n")
    archive = root / "host.tar.xz"
    with tarfile.open(archive, "w:xz") as tar:
        tar.add(source, arcname="bin/isolate-host")
    output = root / "bin/isolate-host"
    release = root / "release"
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    args = [cmake, f"-DSOURCE={release}/bin/isolate-host", f"-DOUTPUT={output}",
            f"-DARCHIVE={archive}", f"-DRELEASE_DIR={release}",
            f"-DARCHIVE_SHA256={digest(archive)}", f"-DBINARY_SHA256={digest(source)}"]

    def run(extra=(), success=True):
        result = subprocess.run([*args, *extra, "-P", script], capture_output=True, text=True)
        assert (result.returncode == 0) == success, result.stdout + result.stderr

    run()
    assert output.read_bytes() == source.read_bytes()
    assert output.stat().st_mode & 0o111 == 0o111
    run(["-DVERIFY_ONLY=ON"])
    output.write_bytes(b"tampered binary")
    run(["-DVERIFY_ONLY=ON"], success=False)
    run()
    archive.write_bytes(b"tampered archive")
    run(success=False)
    assert output.read_bytes() == source.read_bytes(), "bad archive replaced installed binary"
    run([f"-DLOCAL_OVERRIDE={source}", f"-DSOURCE={source}"])
    source.write_bytes(b"updated local host")
    run([f"-DLOCAL_OVERRIDE={source}", f"-DSOURCE={source}", "-DVERIFY_ONLY=ON"], success=False)
    run([f"-DLOCAL_OVERRIDE={source}", f"-DSOURCE={source}"])
    assert output.read_bytes() == source.read_bytes()
