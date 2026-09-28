import { beforeEach, describe, expect, it } from 'vitest'
import { EditorStore } from '../src/state/store'
import { createProject } from '../src/core/factory'
import type { Point } from '../src/core/types'

function point(id: string, x = 0, y = 0): Point {
  return { id, x, y, z: 0, r: 0, g: 0, b: 0 }
}

describe('分组与锁定', () => {
  let store: EditorStore

  beforeEach(() => {
    store = new EditorStore(createProject('测试项目'))
    store.addPoints([point('a', 1, 1), point('b', 2, 2), point('c', 3, 3)])
    store.clearSelection()
  })

  it('成组：新建组并归入选中点', () => {
    store.selectMany(['a', 'b'])
    const group = store.groupSelection('机翼')
    expect(group).not.toBeNull()
    expect(store.groups).toHaveLength(1)
    expect(store.getGroupMemberCount(group!.id)).toBe(2)
    expect(store.getPoint('a')?.groupId).toBe(group!.id)
    expect(store.getPoint('b')?.groupId).toBe(group!.id)
    expect(store.getPoint('c')?.groupId).toBeUndefined()
  })

  it('成组可撤销 / 重做', () => {
    store.selectMany(['a', 'b'])
    const group = store.groupSelection('机翼')!
    store.undo()
    expect(store.groups).toHaveLength(0)
    expect(store.getPoint('a')?.groupId).toBeUndefined()
    store.redo()
    expect(store.groups).toHaveLength(1)
    expect(store.getPoint('a')?.groupId).toBe(group.id)
  })

  it('取消分组：清空归属并移除组，可撤销', () => {
    store.selectMany(['a', 'b'])
    const group = store.groupSelection()!
    store.ungroup(group.id)
    expect(store.groups).toHaveLength(0)
    expect(store.getPoint('a')?.groupId).toBeUndefined()

    store.undo()
    expect(store.groups).toHaveLength(1)
    expect(store.getPoint('a')?.groupId).toBe(group.id)
    expect(store.getPoint('b')?.groupId).toBe(group.id)
  })

  it('重新成组会把点从旧组移到新组', () => {
    store.selectMany(['a', 'b'])
    const g1 = store.groupSelection('A')!
    store.selectMany(['b'])
    const g2 = store.groupSelection('B')!
    expect(store.getPoint('b')?.groupId).toBe(g2.id)
    expect(store.getGroupMemberCount(g1.id)).toBe(1)
  })

  it('锁定后不可选中、不可删除', () => {
    store.selectMany(['a', 'b'])
    store.setLockedForSelection(true)

    // 锁定会把点移出选择
    expect(store.selection.size).toBe(0)
    expect(store.getPoint('a')?.locked).toBe(true)

    // 尝试选中锁定点会被忽略
    store.select('a')
    expect(store.selection.size).toBe(0)

    // 锁定点不允许删除
    store.deletePoints(['a'])
    expect(store.getPoint('a')).toBeDefined()

    // 解锁后可正常选中
    store.unlockAll()
    store.select('a')
    expect(store.selection.size).toBe(1)
  })

  it('锁定可撤销', () => {
    store.selectMany(['a'])
    store.setLockedForSelection(true)
    expect(store.getPoint('a')?.locked).toBe(true)
    store.undo()
    expect(store.getPoint('a')?.locked).toBeUndefined()
    // 撤销只恢复数据；选择属于界面状态，不随撤销恢复
    expect(store.selection.size).toBe(0)
    // 解锁后该点重新可被选中
    store.select('a')
    expect(store.selection.has('a')).toBe(true)
  })

  it('组锁定 = 批量锁定组内点，isGroupLocked 反映状态', () => {
    store.selectMany(['a', 'b'])
    const group = store.groupSelection()!
    store.setLockedForGroup(group.id, true)
    expect(store.isGroupLocked(group.id)).toBe(true)
    expect(store.getPoint('a')?.locked).toBe(true)
    expect(store.getPoint('b')?.locked).toBe(true)

    store.setLockedForGroup(group.id, false)
    expect(store.isGroupLocked(group.id)).toBe(false)
  })

  it('selectGroup 只选中未锁定的组员', () => {
    store.selectMany(['a', 'b'])
    const group = store.groupSelection()!
    store.setLocked(['b'], true)
    store.selectGroup(group.id)
    expect(store.selection.has('a')).toBe(true)
    expect(store.selection.has('b')).toBe(false)
  })
})
