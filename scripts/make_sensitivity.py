#!/usr/bin/env python3
"""
make_sensitivity.py

Parse an MMseqs2 convertalis TSV and produce sensitivity tables at multiple bitscore
thresholds and conservative filter counts (pident, qcov).

Usage examples:
  python3 scripts/make_sensitivity.py --in results/mmseqs_results.tsv --out_dir supplementary/

Outputs written to `--out_dir`:
  - Table_Sx_sensitivity.csv
  - Table_Sx_detailed.csv

Expected input TSV columns (tab-separated):
  query\ttarget\tevalue\tbits\tpident\talnlen\tqcov\ttcov

If your file has different column names/order, pre-process to match this format.
"""
import argparse
import csv
import sys
from collections import defaultdict

DEFAULT_BITS = [20, 35, 50]
DEFAULT_EVALUE = 1e-5


def parse_args():
    p = argparse.ArgumentParser(description="Produce sensitivity summary CSVs from mmseqs tsv")
    p.add_argument('--in', dest='infile', required=True, help='Input TSV (mmseqs convertalis)')
    p.add_argument('--out_dir', required=True, help='Output directory for CSVs')
    p.add_argument('--bits', nargs='+', type=int, default=DEFAULT_BITS, help='Bitscore thresholds to test')
    p.add_argument('--evalue', type=float, default=DEFAULT_EVALUE, help='E-value cutoff to apply')
    p.add_argument('--cons_pident', type=float, default=30.0, help='Conservative percent identity cutoff (%%)')
    p.add_argument('--cons_qcov', type=float, default=50.0, help='Conservative query coverage cutoff (%%)')
    return p.parse_args()


def read_tsv(path):
    rows = []
    with open(path, 'r', newline='') as fh:
        rdr = csv.reader(fh, delimiter='\t')
        for r in rdr:
            if not r:
                continue
            # Accept header lines starting with '#'
            if r[0].startswith('#'):
                continue
            if len(r) < 8:
                raise ValueError('Expected at least 8 columns per line: query,target,evalue,bits,pident,alnlen,qcov,tcov')
            row = {
                'query': r[0],
                'target': r[1],
                'evalue': float(r[2]),
                'bits': float(r[3]),
                'pident': float(r[4]),
                'alnlen': int(r[5]),
                'qcov': float(r[6]),
                'tcov': float(r[7]),
            }
            rows.append(row)
    return rows


def make_summaries(rows, bits_list, evalue_cutoff, cons_pident, cons_qcov):
    summaries = []
    detailed = []

    for b in bits_list:
        filtered = [r for r in rows if (r['evalue'] <= evalue_cutoff and r['bits'] >= b)]
        n_hits = len(filtered)
        unique_queries = len(set(r['query'] for r in filtered))
        # Now conservative subset
        cons = [r for r in filtered if (r['pident'] >= cons_pident and r['qcov'] >= cons_qcov)]
        n_hits_cons = len(cons)
        unique_queries_cons = len(set(r['query'] for r in cons))
        summaries.append({
            'threshold_bits': b,
            'evalue_cutoff': evalue_cutoff,
            'n_hits_total': n_hits,
            'n_unique_queries_total': unique_queries,
            'n_hits_conservative': n_hits_cons,
            'n_unique_queries_conservative': unique_queries_cons,
        })

    # Build detailed per-hit table with pass/fail flags for each threshold
    for r in rows:
        entry = dict(r)  # copy
        entry['pass_evalue'] = (r['evalue'] <= evalue_cutoff)
        for b in bits_list:
            entry[f'pass_bits_{b}'] = (r['bits'] >= b and entry['pass_evalue'])
        entry['pass_conservative'] = (entry['pass_evalue'] and r['pident'] >= cons_pident and r['qcov'] >= cons_qcov)
        detailed.append(entry)

    return summaries, detailed


def write_summaries(summaries, out_path):
    fieldnames = ['threshold_bits','evalue_cutoff','n_hits_total','n_unique_queries_total','n_hits_conservative','n_unique_queries_conservative']
    with open(out_path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        for s in summaries:
            w.writerow(s)


def write_detailed(detailed, bits_list, out_path):
    # Construct consistent header
    base_fields = ['query','target','evalue','bits','pident','alnlen','qcov','tcov','pass_evalue']
    bits_fields = [f'pass_bits_{b}' for b in bits_list]
    extra = ['pass_conservative']
    fieldnames = base_fields + bits_fields + extra
    with open(out_path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        for d in detailed:
            row = {k: d.get(k, '') for k in fieldnames}
            w.writerow(row)


def main():
    args = parse_args()

    rows = read_tsv(args.infile)
    summaries, detailed = make_summaries(rows, args.bits, args.evalue, args.cons_pident, args.cons_qcov)

    out_summary = args.out_dir.rstrip('/') + '/Table_Sx_sensitivity.csv'
    out_detailed = args.out_dir.rstrip('/') + '/Table_Sx_detailed.csv'

    write_summaries(summaries, out_summary)
    write_detailed(detailed, args.bits, out_detailed)

    print(f'Wrote summary -> {out_summary}')
    print(f'Wrote detailed -> {out_detailed}')


if __name__ == '__main__':
    main()
