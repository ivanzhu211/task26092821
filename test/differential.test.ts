import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tracker, SnapshotInput, FindingInput } from '../src/index';
import { NaiveTracker } from './naive';

/** 可复现的伪随机数发生器 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODE_LINES = [
  'foo();', 'foo();', 'foo();', // 故意提高重复行概率
  'bar(x);', 'bar(y);',
  'if (a) {', '}', 'return 0;',
  'const v = 1;', 'let w = 2;',
  '   ', '\t\t', // 全空白行（指纹为空串）
  'call( a, b );', 'call(a,b);', // 空白不同、指纹相同
];

const RULES = ['rule-a', 'rule-b', 'rule-c'];
const MESSAGES = ['msg-1', 'msg-2', 'msg-3', 'msg-4'];

class RandomGen {
  constructor(private rand: () => number) {}
  int(n: number): number {
    return Math.floor(this.rand() * n);
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }
  chance(p: number): boolean {
    return this.rand() < p;
  }
}

/** 生成一个随机文件集（路径可能重复、内容随机） */
function genFiles(gen: RandomGen): Array<{ path: string; content: string }> {
  const fileCount = 1 + gen.int(6);
  const files: Array<{ path: string; content: string }> = [];
  for (let i = 0; i < fileCount; i++) {
    const lineCount = 1 + gen.int(40);
    const lines: string[] = [];
    for (let j = 0; j < lineCount; j++) lines.push(gen.pick(CODE_LINES));
    files.push({ path: `src/f${gen.int(6)}.ts`, content: lines.join('\n') });
  }
  return files;
}

/** 基于上一批文件做随机变异（插入/删除/替换行） */
function mutateFiles(
  gen: RandomGen,
  prev: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
  const files = prev.map((f) => ({ path: f.path, lines: f.content.split('\n') }));
  for (const f of files) {
    const ops = gen.int(4);
    for (let i = 0; i < ops; i++) {
      const op = gen.int(3);
      if (op === 0 && f.lines.length > 1) {
        f.lines.splice(gen.int(f.lines.length), 1); // 删行
      } else if (op === 1) {
        f.lines.splice(gen.int(f.lines.length + 1), 0, gen.pick(CODE_LINES)); // 插行
      } else {
        f.lines[gen.int(f.lines.length)] = gen.pick(CODE_LINES); // 改行
      }
    }
  }
  if (gen.chance(0.3)) files.push(...genFiles(gen).slice(0, 1).map((f) => ({ path: f.path, lines: f.content.split('\n') })));
  if (files.length > 1 && gen.chance(0.2)) files.splice(gen.int(files.length), 1); // 删整个文件
  return files.map((f) => ({ path: f.path, content: f.lines.join('\n') }));
}

/** 随机生成发现列表（含文件级、越界行、不存在文件等边缘情况） */
function genFindings(gen: RandomGen, files: Array<{ path: string; content: string }>): FindingInput[] {
  const findings: FindingInput[] = [];
  const count = gen.int(60);
  for (let i = 0; i < count; i++) {
    const rule = gen.pick(RULES);
    const message = gen.pick(MESSAGES);
    const kind = gen.int(10);
    if (kind === 0 || files.length === 0) {
      // 文件级或不存在的文件
      findings.push({ rule, file: `src/ghost${gen.int(3)}.ts`, line: 0, message });
    } else if (kind === 1) {
      const f = gen.pick(files);
      const lineCount = f.content.split('\n').length;
      findings.push({ rule, file: f.path, line: lineCount + 1 + gen.int(3), message }); // 越界行
    } else {
      const f = gen.pick(files);
      const lineCount = f.content.split('\n').length;
      findings.push({ rule, file: f.path, line: 1 + gen.int(lineCount), message });
    }
  }
  return findings;
}

function mutateFindings(gen: RandomGen, prev: FindingInput[], files: Array<{ path: string; content: string }>): FindingInput[] {
  // 以一定概率保留旧发现（可能改消息/行号），再补充新发现
  const kept: FindingInput[] = [];
  for (const f of prev) {
    if (gen.chance(0.75)) {
      const nf = { ...f };
      if (gen.chance(0.15)) nf.message = gen.pick(MESSAGES); // 只改消息
      if (gen.chance(0.3)) nf.line = Math.max(0, nf.line + gen.int(7) - 3); // 行号漂移
      kept.push(nf);
    }
  }
  return kept.concat(genFindings(gen, files).slice(0, gen.int(20)));
}

function runDifferential(seed: number, snapshotCount: number): void {
  const rand = mulberry32(seed);
  const gen = new RandomGen(rand);
  const dbPath = path.join(os.tmpdir(), `tracker-diff-${process.pid}-${seed}.db`);
  const tracker = new Tracker(dbPath);
  const naives = new Map<string, NaiveTracker>();
  const projects = ['proj-x', 'proj-y'];
  const seqs = new Map<string, number>();
  const filesByProject = new Map<string, Array<{ path: string; content: string }>>();
  const findingsByProject = new Map<string, FindingInput[]>();

  try {
    for (let step = 0; step < snapshotCount; step++) {
      const project = projects[step % projects.length];
      if (!naives.has(project)) {
        naives.set(project, new NaiveTracker());
        seqs.set(project, 0);
        filesByProject.set(project, genFiles(gen));
        findingsByProject.set(project, []);
      }
      const seq = seqs.get(project)! + 1;
      seqs.set(project, seq);

      const prevFiles = filesByProject.get(project)!;
      const files = seq === 1 ? prevFiles : mutateFiles(gen, prevFiles);
      filesByProject.set(project, files);
      const prevFindings = findingsByProject.get(project)!;
      const findings = seq === 1 ? genFindings(gen, files) : mutateFindings(gen, prevFindings, files);
      findingsByProject.set(project, findings);

      const input: SnapshotInput = { project, seq, files, findings };
      const expected = naives.get(project)!.ingest(input);
      const actual = tracker.ingest(input);

      assert.deepEqual(
        actual.findings.map((f) => [f.id, f.status]),
        expected.findings.map((f) => [f.id, f.status]),
        `seed=${seed} step=${step} project=${project} seq=${seq} findings mismatch`,
      );
      assert.deepEqual(actual.closed, expected.closed, `seed=${seed} seq=${seq} closed mismatch`);

      // 随机挑一对窗口内快照做对比
      if (seq >= 2 && gen.chance(0.7)) {
        const naive = naives.get(project)!;
        const b = seq;
        const a = 1 + gen.int(b - 1);
        let expectedCmp: ReturnType<NaiveTracker['compare']> | null = null;
        let expectedErr: string | null = null;
        try {
          expectedCmp = naive.compare(a, b);
        } catch (e) {
          expectedErr = (e as Error).name;
        }
        if (expectedErr) {
          assert.throws(() => tracker.compare(project, a, b), `seed=${seed} compare(${a},${b}) should throw`);
        } else {
          assert.deepEqual(
            tracker.compare(project, a, b),
            expectedCmp,
            `seed=${seed} project=${project} compare(${a}, ${b}) mismatch`,
          );
        }
      }

      // 随机重复提交历史序号
      if (gen.chance(0.2)) {
        const dupSeq = 1 + gen.int(seq);
        const expectedDup = naives.get(project)!.ingest({ project, seq: dupSeq, files: [], findings: [] });
        const actualDup = tracker.ingest({ project, seq: dupSeq, files: [], findings: [] });
        assert.equal(actualDup.duplicate, true);
        assert.deepEqual(
          actualDup.findings.map((f) => [f.id, f.status]),
          expectedDup.findings.map((f) => [f.id, f.status]),
          `seed=${seed} duplicate seq=${dupSeq} mismatch`,
        );
        assert.deepEqual(actualDup.closed, expectedDup.closed);
      }
    }
  } finally {
    tracker.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
}

test('随机多轮快照：与朴素实现完全一致（含跨窗口）', () => {
  runDifferential(42, 45); // 单项目 22~23 个快照，逼近窗口
  runDifferential(7, 70); // 跨窗口
  runDifferential(20260928, 60);
});
