#!/usr/bin/env python3
"""Keep perf's workload alive after Sandstorm daemonizes, until the runner closes stdin."""
import subprocess
import sys

subprocess.run([sys.argv[1], 'start'], check=True)
sys.stdin.buffer.read()
