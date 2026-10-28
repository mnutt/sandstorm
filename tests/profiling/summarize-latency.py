#!/usr/bin/env python3
"""Summarize validated request-latency artifacts, pooling requests across repetitions."""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('run', type=Path)
args = parser.parse_args()
manifest = json.loads((args.run / 'manifest.json').read_text())
if manifest['status'] != 'passed':
    parser.error('Run did not pass; inspect its logs and individual request records')
summaries = json.loads((args.run / 'latency-summary.json').read_text())
groups = defaultdict(list)
for summary in summaries:
    name = summary['name']
    group = name.rsplit('-r', 1)[0] if not name.startswith('cold-') else 'cold'
    groups[group].append(json.loads((args.run / (name + '.json')).read_text()))
print(f"Mode: {manifest['mode']}; pooled request percentiles (milliseconds)")
print(f"{'path':<16} {'n':>6} {'mean':>9} {'p50':>9} {'p95':>9} {'p99':>9} {'max':>9} {'req/s':>9} {'errors':>6}")
for name, batches in groups.items():
    rows = [r for batch in batches for r in batch['records']]
    good = [r for r in rows if 'error' not in r]
    values = sorted(r['totalMs'] for r in good)
    def percentile(p):
        return values[max(0, math.ceil(p * len(values)) - 1)]
    seconds = sum(b['summary']['durationMs'] for b in batches) / 1000
    print(f"{name:<16} {len(rows):6d} {statistics.mean(values):9.3f} {percentile(.5):9.3f} "
          f"{percentile(.95):9.3f} {percentile(.99):9.3f} {max(values):9.3f} "
          f"{len(good)/seconds:9.0f} {len(rows)-len(good):6d}")
    segments = ', '.join(f'{key}={statistics.mean(r[key] for r in good):.4f}'
                         for key in ['toAppMs', 'handlerMs', 'fromAppMs'])
    print(f"  mean segments: {segments}; reused sockets: {sum(r['reusedSocket'] for r in good)}/{len(good)}")
