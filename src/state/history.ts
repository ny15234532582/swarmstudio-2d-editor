/**
 * 历史管理：双栈 Undo/Redo，元素是序列化的 Operation。
 *
 * 设计说明（对应题目 4.3）：
 * - 历史栈里保存的是纯数据 Operation，而不是闭包/类实例，
 *   因此可以直接序列化进 SQLite（见 data/repository 的 history 表）。
 * - 连续拖动由交互层在拖动结束时提交**一条** move Operation，
 *   pointermove 期间只做瞬时预览，不写历史。
 * - Undo 后重新编辑会清空 redo 栈（新操作即丢弃 redo）。
 * - 体积控制：move/color 只存增量坐标，不存整份项目快照；
 *   栈深度上限默认 100，与 SQLite 中保留的最近历史条数一致。
 */
import {
  HISTORY_LIMIT,
  applyOperation,
  revertOperation,
  type Operation,
  type OperationContext,
} from '../core/operations'

export class HistoryManager {
  private undoStack: Operation[] = []
  private redoStack: Operation[] = []
  private readonly limit: number

  constructor(
    private ctx: OperationContext,
    private onChange: () => void,
    limit = HISTORY_LIMIT,
  ) {
    this.limit = limit
  }

  /** 执行新操作：apply 后入栈，并清空 redo */
  execute(op: Operation): void {
    applyOperation(this.ctx, op)
    this.pushUndo(op)
  }

  /** 操作已由外部应用（如拖动结束），只登记历史 */
  push(op: Operation): void {
    this.pushUndo(op)
  }

  private pushUndo(op: Operation): void {
    this.undoStack.push(op)
    if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit)
    this.redoStack.length = 0
    this.onChange()
  }

  undo(): boolean {
    const op = this.undoStack.pop()
    if (!op) return false
    revertOperation(this.ctx, op)
    this.redoStack.push(op)
    this.onChange()
    return true
  }

  redo(): boolean {
    const op = this.redoStack.pop()
    if (!op) return false
    applyOperation(this.ctx, op)
    this.undoStack.push(op)
    this.onChange()
    return true
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null
  }

  /** 当前 Undo 栈（最旧 → 最新），用于持久化到 SQLite */
  get entries(): Operation[] {
    return this.undoStack.slice()
  }

  /** 从持久化数据恢复历史（redo 栈不持久化，恢复后为空） */
  load(entries: Operation[]): void {
    this.undoStack = entries.slice(-this.limit)
    this.redoStack.length = 0
    this.onChange()
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.onChange()
  }
}
