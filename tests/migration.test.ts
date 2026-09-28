import { beforeAll, describe, expect, it } from 'vitest'
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { hasColumn, migrate, SCHEMA_VERSION } from '../src/data/schema'
import * as repo from '../src/data/repository'
import type { Point } from '../src/core/types'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

/** v1 时期的结构：points 没有 locked，且没有 groups 表 */
const LEGACY_V1_DDL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE points (
  project_id TEXT NOT NULL, id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  r INTEGER NOT NULL, g INTEGER NOT NULL, b INTEGER NOT NULL, group_id TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE history (
  project_id TEXT NOT NULL, seq INTEGER NOT NULL, label TEXT NOT NULL, op TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (project_id, seq),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
`

const PROJECT = { id: 'p1', name: 'p', version: 2, createdAt: 1, updatedAt: 1 }
const point = (id: string): Point => ({ id, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 })

function legacyDb(): Database {
  const db = new sqlite3.oo1.DB(':memory:', 'c')
  db.exec(LEGACY_V1_DDL)
  return db
}

describe('schema migrate（幂等 / 自愈）', () => {
  it('空库迁移后结构完整', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    migrate(db)
    expect(hasColumn(db, 'points', 'locked')).toBe(true)
    expect(Number(db.selectArrays('PRAGMA user_version')[0][0])).toBe(SCHEMA_VERSION)
  })

  it('重复迁移不报错', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
  })

  it('v1 老库升级：补上 locked 列与 groups 表，旧数据保留', () => {
    const db = legacyDb()
    db.exec('PRAGMA user_version = 1')
    repo.insertProject(db, PROJECT)
    db.exec(
      "INSERT INTO points(project_id,id,x,y,z,r,g,b,group_id) VALUES('p1','a',1,1,0,0,0,0,NULL)",
    )

    migrate(db)

    expect(hasColumn(db, 'points', 'locked')).toBe(true)
    expect(Number(db.selectArrays('PRAGMA user_version')[0][0])).toBe(SCHEMA_VERSION)
    const loaded = repo.loadProject(db, PROJECT.id)!
    expect(loaded.project.points).toHaveLength(1)
    expect(loaded.project.points[0].locked).toBeUndefined()
    expect(loaded.project.groups).toEqual([])
  })

  it('自愈：user_version 已是最新但缺 locked 列 / groups 表，也能补齐', () => {
    const db = legacyDb()
    // 模拟「版本号被骗到 2，但结构没跟上」的坏状态
    db.exec('PRAGMA user_version = 2')
    expect(hasColumn(db, 'points', 'locked')).toBe(false)

    migrate(db)

    expect(hasColumn(db, 'points', 'locked')).toBe(true)
    // 补齐后写入必须成功（这正是 no such column: locked 的场景）
    repo.insertProject(db, PROJECT)
    expect(() => repo.replacePoints(db, PROJECT.id, [point('a')], [], [])).not.toThrow()
    expect(repo.loadProject(db, PROJECT.id)!.project.points).toHaveLength(1)
  })
})
