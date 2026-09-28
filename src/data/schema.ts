/**
 * 数据库结构与迁移。
 *
 * 两套版本分开管理（对应题目 6.1「项目版本与未来数据格式升级」）：
 * - PRAGMA user_version：**数据库结构**版本；
 * - projects.version：**项目数据格式**版本，随项目一起保存。
 *
 * 重要：迁移**不单纯依赖 user_version**，而是直接检查真实的表 / 列是否存在，
 * 做到幂等且自愈。否则一旦版本号被写成最新、但结构没落到库里，
 * 就会出现 `no such column: locked` 这类错误，且无法自动恢复。
 */
import type { Database } from '@sqlite.org/sqlite-wasm'

export const SCHEMA_VERSION = 2

/** v1：基础结构（全部 IF NOT EXISTS，可安全重复执行） */
const DDL_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS points (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          REAL NOT NULL,
  r          INTEGER NOT NULL,
  g          INTEGER NOT NULL,
  b          INTEGER NOT NULL,
  group_id   TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_points_project ON points(project_id);

CREATE TABLE IF NOT EXISTS history (
  project_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  label      TEXT NOT NULL,
  op         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, seq),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
`

/** v2：分组表（IF NOT EXISTS，可重复执行） */
const DDL_V2_GROUPS = `
CREATE TABLE IF NOT EXISTS groups (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  color_r    INTEGER NOT NULL,
  color_g    INTEGER NOT NULL,
  color_b    INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
`

/** v2：点位锁定列（ALTER 不支持 IF NOT EXISTS，需先探测） */
const DDL_V2_LOCKED_COLUMN = 'ALTER TABLE points ADD COLUMN locked INTEGER NOT NULL DEFAULT 0'

function readUserVersion(db: Database): number {
  const row = db.selectArrays('PRAGMA user_version')[0]
  return row ? Number(row[0]) : 0
}

/** PRAGMA table_info 的第二列是列名 */
export function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.selectArrays(`PRAGMA table_info(${table})`) as Array<Array<unknown>>
  return rows.some((r) => String(r[1]) === column)
}

export function migrate(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON')
  const current = readUserVersion(db)

  // v1：基础表
  db.exec(DDL_V1)

  // v2：补齐锁定列与分组表
  // 无论 user_version 是多少，只要结构缺失就补上（自愈）
  if (!hasColumn(db, 'points', 'locked')) {
    db.exec(DDL_V2_LOCKED_COLUMN)
  }
  db.exec(DDL_V2_GROUPS)

  // 版本号只作为记录与未来「破坏性迁移」的判断依据
  if (current !== SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
}
