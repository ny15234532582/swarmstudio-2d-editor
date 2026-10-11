import { beforeAll, describe, expect, it } from 'vitest'
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { migrate, SCHEMA_VERSION } from '../src/data/schema'
import * as repo from '../src/data/repository'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

function tableNames(db: Database): Set<string> {
  const rows = db.selectArrays("SELECT name FROM sqlite_master WHERE type='table'") as Array<
    Array<unknown>
  >
  return new Set(rows.map((r) => String(r[0])))
}

const PROJECT = {
  id: 'p1',
  name: 'p',
  version: 3,
  droneCount: 100,
  createdAt: 1,
  updatedAt: 1,
}

describe('schema migrate（结构就绪 / 版本不一致时重建）', () => {
  it('空库迁移后结构完整', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    migrate(db)
    expect(Number(db.selectArrays('PRAGMA user_version')[0][0])).toBe(SCHEMA_VERSION)
    const names = tableNames(db)
    for (const t of ['projects', 'tracks', 'frames', 'points', 'transitions', 'groups', 'history', 'transition_renders']) {
      expect(names.has(t)).toBe(true)
    }
  })

  it('重复迁移不报错', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
  })

  it('版本不一致时重建：旧数据被丢弃、新结构就绪', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    // 模拟旧结构：一个只有 projects 表的 v1 库
    db.exec(
      'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    )
    db.exec("INSERT INTO projects(id,name,version,created_at,updated_at) VALUES('old','old',1,1,1)")
    db.exec('PRAGMA user_version = 1')

    migrate(db)

    expect(Number(db.selectArrays('PRAGMA user_version')[0][0])).toBe(SCHEMA_VERSION)
    // 旧数据已随重建丢弃
    expect(Number(db.selectArrays('SELECT COUNT(*) FROM projects')[0][0])).toBe(0)
    // 新结构可正常写入与读取
    repo.insertProject(db, PROJECT)
    repo.replaceData(db, PROJECT.id, [], [], [], [])
    expect(repo.loadProject(db, PROJECT.id)!.project.droneCount).toBe(100)
  })

  it('自愈：版本号已是最新但缺列，也会重建', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c')
    // 造一个「版本号=SCHEMA_VERSION，但 projects 缺 drone_max_speed 列」的坏状态
    db.exec(
      'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, drone_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    )
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)

    migrate(db)

    // 修复后可正常插入（否则会 no such column: drone_max_speed）
    expect(() => repo.insertProject(db, PROJECT)).not.toThrow()
    expect(repo.loadProject(db, PROJECT.id)!.project.droneCount).toBe(100)
  })
})
