import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tracker, SequenceError, SnapshotUnavailableError, SnapshotInput } from '../src/index';

let tmpCounter = 0;
function freshTracker(): { tracker: Tracker; cleanup: () => void } {
  const p = path.join(os.tmpdir(), `tracker-test-${process.pid}-${tmpCounter++}.db`);
  const tracker = new Tracker(p);
  return {
    tracker,
    cleanup: () => {
      tracker.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true });
    },
  };
}

function lines(n: number, prefix = 'code'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}();`).join('\n');
}

test('文件顶部插入若干行后，老问题编号全部保持', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const content1 = lines(300);
    const findings1 = Array.from({ length: 300 }, (_, i) => ({
      rule: 'no-exec', file: 'src/a.ts', line: i + 1, message: 'avoid exec',
    }));
    const r1 = tracker.ingest({ project: 'p', seq: 1, files: [{ path: 'src/a.ts', content: content1 }], findings: findings1 });
    assert.equal(r1.findings.length, 300);
    assert.ok(r1.findings.every((f) => f.status === 'new'));
    assert.deepEqual(r1.findings.map((f) => f.id), Array.from({ length: 300 }, (_, i) => i + 1));

    // 顶部插入 5 行，下面 300 行整体下移
    const content2 = lines(5, 'added') + '\n' + content1;
    const findings2 = findings1.map((f) => ({ ...f, line: f.line + 5 }));
    const r2 = tracker.ingest({ project: 'p', seq: 2, files: [{ path: 'src/a.ts', content: content2 }], findings: findings2 });
    assert.ok(r2.findings.every((f) => f.status === 'carried'));
    assert.deepEqual(r2.findings.map((f) => f.id), r1.findings.map((f) => f.id));
    assert.deepEqual(r2.closed, []);

    const cmp = tracker.compare('p', 1, 2);
    assert.equal(cmp.unchanged.length, 300);
    assert.deepEqual(cmp.added, []);
    assert.deepEqual(cmp.resolved, []);
    assert.deepEqual(cmp.regression, []);
  } finally {
    cleanup();
  }
});

test('多行完全相同的代码：删除其中一行', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const content = Array.from({ length: 5 }, () => 'foo();').join('\n');
    const mk = (ls: number[]) => ls.map((line) => ({ rule: 'r', file: 'f.ts', line, message: 'm' }));
    const r1 = tracker.ingest({ project: 'p', seq: 1, files: [{ path: 'f.ts', content }], findings: mk([1, 2, 3, 4, 5]) });
    assert.deepEqual(r1.findings.map((f) => f.id), [1, 2, 3, 4, 5]);

    // 删除第 2 行：剩余 4 行内容仍完全相同，按序配对后最后一个编号关闭
    const content2 = Array.from({ length: 4 }, () => 'foo();').join('\n');
    const r2 = tracker.ingest({ project: 'p', seq: 2, files: [{ path: 'f.ts', content: content2 }], findings: mk([1, 2, 3, 4]) });
    assert.deepEqual(r2.findings.map((f) => f.id), [1, 2, 3, 4]);
    assert.ok(r2.findings.every((f) => f.status === 'carried'));
    assert.deepEqual(r2.closed, [5]);
  } finally {
    cleanup();
  }
});

test('多行完全相同的代码：移动行位置', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    // A B A：两条相同行各带一条问题
    const content1 = 'alpha();\nbeta();\nalpha();';
    const f1 = [
      { rule: 'r', file: 'f.ts', line: 1, message: 'm' },
      { rule: 'r', file: 'f.ts', line: 3, message: 'm' },
    ];
    const r1 = tracker.ingest({ project: 'p', seq: 1, files: [{ path: 'f.ts', content: content1 }], findings: f1 });

    // 移动为 B A A
    const content2 = 'beta();\nalpha();\nalpha();';
    const f2 = [
      { rule: 'r', file: 'f.ts', line: 2, message: 'm' },
      { rule: 'r', file: 'f.ts', line: 3, message: 'm' },
    ];
    const r2 = tracker.ingest({ project: 'p', seq: 2, files: [{ path: 'f.ts', content: content2 }], findings: f2 });
    assert.deepEqual(r2.findings.map((f) => f.id), r1.findings.map((f) => f.id));
    assert.ok(r2.findings.every((f) => f.status === 'carried'));
    assert.deepEqual(r2.closed, []);
  } finally {
    cleanup();
  }
});

test('只改消息：指纹相同仍沿用编号', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const content = 'doSomething();';
    const r1 = tracker.ingest({
      project: 'p', seq: 1, files: [{ path: 'f.ts', content }],
      findings: [{ rule: 'r', file: 'f.ts', line: 1, message: 'old message' }],
    });
    const r2 = tracker.ingest({
      project: 'p', seq: 2, files: [{ path: 'f.ts', content }],
      findings: [{ rule: 'r', file: 'f.ts', line: 1, message: 'new message' }],
    });
    assert.equal(r2.findings[0].id, r1.findings[0].id);
    assert.equal(r2.findings[0].status, 'carried');
    assert.deepEqual(r2.closed, []);
  } finally {
    cleanup();
  }
});

test('文件级发现（行号 0）指纹为空，改消息后按新增处理', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const r1 = tracker.ingest({
      project: 'p', seq: 1, files: [{ path: 'f.ts', content: 'x' }],
      findings: [{ rule: 'r', file: 'f.ts', line: 0, message: 'file level' }],
    });
    const r2 = tracker.ingest({
      project: 'p', seq: 2, files: [{ path: 'f.ts', content: 'x' }],
      findings: [{ rule: 'r', file: 'f.ts', line: 0, message: 'changed' }],
    });
    assert.equal(r2.findings[0].status, 'new');
    assert.notEqual(r2.findings[0].id, r1.findings[0].id);
    assert.deepEqual(r2.closed, [r1.findings[0].id]);
  } finally {
    cleanup();
  }
});

test('问题关闭后在窗口内重新出现：重新打开并沿用编号', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const files = [{ path: 'f.ts', content: 'alpha();\nbeta();' }];
    const finding = { rule: 'r', file: 'f.ts', line: 1, message: 'm' };
    const r1 = tracker.ingest({ project: 'p', seq: 1, files, findings: [finding] });
    const id = r1.findings[0].id;

    // seq 2：问题消失（关闭）
    const r2 = tracker.ingest({ project: 'p', seq: 2, files, findings: [] });
    assert.deepEqual(r2.closed, [id]);

    // seq 3：同样的问题重新出现（窗口内）
    const r3 = tracker.ingest({ project: 'p', seq: 3, files, findings: [finding] });
    assert.equal(r3.findings[0].id, id);
    assert.equal(r3.findings[0].status, 'reopened');

    // 对比 1 和 3：两边都有，算未变（中间关闭过也一样）
    const cmp13 = tracker.compare('p', 1, 3);
    assert.deepEqual(cmp13.unchanged, [id]);
    // 对比 2 和 3：只在 3 中，首次出现不晚于 2，算回归
    const cmp23 = tracker.compare('p', 2, 3);
    assert.deepEqual(cmp23.regression, [id]);
  } finally {
    cleanup();
  }
});

test('问题关闭发生在窗口外：重新出现算新增', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const files = [{ path: 'f.ts', content: 'alpha();' }];
    const finding = { rule: 'r', file: 'f.ts', line: 1, message: 'm' };
    const r1 = tracker.ingest({ project: 'p', seq: 1, files, findings: [finding] });
    const id = r1.findings[0].id;
    tracker.ingest({ project: 'p', seq: 2, files, findings: [] }); // 在 seq 2 关闭

    // 推进到 seq 32（窗口为最近 30 个：3..32，关闭点 2 已在窗口外）
    for (let s = 3; s <= 32; s++) {
      tracker.ingest({ project: 'p', seq: s, files, findings: [] });
    }
    const r33 = tracker.ingest({ project: 'p', seq: 33, files, findings: [finding] });
    assert.equal(r33.findings[0].status, 'new');
    assert.notEqual(r33.findings[0].id, id);
  } finally {
    cleanup();
  }
});

test('重复提交原样返回首次结果，乱序序号被拒绝', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const files = [{ path: 'f.ts', content: 'alpha();' }];
    const r1 = tracker.ingest({ project: 'p', seq: 1, files, findings: [{ rule: 'r', file: 'f.ts', line: 1, message: 'm' }] });
    tracker.ingest({ project: 'p', seq: 2, files, findings: [] });
    tracker.ingest({ project: 'p', seq: 5, files, findings: [] });

    // 重复提交 seq 1（即使入参不同也返回首次结果，且不改数据）
    const dup = tracker.ingest({ project: 'p', seq: 1, files: [], findings: [] });
    assert.equal(dup.duplicate, true);
    assert.deepEqual(dup.findings, r1.findings);
    assert.deepEqual(dup.closed, r1.closed);

    // 乱序：4 小于当前最大 5 且未入库
    assert.throws(() => tracker.ingest({ project: 'p', seq: 4, files, findings: [] }), SequenceError);
    assert.throws(() => tracker.ingest({ project: 'p', seq: 0, files, findings: [] }), SequenceError);

    // 数据未被重复提交破坏
    const cmp = tracker.compare('p', 1, 2);
    assert.deepEqual(cmp.resolved, [r1.findings[0].id]);
  } finally {
    cleanup();
  }
});

test('窗口外的快照不能参与对比', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const files = [{ path: 'f.ts', content: 'alpha();' }];
    for (let s = 1; s <= 35; s++) {
      tracker.ingest({ project: 'p', seq: s, files, findings: [] });
    }
    assert.throws(() => tracker.compare('p', 1, 35), SnapshotUnavailableError);
    assert.throws(() => tracker.compare('p', 5, 35), SnapshotUnavailableError);
    // 窗口内（6..35）可以
    assert.doesNotThrow(() => tracker.compare('p', 6, 35));
    // 不存在的快照
    assert.throws(() => tracker.compare('p', 30, 99), SnapshotUnavailableError);
    // a 必须早于 b
    assert.throws(() => tracker.compare('p', 35, 30), SnapshotUnavailableError);
  } finally {
    cleanup();
  }
});

test('对比：新增、已解决、回归、未变', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const files = [{ path: 'f.ts', content: 'l1\nl2\nl3\nl4' }];
    const mk = (line: number) => ({ rule: 'r', file: 'f.ts', line, message: `m${line}` });
    // seq1: 问题 A(line1) B(line2)
    const r1 = tracker.ingest({ project: 'p', seq: 1, files, findings: [mk(1), mk(2)] });
    const [idA, idB] = r1.findings.map((f) => f.id);
    // seq2: 只剩 B
    tracker.ingest({ project: 'p', seq: 2, files, findings: [mk(2)] });
    // seq3: B 还在，A 回归，新增 C(line3)
    const r3 = tracker.ingest({ project: 'p', seq: 3, files, findings: [mk(1), mk(2), mk(3)] });
    const idC = r3.findings[2].id;
    assert.equal(r3.findings[0].status, 'reopened');
    assert.equal(r3.findings[0].id, idA);

    const cmp = tracker.compare('p', 2, 3);
    assert.deepEqual(cmp.regression, [idA]);
    assert.deepEqual(cmp.added, [idC]);
    assert.deepEqual(cmp.unchanged, [idB]);
    assert.deepEqual(cmp.resolved, []);

    const cmp12 = tracker.compare('p', 1, 2);
    assert.deepEqual(cmp12.resolved, [idA]);
    assert.deepEqual(cmp12.unchanged, [idB]);
  } finally {
    cleanup();
  }
});

test('项目之间相互隔离', () => {
  const { tracker, cleanup } = freshTracker();
  try {
    const files = [{ path: 'f.ts', content: 'alpha();' }];
    const finding = { rule: 'r', file: 'f.ts', line: 1, message: 'm' };
    const ra = tracker.ingest({ project: 'A', seq: 1, files, findings: [finding] });
    const rb = tracker.ingest({ project: 'B', seq: 1, files, findings: [finding] });
    assert.equal(ra.findings[0].id, 1);
    assert.equal(rb.findings[0].id, 1); // 编号项目内独立递增
    tracker.ingest({ project: 'A', seq: 2, files, findings: [] });
    const rb2 = tracker.ingest({ project: 'B', seq: 2, files, findings: [finding] });
    assert.equal(rb2.findings[0].status, 'carried'); // B 不受 A 关闭影响
  } finally {
    cleanup();
  }
});
