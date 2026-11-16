#!/usr/bin/env python3
"""Refresh the standalone installer's embedded Bash Sandhost client."""
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent
start = "# BEGIN EMBEDDED SANDHOST CLIENT\n"
end = "# END EMBEDDED SANDHOST CLIENT\n"
block = start + (root / "sandcats-v2.sh").read_text() + end
for name, marker in [("install.sh", "sandcats_configure() {"), ("recover-sandcats.sh", "main() {")]:
    installer = root / name
    text = installer.read_text()
    if start in text:
        before, rest = text.split(start, 1)
        _, after = rest.split(end, 1)
        updated = before + block + after
    else:
        updated = text.replace("\n" + marker, "\n" + block + "\n" + marker)
    if "--check" in sys.argv:
        if text != updated:
            sys.exit("Run python3 tests/sync-sandcats-installer.py to refresh " + name)
    else:
        installer.write_text(updated)
