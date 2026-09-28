import { beforeAll, describe, expect, it } from 'vitest'
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { migrate, SCHEMA_VERSION } from '../src/data/schema'
import * as repo from '../src/data/repository'
import type { Operation } from '../src/core/operations'
import type { Point } from '../src/core/types'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

function createDb(): Database {
  const db = new sqlite3.oo1.DB(':memory:', 'c')
  migrate(db)
  return db
}

function point(id: string, x = 0, y = 0, z = 0, r = 0, g = 0, b = 0): Point {
  return { id, x, y, z, r, g, b }
}

const PROJECT = {
  id: 'proj_1',
  name: '测试项目',
  version: 1,
  createdAt: 1000,
  updatedAt: 1000,
}

describe('repository / schema', () => {
  it('迁移后 user_version 正确且幂等', () => {
    const db = createDb()
    expect(Number(db.selectArrays('PRAGMA user_version')[0][0])).toBe(SCHEMA_VERSION)
    migrate(db) // 再来一次不应报错
    expect(Number(db.selectArrays('PRAGMA user_version')[0][0])).toBe(SCHEMA_VERSION)
  })

  it('创建项目、列出项目并统计点数', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    repo.replacePoints(db, PROJECT.id, [point('a'), point('b')], [], [])
    const list = repo.listProjects(db)
    expect(list).toHaveLength(1)
    expect(list[0].pointCount).toBe(2)
  })

  it('加载项目会带上点位与历史', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    const history: Operation[] = [{ kind: 'add', label: '新增点', points: [point('a', 1, 2, 3)] }]
    repo.replacePoints(db, PROJECT.id, [point('a', 1, 2, 3, 4, 5, 6)], history, [])
    const loaded = repo.loadProject(db, PROJECT.id)!
    expect(loaded.project.points[0]).toMatchObject({ id: 'a', x: 1, z: 3, b: 6 })
    expect(loaded.history).toHaveLength(1)
    expect(loaded.history[0].kind).toBe('add')
  })

  it('增量写入：新增 / 移动 / 改色 / 删除', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    repo.applyChanges(
      db,
      PROJECT.id,
      [{ type: 'add', points: [point('a', 1, 1), point('b', 2, 2)] }],
      [{ kind: 'add', label: '新增点', points: [point('a', 1, 1), point('b', 2, 2)] }],
      [],
    )
    repo.applyChanges(
      db,
      PROJECT.id,
      [
        { type: 'move', updates: [{ id: 'a', x: 9, y: 9 }] },
        { type: 'color', ids: ['b'], color: { r: 10, g: 20, b: 30 } },
      ],
      [],
      [],
    )
    let loaded = repo.loadProject(db, PROJECT.id)!
    expect(loaded.project.points.find((p) => p.id === 'a')).toMatchObject({ x: 9, y: 9 })
    expect(loaded.project.points.find((p) => p.id === 'b')).toMatchObject({ r: 10, g: 20, b: 30 })

    repo.applyChanges(db, PROJECT.id, [{ type: 'remove', ids: ['a'] }], [], [])
    loaded = repo.loadProject(db, PROJECT.id)!
    expect(loaded.project.points).toHaveLength(1)
    expect(loaded.project.points[0].id).toBe('b')
  })

  it('history 表只保留最近 100 条', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    const ops: Operation[] = Array.from({ length: 150 }, (_, i) => ({
      kind: 'add' as const,
      label: `op-${i}`,
      points: [point(`p${i}`)],
    }))
    repo.saveHistory(db, PROJECT.id, ops)
    const loaded = repo.loadProject(db, PROJECT.id)!
    expect(loaded.history).toHaveLength(100)
    expect(loaded.history[0].label).toBe('op-50')
    expect(loaded.history.at(-1)!.label).toBe('op-149')
  })

  it('删除项目会级联删除点位与历史', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    repo.replacePoints(
      db,
      PROJECT.id,
      [point('a')],
      [{ kind: 'add', label: 'x', points: [point('a')] }],
      [],
    )
    repo.deleteProject(db, PROJECT.id)
    expect(repo.loadProject(db, PROJECT.id)).toBeNull()
    expect(Number(db.selectArrays('SELECT COUNT(*) FROM points')[0][0])).toBe(0)
    expect(Number(db.selectArrays('SELECT COUNT(*) FROM history')[0][0])).toBe(0)
  })

  it('点位锁定状态可持久化', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    repo.replacePoints(
      db,
      PROJECT.id,
      [{ ...point('a'), locked: true }, { ...point('b'), locked: true }],
      [],
      [],
    )
    // 解锁 b（mutation.entries 表示「设置为该值」）
    repo.applyChanges(db, PROJECT.id, [{ type: 'setLocked', entries: [['b', false]] }], [], [])
    const loaded = repo.loadProject(db, PROJECT.id)!
    expect(loaded.project.points.find((p) => p.id === 'a')?.locked).toBe(true)
    expect(loaded.project.points.find((p) => p.id === 'b')?.locked).toBeUndefined()
  })

  it('分组结构与归属可持久化', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    const group = { id: 'g1', name: '机翼', color: { r: 10, g: 20, b: 30 } }
    repo.replacePoints(db, PROJECT.id, [point('a'), point('b')], [], [group])
    repo.applyChanges(
      db,
      PROJECT.id,
      [{ type: 'setGroup', entries: [['a', 'g1']] }],
      [],
      [group],
    )
    const loaded = repo.loadProject(db, PROJECT.id)!
    expect(loaded.project.groups).toEqual([group])
    expect(loaded.project.points.find((p) => p.id === 'a')?.groupId).toBe('g1')
    expect(loaded.project.points.find((p) => p.id === 'b')?.groupId).toBeUndefined()

    // 删除分组后整体覆盖为空
    repo.applyChanges(db, PROJECT.id, [{ type: 'setGroup', entries: [['a', null]] }], [], [])
    const after = repo.loadProject(db, PROJECT.id)!
    expect(after.project.groups).toHaveLength(0)
    expect(after.project.points.find((p) => p.id === 'a')?.groupId).toBeUndefined()
  })

  it('分组随项目级联删除', () => {
    const db = createDb()
    repo.insertProject(db, PROJECT)
    repo.replacePoints(db, PROJECT.id, [], [], [{ id: 'g1', name: 'g', color: { r: 1, g: 2, b: 3 } }])
    repo.deleteProject(db, PROJECT.id)
    expect(Number(db.selectArrays('SELECT COUNT(*) FROM groups')[0][0])).toBe(0)
  })
})
