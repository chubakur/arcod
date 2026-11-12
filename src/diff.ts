// Structural diff between two specs. Both are parsed and canonicalized first,
// so the diff reports semantic changes, not whitespace or ordering noise.

import { parse } from './parser.ts';
import { printModule } from './fmt.ts';

type Op = { kind: 'keep' | 'del' | 'ins'; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'keep', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: 'del', line: a[i] }); i++; }
    else { ops.push({ kind: 'ins', line: b[j] }); j++; }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++] });
  while (j < m) ops.push({ kind: 'ins', line: b[j++] });
  return ops;
}

export function diffSpecs(aSource: string, aFile: string, bSource: string, bFile: string): string {
  const a = printModule(parse(aSource, aFile)).split('\n');
  const b = printModule(parse(bSource, bFile)).split('\n');
  // drop the trailing empty line from the trailing newline
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();

  const ops = lcsOps(a, b);
  const out: string[] = ['--- ' + aFile, '+++ ' + bFile];

  const changed = ops.some((o) => o.kind !== 'keep');
  if (!changed) return out.join('\n') + '\n';

  const CTX = 3;
  // convert ops to lines with a running a-line / b-line counter
  const lines: Array<{ op: Op; aNo: number; bNo: number }> = [];
  let aNo = 1;
  let bNo = 1;
  for (const op of ops) {
    if (op.kind === 'del') lines.push({ op, aNo: aNo++, bNo: -1 });
    else if (op.kind === 'ins') lines.push({ op, aNo: -1, bNo: bNo++ });
    else lines.push({ op, aNo: aNo++, bNo: bNo++ });
  }

  // find changed ranges and emit hunks
  const changeIdx: number[] = [];
  for (let k = 0; k < lines.length; k++) if (lines[k].op.kind !== 'keep') changeIdx.push(k);

  let cursor = 0;
  while (cursor < changeIdx.length) {
    let start = changeIdx[cursor] - CTX;
    let end = changeIdx[cursor] + CTX;
    let next = cursor;
    while (next + 1 < changeIdx.length && changeIdx[next + 1] - CTX <= end) {
      end = changeIdx[++next] + CTX;
    }
    start = Math.max(0, start);
    end = Math.min(lines.length - 1, end);

    const aStart = lines[start].aNo >= 0 ? lines[start].aNo : lines[start + 1]?.aNo ?? 1;
    const aEnd = lines[end].aNo >= 0 ? lines[end].aNo : aNo - 1;
    const bStart = lines[start].bNo >= 0 ? lines[start].bNo : lines[start + 1]?.bNo ?? 1;
    const bEnd = lines[end].bNo >= 0 ? lines[end].bNo : bNo - 1;

    let aCount = 0;
    let bCount = 0;
    for (let k = start; k <= end; k++) {
      if (lines[k].op.kind !== 'ins') aCount++;
      if (lines[k].op.kind !== 'del') bCount++;
    }
    out.push('@@ -' + aStart + ',' + aCount + ' +' + bStart + ',' + bCount + ' @@');
    for (let k = start; k <= end; k++) {
      const op = lines[k].op;
      out.push((op.kind === 'keep' ? ' ' : op.kind === 'del' ? '-' : '+') + op.line);
    }
    cursor = next + 1;
  }

  return out.join('\n') + '\n';
}
