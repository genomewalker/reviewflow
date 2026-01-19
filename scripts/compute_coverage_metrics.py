#!/usr/bin/env python3
"""
compute_coverage_metrics.py

Compute breadth, mean depth, and a simple coverage evenness metric from per-base
coverage files. Assumes per-target depth files in a directory, each file named
`<refid>.depth` with two columns: position (1-based) and depth.

Usage example:
  python3 scripts/compute_coverage_metrics.py --in_dir coverage_per_target/ --out supplementary/Table_Sx_coverage.csv

Output columns:
  target,breadth_pct,mean_depth,cov_evenness,pass_conservative

Evenness metric (default): 1 - (sd(depth)/mean(depth)), clipped to [0,1].
Conservative pass requires cov_evenness >= 0.5 and breadth_pct >= 5.0

If you have BAMs instead of depth files, generate depth files first with:
  samtools depth -a -r <refname> sample.bam > coverage_per_target/<refname>.depth

"""
import argparse
import csv
import math
import os
import statistics


def parse_args():
    p = argparse.ArgumentParser(description='Compute coverage metrics from per-target depth files')
    p.add_argument('--in_dir', required=True, help='Directory with .depth files')
    p.add_argument('--out', required=True, help='Output CSV path')
    p.add_argument('--breadth_cutoff', type=float, default=5.0, help='Breadth percent conservative cutoff')
    p.add_argument('--evenness_cutoff', type=float, default=0.5, help='Coverage evenness conservative cutoff (0-1)')
    return p.parse_args()


def read_depth_file(path):
    depths = []
    with open(path, 'r') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            try:
                d = float(parts[1])
            except ValueError:
                continue
            depths.append(d)
    return depths


def compute_metrics(depths):
    if not depths:
        return 0.0, 0.0, 0.0
    total_positions = len(depths)
    covered_positions = sum(1 for d in depths if d > 0)
    breadth = 100.0 * (covered_positions / total_positions)
    mean_depth = sum(depths) / total_positions
    if len(depths) > 1:
        sd = statistics.pstdev(depths)
    else:
        sd = 0.0
    if mean_depth <= 0:
        evenness = 0.0
    else:
        evenness = 1.0 - (sd / mean_depth)
        if evenness < 0.0:
            evenness = 0.0
        if evenness > 1.0:
            evenness = 1.0
    return breadth, mean_depth, evenness


def main():
    args = parse_args()
    files = [f for f in os.listdir(args.in_dir) if f.endswith('.depth')]
    files.sort()

    with open(args.out, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['target','breadth_pct','mean_depth','cov_evenness','pass_conservative'])
        for fn in files:
            path = os.path.join(args.in_dir, fn)
            target = fn.rsplit('.depth', 1)[0]
            depths = read_depth_file(path)
            breadth, mean_depth, evenness = compute_metrics(depths)
            passed = (evenness >= args.evenness_cutoff and breadth >= args.breadth_cutoff)
            w.writerow([target, f'{breadth:.3f}', f'{mean_depth:.3f}', f'{evenness:.3f}', int(passed)])
    print(f'Wrote coverage metrics to {args.out}')

if __name__ == '__main__':
    main()
