/**
 * 交互控制器：把 DOM 指针事件翻译成编辑命令。
 *
 * 交互约定：
 * - 滚轮：以光标为中心缩放
 * - 中键拖动 / 空格 + 左键拖动：平移画布
 * - 左键点空白：清空选择，并进入框选（加分项）
 * - 左键点已选中的点：拖动整个选中集合
 * - 左键点未选中的点：先选中它，再拖动
 * - Shift + 左键点选：加选 / 反选
 *
 * 性能要点：拖动过程只调用 previewMove（瞬时更新，不写历史、不标脏），
 * 仅在 pointerup 时提交一条历史记录。
 */
import type { EditorStore } from '../state/store'
import type { PixiRenderer } from '../render/renderer'
import { POINT_RADIUS } from '../render/renderer'
import type { PositionUpdate, Rect } from '../core/types'

type Mode = 'idle' | 'pan' | 'drag' | 'box'

interface ScreenPos {
  x: number
  y: number
}

export class InteractionController {
  private mode: Mode = 'idle'
  private activePointerId: number | null = null
  private spaceDown = false

  private panStart: ScreenPos = { x: 0, y: 0 }
  private panViewStart = { x: 0, y: 0 }

  private dragStartWorld: ScreenPos = { x: 0, y: 0 }
  private dragStartPositions = new Map<string, { x: number; y: number }>()
  private dragIds: string[] = []

  private boxStartWorld: ScreenPos = { x: 0, y: 0 }
  private boxCurrentWorld: ScreenPos = { x: 0, y: 0 }
  private boxAdditive = false

  private boxEl: HTMLDivElement

  constructor(
    private store: EditorStore,
    private renderer: PixiRenderer,
    private canvas: HTMLCanvasElement,
    host: HTMLElement,
  ) {
    this.boxEl = document.createElement('div')
    Object.assign(this.boxEl.style, {
      position: 'absolute',
      border: '1px solid #36c6ff',
      background: 'rgba(54,198,255,0.12)',
      pointerEvents: 'none',
      display: 'none',
      zIndex: '5',
    })
    host.appendChild(this.boxEl)

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  // ------------------------------------------------------------- 坐标工具

  private toCanvas(e: PointerEvent): ScreenPos {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** 命中测试：返回屏幕坐标下最近的点 id */
  private pick(screen: ScreenPos): string | null {
    const world = this.renderer.viewport.screenToWorld(screen.x, screen.y)
    const pickRadius = POINT_RADIUS + 6 / this.renderer.viewport.scale
    const r2 = pickRadius * pickRadius
    const candidates = this.store.getSpatial().queryCircle(world.x, world.y, pickRadius)
    let bestId: string | null = null
    let bestDist = Infinity
    for (const id of candidates) {
      const p = this.store.getPoint(id)
      if (!p) continue
      const dx = p.x - world.x
      const dy = p.y - world.y
      const d = dx * dx + dy * dy
      if (d <= r2 && d < bestDist) {
        bestDist = d
        bestId = id
      }
    }
    return bestId
  }

  // ------------------------------------------------------------- 指针事件

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return
    const screen = this.toCanvas(e)
    const panning = e.button === 1 || this.spaceDown

    this.activePointerId = e.pointerId
    this.canvas.setPointerCapture(e.pointerId)

    if (panning) {
      this.mode = 'pan'
      this.panStart = screen
      this.panViewStart = { x: this.renderer.viewport.x, y: this.renderer.viewport.y }
      this.canvas.style.cursor = 'grabbing'
      return
    }

    const hitId = this.pick(screen)

    if (e.shiftKey) {
      if (hitId) this.store.select(hitId, 'toggle')
      this.mode = 'idle'
      return
    }

    if (hitId) {
      if (!this.store.selection.has(hitId)) this.store.select(hitId, 'replace')
      // 开始拖动当前选中集合
      this.mode = 'drag'
      this.dragStartWorld = this.renderer.viewport.screenToWorld(screen.x, screen.y)
      this.dragIds = [...this.store.selection]
      this.dragStartPositions.clear()
      for (const id of this.dragIds) {
        const p = this.store.getPoint(id)
        if (p) this.dragStartPositions.set(id, { x: p.x, y: p.y })
      }
      this.canvas.style.cursor = 'move'
      return
    }

    // 点空白：清空选择并进入框选
    this.mode = 'box'
    this.boxAdditive = e.shiftKey
    this.boxStartWorld = this.renderer.viewport.screenToWorld(screen.x, screen.y)
    this.boxCurrentWorld = this.boxStartWorld
    if (!this.boxAdditive) this.store.clearSelection()
    this.updateBoxEl(screen, screen)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.mode === 'idle') {
      this.updateHoverCursor(e)
      return
    }
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return
    const screen = this.toCanvas(e)

    if (this.mode === 'pan') {
      this.renderer.viewport.x = this.panViewStart.x + (screen.x - this.panStart.x)
      this.renderer.viewport.y = this.panViewStart.y + (screen.y - this.panStart.y)
      this.renderer.applyViewport()
      return
    }

    if (this.mode === 'drag') {
      const world = this.renderer.viewport.screenToWorld(screen.x, screen.y)
      const dx = world.x - this.dragStartWorld.x
      const dy = world.y - this.dragStartWorld.y
      const updates: PositionUpdate[] = []
      for (const id of this.dragIds) {
        const start = this.dragStartPositions.get(id)
        if (!start) continue
        updates.push({ id, x: start.x + dx, y: start.y + dy })
      }
      this.store.previewMove(updates)
      return
    }

    if (this.mode === 'box') {
      this.boxCurrentWorld = this.renderer.viewport.screenToWorld(screen.x, screen.y)
      this.updateBoxEl(this.boxStartScreen, screen)
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return
    this.activePointerId = null

    if (this.mode === 'drag') {
      this.store.commitMove(this.dragStartPositions)
    } else if (this.mode === 'box') {
      this.finalizeBox()
      this.boxEl.style.display = 'none'
    }

    this.mode = 'idle'
    this.canvas.style.cursor = this.spaceDown ? 'grab' : 'default'
  }

  // ------------------------------------------------------------- 框选

  private boxStartScreen: ScreenPos = { x: 0, y: 0 }

  private updateBoxEl(a: ScreenPos, b: ScreenPos): void {
    this.boxStartScreen = a
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(a.x - b.x)
    const h = Math.abs(a.y - b.y)
    Object.assign(this.boxEl.style, {
      display: 'block',
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    })
  }

  private finalizeBox(): void {
    const rect: Rect = {
      x: Math.min(this.boxStartWorld.x, this.boxCurrentWorld.x),
      y: Math.min(this.boxStartWorld.y, this.boxCurrentWorld.y),
      width: Math.abs(this.boxCurrentWorld.x - this.boxStartWorld.x),
      height: Math.abs(this.boxCurrentWorld.y - this.boxStartWorld.y),
    }
    if (rect.width < 1e-6 && rect.height < 1e-6) return
    const candidates = this.store.getSpatial().queryRect(rect)
    const hits: string[] = []
    for (const id of candidates) {
      const p = this.store.getPoint(id)
      if (!p) continue
      if (p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height) {
        hits.push(id)
      }
    }
    this.store.selectMany(hits, this.boxAdditive ? 'add' : 'replace')
  }

  // ------------------------------------------------------------- 其它事件

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const screen = this.toCanvas(e as unknown as PointerEvent)
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    this.renderer.viewport.zoomAt(screen.x, screen.y, factor)
    this.renderer.applyViewport()
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && !this.spaceDown) {
      this.spaceDown = true
      if (this.mode === 'idle') this.canvas.style.cursor = 'grab'
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.spaceDown = false
      if (this.mode === 'idle') this.canvas.style.cursor = 'default'
    }
  }

  private updateHoverCursor(e: PointerEvent): void {
    const screen = this.toCanvas(e)
    const hovered = this.pick(screen)
    this.canvas.style.cursor = this.spaceDown ? 'grab' : hovered ? 'pointer' : 'default'
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.boxEl.remove()
  }
}
