import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  finding_count INTEGER NOT NULL,
  PRIMARY KEY (project, seq)
);

CREATE TABLE IF NOT EXISTS issues (
  project TEXT NOT NULL,
  id INTEGER NOT NULL,
  rule TEXT NOT NULL,
  file TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  last_line INTEGER NOT NULL,
  last_message TEXT NOT NULL,
  last_fingerprint TEXT,
  status TEXT NOT NULL,          -- 'open' | 'closed'
  closed_seq INTEGER,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS idx_issues_closed ON issues(project, status, closed_seq);

CREATE TABLE IF NOT EXISTS findings (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ord INTEGER NOT NULL,          -- 在入参 findings 中的下标
  issue_id INTEGER NOT NULL,
  status TEXT NOT NULL,          -- 'carried' | 'reopened' | 'new'
  rule TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  message TEXT NOT NULL,
  fingerprint TEXT,
  PRIMARY KEY (project, seq, ord)
);
CREATE INDEX IF NOT EXISTS idx_findings_issue ON findings(project, issue_id);

CREATE TABLE IF NOT EXISTS closures (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  issue_id INTEGER NOT NULL,
  PRIMARY KEY (project, seq, issue_id)
);
`;

/** 打开（必要时创建）数据库并初始化 schema */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
