import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tracker, FindingInput, SourceFile } from '../src/index';

/**
 * 规模：单快照 5001 个文件、20 万条发现，
 * 其中一个生成代码文件含 5 万条同一规则的发现。
 */
const NORMAL_FILES = 5000;
const LINES_PER_FILE = 40;
const FINDINGS_PER_FILE = 30;
const GENERATED_FILE_FINDINGS = 50000;

function buildFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  for (let f = 0; f < NORMAL_FILES; f++) {
    const lines: string[] = [];
    for (let i = 0; i < LINES_PER_FILE; i++) lines.push(`stmt_${f}_${i}();`);
    files.push({ path: `src/mod${f % 50}/f${f}.ts`, content: lines.join('\n') });
  }
  const genLines: string[] = [];
  for (let i = 0; i < GENERATED_FILE_FINDINGS + 10; i++) genLines.push(`generated_call(${i % 100});`);
  files.push({ path: 'src/generated/gen.ts', content: genLines.join('\n') });
  return files;
}

function buildFindings(files: SourceFile[], shift: number, dropMod: number, tag: string): FindingInput[] {
  const findings: FindingInput[] = [];
  for (let fi = 0; fi < NORMAL_FILES; fi++) {
    for (let k = 0; k < FINDINGS_PER_FILE; k++) {
      if (dropMod > 0 && (fi * 31 + k * 7) % dropMod === 0) continue; // 删掉一部分
      findings.push({
        rule: `rule-${k % 5}`,
        file: files[fi].path,
        line: k + 1 + shift,
        message: `message ${k % 5} ${tag}`,
      });
    }
  }
  const genPath = files[files.length - 1].path;
  for (let i = 0; i < GENERATED_FILE_FINDINGS; i++) {
    if (dropMod > 0 && i % dropMod === 0) continue;
    findings.push({ rule: 'generated-rule', file: genPath, line: i + 1 + shift, message: 'generated issue' });
  }
  return findings;
}

test('性能：20 万条发现入库 < 30s，对比 < 3s', { timeout: 120000 }, () => {
  const dbPath = path.join(os.tmpdir(), `tracker-perf-${process.pid}.db`);
  const tracker = new Tracker(dbPath);
  try {
    const files1 = buildFiles();
    const findings1 = buildFindings(files1, 0, 0, 'v1');
    assert.equal(findings1.length, NORMAL_FILES * FINDINGS_PER_FILE + GENERATED_FILE_FINDINGS);

    let t0 = performance.now();
    const r1 = tracker.ingest({ project: 'perf', seq: 1, files: files1, findings: findings1 });
    const ingest1Ms = performance.now() - t0;
    assert.equal(r1.findings.length, findings1.length);

    // 第二次扫描：每个文件顶部插入 3 行（行号整体下移），删掉约 5%，消息改一批
    const files2 = files1.map((f) => ({ path: f.path, content: 'h1;\nh2;\nh3;\n' + f.content }));
    const findings2 = buildFindings(files2, 3, 20, 'v2');
    // 新增一小批全新发现
    for (let i = 0; i < 5000; i++) {
      findings2.push({ rule: 'rule-new', file: files2[i].path, line: 38, message: 'brand new' });
    }

    t0 = performance.now();
    const r2 = tracker.ingest({ project: 'perf', seq: 2, files: files2, findings: findings2 });
    const ingest2Ms = performance.now() - t0;

    t0 = performance.now();
    const cmp = tracker.compare('perf', 1, 2);
    const compareMs = performance.now() - t0;

    console.log(
      `  [perf] findings=${findings1.length}/${findings2.length} ` +
        `ingest1=${ingest1Ms.toFixed(0)}ms ingest2=${ingest2Ms.toFixed(0)}ms compare=${compareMs.toFixed(0)}ms ` +
        `carried=${r2.findings.filter((f) => f.status === 'carried').length} ` +
        `closed=${r2.closed.length} unchanged=${cmp.unchanged.length} resolved=${cmp.resolved.length} added=${cmp.added.length}`,
    );

    assert.ok(ingest1Ms < 30000, `ingest1 took ${ingest1Ms}ms`);
    assert.ok(ingest2Ms < 30000, `ingest2 took ${ingest2Ms}ms`);
    assert.ok(compareMs < 3000, `compare took ${compareMs}ms`);

    // 正确性抽查：行号下移后绝大多数老发现应沿用编号
    const carried = r2.findings.filter((f) => f.status === 'carried').length;
    assert.ok(carried > findings2.length * 0.8, `carried=${carried}`);
  } finally {
    tracker.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});
