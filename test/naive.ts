/**
 * 朴素参考实现：逐条照业务规则直译，不考虑性能。
 * 仅用于测试对照，数据全部在内存中。单项目（构造后只服务一个项目）。
 */
import {
  CompareResult,
  FindingResult,
  IngestResult,
  SequenceError,
  SnapshotInput,
  SnapshotUnavailableError,
} from '../src/types';

export const NAIVE_WINDOW = 30;

interface Issue {
  id: number;
  rule: string;
  file: string;
  firstSeq: number;
  lastSeq: number;
  lastLine: number;
  lastMessage: string;
  lastFingerprint: string | null;
  status: 'open' | 'closed';
  closedSeq: number | null;
}

interface Entry {
  id: number; // 老侧为问题编号；新侧为入参下标
  rule: string;
  file: string;
  line: number;
  message: string;
  fingerprint: string | null;
  lastSeq: number;
}

function fingerprint(content: string | undefined, line: number): string | null {
  if (content === undefined || line <= 0) return null;
  const lines = content.split('\n');
  if (line > lines.length) return null;
  return lines[line - 1].replace(/\s+/g, '');
}

function roundKey(round: number, e: Entry): string | null {
  const fp = e.fingerprint;
  switch (round) {
    case 1:
      return JSON.stringify([e.line, e.message, fp]);
    case 2:
      return JSON.stringify([e.message, fp]);
    case 3:
      return JSON.stringify([e.line, e.message]);
    case 4:
      if (fp === null || fp === '') return null;
      return JSON.stringify(['fp', fp]);
    default:
      throw new Error('bad round');
  }
}

/** 四轮匹配的朴素直译 */
function naiveMatch(newSide: Entry[], oldSide: Entry[], oldOrder: 'open' | 'closed'): Map<number, number> {
  const result = new Map<number, number>();
  const matchedNew = new Set<number>();
  const matchedOld = new Set<number>();

  for (let round = 1; round <= 4; round++) {
    // 每轮只在同规则、同文件内找，已配上的双方不再参加
    const news = newSide.filter((e) => !matchedNew.has(e.id));
    const olds = oldSide.filter((e) => !matchedOld.has(e.id));

    // 按本轮条件分组：条件取值完全相同的一组
    const groupKeys: string[] = [];
    const keyOf = (e: Entry) => {
      const k = roundKey(round, e);
      return k === null ? null : JSON.stringify([e.rule, e.file, k]);
    };
    for (const e of [...news, ...olds]) {
      const k = keyOf(e);
      if (k !== null && !groupKeys.includes(k)) groupKeys.push(k);
    }

    for (const k of groupKeys) {
      const newGroup = news
        .filter((e) => keyOf(e) === k)
        .sort((a, b) => a.line - b.line || a.id - b.id); // 新发现：行号升序，再按列表先后（id 即下标）
      const oldGroup = olds
        .filter((e) => keyOf(e) === k)
        .sort((a, b) =>
          oldOrder === 'open'
            ? a.line - b.line || a.id - b.id // 老问题：行号升序，再按编号
            : b.lastSeq - a.lastSeq || a.line - b.line || a.id - b.id, // 关闭问题：最后出现快照新到旧、行号、编号
        );
      const n = Math.min(newGroup.length, oldGroup.length);
      for (let i = 0; i < n; i++) {
        result.set(newGroup[i].id, oldGroup[i].id);
        matchedNew.add(newGroup[i].id);
        matchedOld.add(oldGroup[i].id);
      }
    }
  }
  return result;
}

export class NaiveTracker {
  private issues = new Map<number, Issue>();
  private seqs: number[] = [];
  private prevFindings: Entry[] = [];
  private stored = new Map<number, IngestResult>();
  private snapshotIssues = new Map<number, Set<number>>();
  private nextId = 1;

  ingest(input: SnapshotInput): IngestResult {
    const { seq } = input;
    if (this.seqs.includes(seq)) {
      return { ...this.stored.get(seq)!, duplicate: true };
    }
    if (this.seqs.length > 0 && seq <= this.seqs[this.seqs.length - 1]) {
      throw new SequenceError(`seq ${seq} not increasing`);
    }

    const fileMap = new Map<string, string>();
    for (const f of input.files) fileMap.set(f.path, f.content);

    const newEntries: Entry[] = input.findings.map((f, i) => ({
      id: i,
      rule: f.rule,
      file: f.file,
      line: f.line,
      message: f.message,
      fingerprint: fingerprint(fileMap.get(f.file), f.line),
      lastSeq: seq,
    }));

    // 第一轮：与上一快照中存在的问题匹配
    const matched = naiveMatch(newEntries, this.prevFindings, 'open');

    // 第二轮：剩余发现匹配窗口内已关闭的问题（位置取最后一次出现时）
    const windowSeqs = [...this.seqs.slice(-(NAIVE_WINDOW - 1)), seq];
    const windowMin = Math.min(...windowSeqs);
    const closedCandidates: Entry[] = [...this.issues.values()]
      .filter((i) => i.status === 'closed' && i.closedSeq !== null && i.closedSeq >= windowMin)
      .map((i) => ({
        id: i.id,
        rule: i.rule,
        file: i.file,
        line: i.lastLine,
        message: i.lastMessage,
        fingerprint: i.lastFingerprint,
        lastSeq: i.lastSeq,
      }));
    const remaining = newEntries.filter((e) => !matched.has(e.id));
    for (const [k, v] of naiveMatch(remaining, closedCandidates, 'closed')) {
      matched.set(k, v);
    }

    // 本次关闭：上一快照有、本次没配上的
    const matchedIssueIds = new Set(matched.values());
    const closedIds = this.prevFindings
      .filter((e) => !matchedIssueIds.has(e.id))
      .map((e) => e.id)
      .sort((a, b) => a - b);

    const reopenedIds = new Set<number>();
    for (const c of closedCandidates) {
      for (const [, v] of matched) if (v === c.id) reopenedIds.add(c.id);
    }

    const results: FindingResult[] = new Array(input.findings.length);
    for (const e of newEntries) {
      let id = matched.get(e.id);
      let status: FindingResult['status'];
      if (id === undefined) {
        id = this.nextId++;
        status = 'new';
        this.issues.set(id, {
          id, rule: e.rule, file: e.file, firstSeq: seq, lastSeq: seq,
          lastLine: e.line, lastMessage: e.message, lastFingerprint: e.fingerprint,
          status: 'open', closedSeq: null,
        });
      } else {
        const issue = this.issues.get(id)!;
        status = reopenedIds.has(id) ? 'reopened' : 'carried';
        issue.lastSeq = seq;
        issue.lastLine = e.line;
        issue.lastMessage = e.message;
        issue.lastFingerprint = e.fingerprint;
        issue.status = 'open';
        issue.closedSeq = null;
      }
      results[e.id] = { id, status };
    }
    for (const id of closedIds) {
      const issue = this.issues.get(id)!;
      issue.status = 'closed';
      issue.closedSeq = seq;
    }

    this.seqs.push(seq);
    this.prevFindings = newEntries.map((e) => ({
      id: results[e.id].id,
      rule: e.rule,
      file: e.file,
      line: e.line,
      message: e.message,
      fingerprint: e.fingerprint,
      lastSeq: seq,
    }));
    this.snapshotIssues.set(seq, new Set(results.map((r) => r.id)));
    const out: IngestResult = {
      project: input.project, seq, findings: results, closed: closedIds, duplicate: false,
    };
    this.stored.set(seq, out);
    return out;
  }

  compare(a: number, b: number): CompareResult {
    if (a >= b) throw new SnapshotUnavailableError('a must be earlier than b');
    if (!this.snapshotIssues.has(a) || !this.snapshotIssues.has(b)) {
      throw new SnapshotUnavailableError('snapshot missing');
    }
    const windowSeqs = this.seqs.slice(-NAIVE_WINDOW);
    if (!windowSeqs.includes(a) || !windowSeqs.includes(b)) {
      throw new SnapshotUnavailableError('outside retention window');
    }
    const idsA = this.snapshotIssues.get(a)!;
    const idsB = this.snapshotIssues.get(b)!;
    const regression: number[] = [];
    const added: number[] = [];
    const resolved: number[] = [];
    const unchanged: number[] = [];
    for (const id of idsB) {
      if (idsA.has(id)) unchanged.push(id);
      else if (this.issues.get(id)!.firstSeq <= a) regression.push(id);
      else added.push(id);
    }
    for (const id of idsA) {
      if (!idsB.has(id)) resolved.push(id);
    }
    regression.sort((x, y) => x - y);
    added.sort((x, y) => x - y);
    resolved.sort((x, y) => x - y);
    unchanged.sort((x, y) => x - y);
    return { regression, added, resolved, unchanged };
  }
}
