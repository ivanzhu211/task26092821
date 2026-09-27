/** 参与匹配的候选条目（老问题一侧） */
export interface OldEntry {
  /** 问题编号 */
  id: number;
  rule: string;
  file: string;
  line: number;
  message: string;
  fingerprint: string | null;
  /** 最后出现的快照序号（重开匹配排序用） */
  lastSeq: number;
}

/** 参与匹配的新发现 */
export interface NewEntry {
  /** 在入参列表中的下标 */
  index: number;
  rule: string;
  file: string;
  line: number;
  message: string;
  fingerprint: string | null;
}

type RoundKey = (line: number, message: string, fp: string | null) => string | null;

function pairKey(rule: string, file: string): string {
  return JSON.stringify([rule, file]);
}

/** 指纹为空（null 或全空白行得到的空串）时不参与第 4 轮 */
const ROUND_KEYS: RoundKey[] = [
  (line, message, fp) => JSON.stringify([line, message, fp]),
  (_line, message, fp) => JSON.stringify([message, fp]),
  (line, message) => JSON.stringify([line, message]),
  (_line, _message, fp) => (fp === null || fp === '' ? null : JSON.stringify(['fp', fp])),
];

function bucket<E>(entries: E[], keyOf: (e: E) => string | null): Map<string, E[]> {
  const map = new Map<string, E[]>();
  for (const e of entries) {
    const k = keyOf(e);
    if (k === null) continue;
    const b = map.get(k);
    if (b) b.push(e);
    else map.set(k, [e]);
  }
  return map;
}

/**
 * 四轮匹配。返回 newIndex -> oldId 的映射。
 * oldOrder: 'open' 时老侧按 (行号, 编号) 排序；'closed' 时按 (lastSeq 降序, 行号, 编号)。
 */
export function matchFourRounds(
  newSide: NewEntry[],
  oldSide: OldEntry[],
  oldOrder: 'open' | 'closed',
): Map<number, number> {
  const result = new Map<number, number>();
  if (newSide.length === 0 || oldSide.length === 0) return result;

  const oldCmp =
    oldOrder === 'open'
      ? (a: OldEntry, b: OldEntry) => a.line - b.line || a.id - b.id
      : (a: OldEntry, b: OldEntry) => b.lastSeq - a.lastSeq || a.line - b.line || a.id - b.id;

  // 按 (规则, 文件) 分组，每组内预先排好序；每轮结束后过滤掉已配对项，保持有序
  const newGroups = new Map<string, NewEntry[]>();
  for (const e of [...newSide].sort((a, b) => a.line - b.line || a.index - b.index)) {
    const k = pairKey(e.rule, e.file);
    const g = newGroups.get(k);
    if (g) g.push(e);
    else newGroups.set(k, [e]);
  }
  const oldGroups = new Map<string, OldEntry[]>();
  for (const e of [...oldSide].sort(oldCmp)) {
    const k = pairKey(e.rule, e.file);
    const g = oldGroups.get(k);
    if (g) g.push(e);
    else oldGroups.set(k, [e]);
  }

  for (const [k, news] of newGroups) {
    let unmatchedNew: NewEntry[] = news;
    let unmatchedOld = oldGroups.get(k);
    if (!unmatchedOld) continue;

    for (const roundKey of ROUND_KEYS) {
      if (unmatchedNew.length === 0 || unmatchedOld.length === 0) break;
      const nb = bucket(unmatchedNew, (e) => roundKey(e.line, e.message, e.fingerprint));
      const ob = bucket(unmatchedOld, (e) => roundKey(e.line, e.message, e.fingerprint));
      const usedNew = new Set<NewEntry>();
      const usedOld = new Set<OldEntry>();
      for (const [key, group] of nb) {
        const og = ob.get(key);
        if (!og) continue;
        const n = Math.min(group.length, og.length);
        for (let i = 0; i < n; i++) {
          result.set(group[i].index, og[i].id);
          usedNew.add(group[i]);
          usedOld.add(og[i]);
        }
      }
      unmatchedNew = unmatchedNew.filter((e) => !usedNew.has(e));
      unmatchedOld = unmatchedOld.filter((e) => !usedOld.has(e));
    }
  }
  return result;
}
