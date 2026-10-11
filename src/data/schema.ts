/**
 * 数据库结构与迁移。
 *
 * 本项目不兼容历史结构：结构版本变化时直接**重建**（丢弃旧表），
 * 仅用 PRAGMA user_version 记录当前结构版本。
 *
 * 表：projects / tracks / frames / points / transitions / groups / history。
 */
import type { Database } from '@sqlite.org/sqlite-wasm'

/** 当前数据库结构版本；项目数据格式版本另存于 projects.version */
export const SCHEMA_VERSION = 6

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  drone_count INTEGER NOT NULL,
  drone_max_speed REAL NOT NULL DEFAULT 0,
  drone_max_accel REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS frames (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  track_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  thumbnail   TEXT NOT NULL,
  width       REAL NOT NULL,
  height      REAL NOT NULL,
  duration    REAL NOT NULL,
  source      TEXT,
  params      TEXT,
  order_index INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_frames_project ON frames(project_id);

CREATE TABLE IF NOT EXISTS points (
  project_id TEXT NOT NULL,
  frame_id   TEXT NOT NULL,
  id         TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          REAL NOT NULL,
  r          INTEGER NOT NULL,
  g          INTEGER NOT NULL,
  b          INTEGER NOT NULL,
  drone_index INTEGER,
  group_id   TEXT,
  locked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_points_project ON points(project_id);
CREATE INDEX IF NOT EXISTS idx_points_frame ON points(project_id, frame_id);

CREATE TABLE IF NOT EXISTS transitions (
  id            TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  track_id      TEXT NOT NULL,
  from_frame_id TEXT NOT NULL,
  to_frame_id   TEXT NOT NULL,
  duration      REAL NOT NULL,
  algorithm     TEXT NOT NULL,
  path          TEXT NOT NULL,
  easing        TEXT NOT NULL,
  velocity_profile TEXT NOT NULL DEFAULT 'ease',
  stagger       REAL NOT NULL DEFAULT 0,
  params        TEXT NOT NULL,
  order_index   INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS transition_renders (
  project_id    TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  signature     TEXT NOT NULL,
  algorithm     TEXT NOT NULL,
  payload       TEXT NOT NULL,
  elapsed_ms    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, transition_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

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

/** 需要重建时丢弃的旧表（含历史版本可能存在的 images 表） */
const DROP_ALL = `
DROP TABLE IF EXISTS history;
DROP TABLE IF EXISTS transition_renders;
DROP TABLE IF EXISTS transitions;
DROP TABLE IF EXISTS points;
DROP TABLE IF EXISTS frames;
DROP TABLE IF EXISTS tracks;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS projects;
`

function readUserVersion(db: Database): number {
  const row = db.selectArrays('PRAGMA user_version')[0]
  return row ? Number(row[0]) : 0
}

/** 表是否存在 */
function hasTable(db: Database, table: string): boolean {
  const rows = db.selectArrays(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    [table],
  ) as Array<Array<unknown>>
  return rows.length > 0
}

/** 表是否含某列（PRAGMA table_info 第 2 列是列名） */
function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false
  const rows = db.selectArrays(`PRAGMA table_info(${table})`) as Array<Array<unknown>>
  return rows.some((r) => String(r[1]) === column)
}

/**
 * 结构是否完整：不仅看版本号，还探测关键列。
 * 只信版本号会出「版本号已最新、结构却没跟上」的坏状态（no such column），
 * 因此这里做结构探测实现自愈。
 */
function schemaIntact(db: Database, version: number): boolean {
  return (
    version === SCHEMA_VERSION &&
    hasTable(db, 'projects') &&
    hasColumn(db, 'projects', 'drone_max_speed') &&
    hasColumn(db, 'points', 'frame_id') &&
    hasColumn(db, 'frames', 'source') &&
    hasColumn(db, 'transitions', 'velocity_profile') &&
    hasTable(db, 'tracks')
  )
}

/**
 * 结构就绪：版本不一致或关键列缺失时直接重建（本项目不保留历史数据），
 * 否则仅确保表/索引存在（幂等）。
 */
export function migrate(db: Database): void {
  // 外键必须每个连接单独开启，否则 ON DELETE CASCADE 不生效
  db.exec('PRAGMA foreign_keys = ON')
  const current = readUserVersion(db)
  if (!schemaIntact(db, current)) {
    db.exec(DROP_ALL)
    db.exec(DDL)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    return
  }
  // 结构完好：仅补齐可能缺失的索引 / 表（幂等）
  db.exec(DDL)
}
