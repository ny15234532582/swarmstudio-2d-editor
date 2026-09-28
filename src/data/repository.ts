/**
 * 仓储层：所有 SQL 都集中在这里。
 *
 * 该层不依赖 Vue / Pixi / Worker，只依赖 sqlite3 的 Database 接口，
 * 因此既能在浏览器 Worker 里跑，也能在 Node + 内存库下做单元测试。
 *
 * 持久化策略：
 * - 点位增删移改、锁定、分组归属 → 按 mutation 增量写；
 * - 分组结构与历史 → 每次整体覆盖（数量小，覆盖更简单且不会不一致）。
 */
import type { Database, PreparedStatement } from '@sqlite.org/sqlite-wasm'
import { HISTORY_LIMIT, type Mutation, type Operation } from '../core/operations'
import type { Group, Point, ProjectMeta } from '../core/types'
import type { LoadedProject, ProjectRecord } from './protocol'

type Row = Array<number | string | null | Uint8Array>

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
}
function str(v: unknown): string {
  return v == null ? '' : String(v)
}
function isTrue(v: unknown): boolean {
  return v === 1 || v === true || v === '1'
}

const POINT_COLUMNS = 'project_id,id,x,y,z,r,g,b,group_id,locked'
const POINT_PLACEHOLDERS = '?,?,?,?,?,?,?,?,?,?'

function bindPoint(stmt: PreparedStatement, projectId: string, p: Point): void {
  stmt
    .bind([projectId, p.id, p.x, p.y, p.z, p.r, p.g, p.b, p.groupId ?? null, p.locked ? 1 : 0])
    .stepReset()
}

export function insertProject(db: Database, project: ProjectRecord): void {
  db.prepare('INSERT INTO projects(id,name,version,created_at,updated_at) VALUES(?,?,?,?,?)')
    .bind([project.id, project.name, project.version, project.createdAt, project.updatedAt])
    .stepFinalize()
}

export function renameProject(db: Database, projectId: string, name: string): void {
  db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
    .bind([name, Date.now(), projectId])
    .stepFinalize()
}

export function deleteProject(db: Database, projectId: string): void {
  // points / history / groups 通过外键 ON DELETE CASCADE 一起清除
  db.prepare('DELETE FROM projects WHERE id = ?').bind([projectId]).stepFinalize()
}

export function listProjects(db: Database): ProjectMeta[] {
  const rows = db.selectArrays(
    `SELECT p.id, p.name, p.version, p.created_at, p.updated_at, COUNT(pt.id)
       FROM projects p
       LEFT JOIN points pt ON pt.project_id = p.id
       GROUP BY p.id
       ORDER BY p.updated_at DESC`,
  ) as Row[]
  return rows.map((r) => ({
    id: str(r[0]),
    name: str(r[1]),
    version: num(r[2]),
    createdAt: num(r[3]),
    updatedAt: num(r[4]),
    pointCount: num(r[5]),
  }))
}

function readPoints(db: Database, projectId: string): Point[] {
  const rows = db.selectArrays(
    'SELECT id,x,y,z,r,g,b,group_id,locked FROM points WHERE project_id = ? ORDER BY rowid ASC',
    [projectId],
  ) as Row[]
  return rows.map((r) => {
    const point: Point = {
      id: str(r[0]),
      x: num(r[1]),
      y: num(r[2]),
      z: num(r[3]),
      r: num(r[4]),
      g: num(r[5]),
      b: num(r[6]),
    }
    if (r[7] != null) point.groupId = str(r[7])
    if (isTrue(r[8])) point.locked = true
    return point
  })
}

function readGroups(db: Database, projectId: string): Group[] {
  const rows = db.selectArrays(
    'SELECT id,name,color_r,color_g,color_b FROM groups WHERE project_id = ? ORDER BY rowid ASC',
    [projectId],
  ) as Row[]
  return rows.map((r) => ({
    id: str(r[0]),
    name: str(r[1]),
    color: { r: num(r[2]), g: num(r[3]), b: num(r[4]) },
  }))
}

function readHistory(db: Database, projectId: string): Operation[] {
  const rows = db.selectArrays(
    'SELECT op FROM history WHERE project_id = ? ORDER BY seq ASC',
    [projectId],
  ) as Row[]
  const ops: Operation[] = []
  for (const r of rows) {
    try {
      ops.push(JSON.parse(str(r[0])) as Operation)
    } catch {
      // 单条历史损坏不影响项目加载
    }
  }
  return ops
}

export function loadProject(db: Database, projectId: string): LoadedProject | null {
  const rows = db.selectArrays(
    'SELECT id,name,version,created_at,updated_at FROM projects WHERE id = ?',
    [projectId],
  ) as Row[]
  const meta = rows[0]
  if (!meta) return null
  return {
    project: {
      id: str(meta[0]),
      name: str(meta[1]),
      version: num(meta[2]),
      createdAt: num(meta[3]),
      updatedAt: num(meta[4]),
      points: readPoints(db, projectId),
      groups: readGroups(db, projectId),
    },
    history: readHistory(db, projectId),
  }
}

export function saveHistory(db: Database, projectId: string, ops: Operation[]): void {
  db.prepare('DELETE FROM history WHERE project_id = ?').bind([projectId]).stepFinalize()
  const recent = ops.slice(-HISTORY_LIMIT)
  if (recent.length === 0) return
  const stmt = db.prepare(
    'INSERT INTO history(project_id,seq,label,op,created_at) VALUES(?,?,?,?,?)',
  )
  const now = Date.now()
  recent.forEach((op, index) => {
    stmt.bind([projectId, index, op.label, JSON.stringify(op), now]).stepReset()
  })
  stmt.finalize()
}

/** 分组结构整体覆盖保存 */
export function saveGroups(db: Database, projectId: string, groups: Group[]): void {
  db.prepare('DELETE FROM groups WHERE project_id = ?').bind([projectId]).stepFinalize()
  if (groups.length === 0) return
  const stmt = db.prepare(
    'INSERT INTO groups(project_id,id,name,color_r,color_g,color_b) VALUES(?,?,?,?,?,?)',
  )
  for (const g of groups) {
    stmt.bind([projectId, g.id, g.name, g.color.r, g.color.g, g.color.b]).stepReset()
  }
  stmt.finalize()
}

function applyMutation(db: Database, projectId: string, mutation: Mutation): void {
  switch (mutation.type) {
    case 'add': {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO points(${POINT_COLUMNS}) VALUES(${POINT_PLACEHOLDERS})`,
      )
      for (const p of mutation.points) bindPoint(stmt, projectId, p)
      stmt.finalize()
      break
    }
    case 'remove': {
      const stmt = db.prepare('DELETE FROM points WHERE project_id = ? AND id = ?')
      for (const id of mutation.ids) stmt.bind([projectId, id]).stepReset()
      stmt.finalize()
      break
    }
    case 'move': {
      const stmt = db.prepare('UPDATE points SET x = ?, y = ? WHERE project_id = ? AND id = ?')
      for (const u of mutation.updates) stmt.bind([u.x, u.y, projectId, u.id]).stepReset()
      stmt.finalize()
      break
    }
    case 'color': {
      const stmt = db.prepare(
        'UPDATE points SET r = ?, g = ?, b = ? WHERE project_id = ? AND id = ?',
      )
      for (const id of mutation.ids) {
        stmt.bind([mutation.color.r, mutation.color.g, mutation.color.b, projectId, id]).stepReset()
      }
      stmt.finalize()
      break
    }
    case 'setGroup': {
      const stmt = db.prepare('UPDATE points SET group_id = ? WHERE project_id = ? AND id = ?')
      for (const [id, groupId] of mutation.entries) {
        stmt.bind([groupId, projectId, id]).stepReset()
      }
      stmt.finalize()
      break
    }
    case 'setLocked': {
      const stmt = db.prepare('UPDATE points SET locked = ? WHERE project_id = ? AND id = ?')
      for (const [id, locked] of mutation.entries) {
        stmt.bind([locked ? 1 : 0, projectId, id]).stepReset()
      }
      stmt.finalize()
      break
    }
  }
}

function touchProject(db: Database, projectId: string): void {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
    .bind([Date.now(), projectId])
    .stepFinalize()
}

/**
 * 增量写入：应用一批已提交的 mutation，并覆盖保存历史与分组结构，全在同一个事务里。
 */
export function applyChanges(
  db: Database,
  projectId: string,
  mutations: Mutation[],
  history: Operation[],
  groups: Group[],
): void {
  db.transaction(() => {
    for (const mutation of mutations) applyMutation(db, projectId, mutation)
    saveHistory(db, projectId, history)
    saveGroups(db, projectId, groups)
    touchProject(db, projectId)
  })
}

/** 全量替换点位（用于导入 / 加载测试数据） */
export function replacePoints(
  db: Database,
  projectId: string,
  points: Point[],
  history: Operation[],
  groups: Group[],
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM points WHERE project_id = ?').bind([projectId]).stepFinalize()
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO points(${POINT_COLUMNS}) VALUES(${POINT_PLACEHOLDERS})`,
    )
    for (const p of points) bindPoint(stmt, projectId, p)
    stmt.finalize()
    saveHistory(db, projectId, history)
    saveGroups(db, projectId, groups)
    touchProject(db, projectId)
  })
}
