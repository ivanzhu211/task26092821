import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db';
import { matchFourRounds, NewEntry, OldEntry } from './matcher';
import {
  CompareResult,
  FindingResult,
  IngestResult,
  SequenceError,
  SnapshotInput,
  SnapshotUnavailableError,
} from './types';

/** 保留窗口：含本次在内的最近 N 个快照 */
export const RETENTION_WINDOW = 30;

export class Tracker {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 入库一个快照，返回每条发现的编号与状态，以及本次关闭的编号 */
  ingest(input: SnapshotInput): IngestResult {
    this.validate(input);
    const { project, seq } = input;

    const existing = this.db
      .prepare('SELECT seq FROM snapshots WHERE project = ? AND seq = ?')
      .get(project, seq) as { seq: number } | undefined;
    if (existing) {
      return this.reconstruct(project, seq, true);
    }
    const maxRow = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM snapshots WHERE project = ?')
      .get(project) as { maxSeq: number | null };
    const prevSeq = maxRow.maxSeq;
    if (prevSeq !== null && seq <= prevSeq) {
      throw new SequenceError(
        `snapshot seq ${seq} is not increasing for project "${project}" (latest is ${prevSeq})`,
      );
    }

    this.db.exec('BEGIN');
    try {
      const result = this.doIngest(input, prevSeq);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 对比同一项目两个保留中的快照（a 早于 b） */
  compare(project: string, a: number, b: number): CompareResult {
    if (a >= b) {
      throw new SnapshotUnavailableError(`compare requires a < b, got a=${a}, b=${b}`);
    }
    const seqs = this.db
      .prepare('SELECT seq FROM snapshots WHERE project = ? ORDER BY seq DESC')
      .all(project)
      .map((r) => (r as { seq: number }).seq);
    const haveA = seqs.includes(a);
    const haveB = seqs.includes(b);
    if (!haveA || !haveB) {
      throw new SnapshotUnavailableError(
        `snapshot ${haveA ? b : a} does not exist for project "${project}"`,
      );
    }
    const minWindow = seqs[Math.min(seqs.length, RETENTION_WINDOW) - 1];
    if (a < minWindow || b < minWindow) {
      throw new SnapshotUnavailableError(
        `snapshots ${a} and ${b} must both be within the retention window (>= ${minWindow})`,
      );
    }

    const idsA = new Set(
      this.db
        .prepare('SELECT issue_id FROM findings WHERE project = ? AND seq = ?')
        .all(project, a)
        .map((r) => (r as { issue_id: number }).issue_id),
    );
    const rowsB = this.db
      .prepare(
        `SELECT f.issue_id AS id, i.first_seq AS firstSeq
         FROM findings f JOIN issues i ON i.project = f.project AND i.id = f.issue_id
         WHERE f.project = ? AND f.seq = ?`,
      )
      .all(project, b)
      .map((r) => r as unknown as { id: number; firstSeq: number });

    const regression: number[] = [];
    const added: number[] = [];
    const resolved: number[] = [];
    const unchanged: number[] = [];

    for (const { id, firstSeq } of rowsB) {
      if (idsA.has(id)) unchanged.push(id);
      else if (firstSeq <= a) regression.push(id);
      else added.push(id);
    }
    const idsB = new Set(rowsB.map((r) => r.id));
    for (const id of idsA) {
      if (!idsB.has(id)) resolved.push(id);
    }
    regression.sort((x, y) => x - y);
    added.sort((x, y) => x - y);
    resolved.sort((x, y) => x - y);
    unchanged.sort((x, y) => x - y);
    return { regression, added, resolved, unchanged };
  }

  close(): void {
    this.db.close();
  }

  private validate(input: SnapshotInput): void {
    if (!input || typeof input.project !== 'string' || input.project.length === 0) {
      throw new Error('project must be a non-empty string');
    }
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new SequenceError(`seq must be a positive integer, got ${input.seq}`);
    }
    if (!Array.isArray(input.files) || !Array.isArray(input.findings)) {
      throw new Error('files and findings must be arrays');
    }
    for (const f of input.findings) {
      if (!Number.isInteger(f.line) || f.line < 0) {
        throw new Error(`finding line must be a non-negative integer, got ${f.line}`);
      }
    }
  }

  private doIngest(input: SnapshotInput, prevSeq: number | null): IngestResult {
    const { project, seq } = input;

    // 文件内容与行缓存（惰性切分）
    const fileMap = new Map<string, string>();
    for (const f of input.files) fileMap.set(f.path, f.content);
    const linesCache = new Map<string, string[]>();
    const fingerprintOf = (file: string, line: number): string | null => {
      if (line <= 0) return null;
      if (!fileMap.has(file)) return null;
      let lines = linesCache.get(file);
      if (lines === undefined) {
        lines = fileMap.get(file)!.split('\n');
        linesCache.set(file, lines);
      }
      if (line > lines.length) return null;
      return lines[line - 1].replace(/\s+/g, '');
    };

    const newEntries: NewEntry[] = input.findings.map((f, index) => ({
      index,
      rule: f.rule,
      file: f.file,
      line: f.line,
      message: f.message,
      fingerprint: fingerprintOf(f.file, f.line),
    }));

    // 第一轮匹配：上一快照中存在的问题
    const matched = new Map<number, number>(); // newIndex -> issueId
    let prevFindings: OldEntry[] = [];
    if (prevSeq !== null) {
      prevFindings = (
        this.db
          .prepare(
            `SELECT issue_id AS id, rule, file, line, message, fingerprint
             FROM findings WHERE project = ? AND seq = ?`,
          )
          .all(project, prevSeq) as unknown as Array<Omit<OldEntry, 'lastSeq'>>
      ).map((r) => ({ ...r, lastSeq: prevSeq }));
      for (const [k, v] of matchFourRounds(newEntries, prevFindings, 'open')) {
        matched.set(k, v);
      }
    }

    // 第二轮匹配：窗口内已关闭的问题（取最后一次出现的位置）
    const remaining = newEntries.filter((e) => !matched.has(e.index));
    const windowMin = this.windowMinSeq(project);
    const closedCandidates = (
      this.db
        .prepare(
          `SELECT id, rule, file,
                  last_line AS line, last_message AS message, last_fingerprint AS fingerprint,
                  last_seq AS lastSeq
           FROM issues
           WHERE project = ? AND status = 'closed' AND closed_seq >= ?`,
        )
        .all(project, windowMin) as unknown as OldEntry[]
    );
    const reopened = matchFourRounds(remaining, closedCandidates, 'closed');
    for (const [k, v] of reopened) matched.set(k, v);

    // 分配新编号
    const maxIdRow = this.db
      .prepare('SELECT MAX(id) AS maxId FROM issues WHERE project = ?')
      .get(project) as { maxId: number | null };
    let nextId = (maxIdRow.maxId ?? 0) + 1;

    // 本次关闭：上一快照存在但本次没配上的问题
    const matchedIds = new Set(matched.values());
    const closedIds = prevFindings
      .filter((o) => !matchedIds.has(o.id))
      .map((o) => o.id)
      .sort((x, y) => x - y);

    // 写库
    const insertSnapshot = this.db.prepare(
      'INSERT INTO snapshots (project, seq, created_at, finding_count) VALUES (?, ?, ?, ?)',
    );
    const insertFinding = this.db.prepare(
      `INSERT INTO findings (project, seq, ord, issue_id, status, rule, file, line, message, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertIssue = this.db.prepare(
      `INSERT INTO issues (project, id, rule, file, first_seq, last_seq, last_line, last_message, last_fingerprint, status, closed_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL)`,
    );
    const updateIssueSeen = this.db.prepare(
      `UPDATE issues
       SET last_seq = ?, last_line = ?, last_message = ?, last_fingerprint = ?,
           status = 'open', closed_seq = NULL
       WHERE project = ? AND id = ?`,
    );
    const closeIssue = this.db.prepare(
      `UPDATE issues SET status = 'closed', closed_seq = ? WHERE project = ? AND id = ?`,
    );
    const insertClosure = this.db.prepare(
      'INSERT INTO closures (project, seq, issue_id) VALUES (?, ?, ?)',
    );

    insertSnapshot.run(project, seq, new Date().toISOString(), input.findings.length);

    const reopenedSet = new Set(reopened.values());
    const results: FindingResult[] = new Array(input.findings.length);
    for (const e of newEntries) {
      const input_f = input.findings[e.index];
      let id = matched.get(e.index);
      let status: FindingResult['status'];
      if (id === undefined) {
        id = nextId++;
        status = 'new';
        insertIssue.run(project, id, e.rule, e.file, seq, seq, e.line, e.message, e.fingerprint);
      } else if (reopenedSet.has(id)) {
        status = 'reopened';
        updateIssueSeen.run(seq, e.line, e.message, e.fingerprint, project, id);
      } else {
        status = 'carried';
        updateIssueSeen.run(seq, e.line, e.message, e.fingerprint, project, id);
      }
      insertFinding.run(
        project, seq, e.index, id, status,
        input_f.rule, input_f.file, input_f.line, input_f.message, e.fingerprint,
      );
      results[e.index] = { id, status };
    }
    for (const id of closedIds) {
      closeIssue.run(seq, project, id);
      insertClosure.run(project, seq, id);
    }

    return { project, seq, findings: results, closed: closedIds, duplicate: false };
  }

  /** 含本次在内最近 RETENTION_WINDOW 个快照的最小序号（窗口外一律视为不可用） */
  private windowMinSeq(project: string): number {
    const rows = this.db
      .prepare('SELECT seq FROM snapshots WHERE project = ? ORDER BY seq DESC LIMIT ?')
      .all(project, RETENTION_WINDOW - 1) as unknown as Array<{ seq: number }>;
    if (rows.length < RETENTION_WINDOW - 1) return Number.MIN_SAFE_INTEGER;
    return rows[rows.length - 1].seq;
  }

  /** 已入库序号的重复提交：从库里重建首次结果 */
  private reconstruct(project: string, seq: number, duplicate: boolean): IngestResult {
    const findings = (
      this.db
        .prepare(
          'SELECT issue_id AS id, status FROM findings WHERE project = ? AND seq = ? ORDER BY ord',
        )
        .all(project, seq) as unknown as Array<{ id: number; status: FindingResult['status'] }>
    ).map((r) => ({ id: r.id, status: r.status }));
    const closed = (
      this.db
        .prepare('SELECT issue_id AS id FROM closures WHERE project = ? AND seq = ? ORDER BY issue_id')
        .all(project, seq) as unknown as Array<{ id: number }>
    ).map((r) => r.id);
    return { project, seq, findings, closed, duplicate };
  }
}
