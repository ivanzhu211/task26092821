/** 上层平台提交的一个源文件 */
export interface SourceFile {
  path: string;
  content: string;
}

/** 一条扫描发现；line 为 1 起始行号，0 表示整文件级别 */
export interface FindingInput {
  rule: string;
  file: string;
  line: number;
  message: string;
}

/** 一次扫描快照的入库入参 */
export interface SnapshotInput {
  project: string;
  seq: number;
  files: SourceFile[];
  findings: FindingInput[];
}

/** 发现在本快照中的状态 */
export type FindingStatus = 'carried' | 'reopened' | 'new';

export interface FindingResult {
  id: number;
  status: FindingStatus;
}

export interface IngestResult {
  project: string;
  seq: number;
  /** 与入参 findings 同序 */
  findings: FindingResult[];
  /** 在本快照关闭的问题编号（升序） */
  closed: number[];
  /** true 表示该序号此前已入库，本次为重复提交，结果为首次结果 */
  duplicate: boolean;
}

export interface CompareResult {
  /** 只在 B 中、且首次出现不晚于 A */
  regression: number[];
  /** 只在 B 中、且首次出现晚于 A */
  added: number[];
  /** 只在 A 中 */
  resolved: number[];
  /** 两边都有 */
  unchanged: number[];
}

/** 序号不递增（且非已入库的重复提交） */
export class SequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceError';
  }
}

/** 快照不存在或已超出保留窗口 */
export class SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotUnavailableError';
  }
}
