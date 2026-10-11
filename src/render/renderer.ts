/**
 * PixiJS 渲染层。
 *
 * 设计要点（对应题目 4.1 / 6.2 / 6.4）：
 * - 事实源在 EditorStore，本层只是它的**单向投影**，可随时整体重建。
 * - 每个点用一个 Sprite（共享同一张圆形纹理），而不是每个点一个 Graphics。
 *   共享纹理由 GPU 合批，两万个点基本是常数个 draw call；Graphics 逐点重建
 *   几何体在数量和拖动更新场景下代价高得多。
 * - 业务层的点 id → Sprite 用 Map 索引，移动/改色只改对应 Sprite 的属性，
 *   不重建、不全量重绘。
 * - 选中高亮放在独立容器，避免与点位互相影响层级。
 */
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { EditorStore } from '../state/store'
import type { Point } from '../core/types'
import type { MotionSample } from '../core/transition'
import { Viewport, clamp } from './viewport'

/** 点在世界坐标下的默认显示半径 */
export const POINT_RADIUS = 4
/** 点纹理半径（越大，放大后越清晰；纹理仅生成一次） */
const TEXTURE_RADIUS = 16
const RING_TEXTURE_RADIUS = 16
/** 锁定点的透明度：一眼可辨「不可编辑」 */
const LOCKED_ALPHA = 0.28

function rgbToHex(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b
}

/** 渲染质量档位。auto 会按实时 FPS 动态调整分辨率。 */
export type RenderQuality = 'auto' | 'high' | 'balanced' | 'fast'

/**
 * 档位是**相对设备像素比**的比例，而不是绝对分辨率上限。
 *
 * 用绝对值封顶（高=2、均衡=1.25…）在 1x 屏上会退化成三档全等于 1.0x，
 * 菜单形同虚设；用比例后：Retina(2x) → 2.0/1.5/1.0，普通屏(1x) → 1.0/0.75/0.5，
 * 两种屏幕都能真实改变填充量。
 */
const RESOLUTION_FACTOR: Record<'high' | 'balanced' | 'fast', number> = {
  high: 1,
  balanced: 0.75,
  fast: 0.5,
}

/** 生效分辨率的硬限制（过高无意义、过低会糊） */
const MIN_RESOLUTION = 0.5
const MAX_RESOLUTION = 2

/** 自适应分辨率的上下限与触发阈值 */
const MIN_AUTO_SCALE = 0.5
const LOW_FPS = 45
const HIGH_FPS = 57

export interface RenderInfo {
  quality: RenderQuality
  /** 实际生效的渲染分辨率倍率 */
  resolution: number
  /** 自适应缩放系数（auto 档使用） */
  autoScale: number
}

export class PixiRenderer {
  readonly viewport = new Viewport()
  app: Application | null = null
  private world = new Container()
  /** 半透明飞行轨迹层（画在点位之下） */
  private trailLayer = new Container()
  private trailGraphics = new Graphics()
  private pointsLayer = new Container()
  private ringLayer = new Container()
  /** 过渡预览层：播放过渡时用它显示插值位置（最多 N 个临时 Sprite） */
  private previewLayer = new Container()
  private previewSprites: Sprite[] = []

  private pointTexture!: Texture
  private ringTexture!: Texture

  private sprites = new Map<string, Sprite>()
  private rings = new Map<string, Sprite>()
  private ringPool: Sprite[] = []

  private unsubs: Array<() => void> = []
  private resizeObserver: ResizeObserver | null = null

  private host: HTMLElement | null = null
  private quality: RenderQuality = 'auto'
  private autoScale = 1
  /** 点的显示半径（世界单位/米），可配置 */
  private pointRadius = POINT_RADIUS

  private frames = 0
  private lastFpsSample = 0
  onFps: ((fps: number) => void) | null = null
  onRenderInfo: ((info: RenderInfo) => void) | null = null
  /** 视口缩放变化回调（供比例尺显示） */
  onViewport: ((scale: number) => void) | null = null

  constructor(private store: EditorStore) {}

  async init(host: HTMLElement): Promise<void> {
    this.host = host
    const app = new Application()
    await app.init({
      background: 0x11151c,
      // 不透明画布：省掉 alpha 合成与混合，是填充率优化的一部分
      backgroundAlpha: 1,
      // 点用的是带抗锯齿的圆形纹理，因此关闭 MSAA，
      // 直接省掉一次全屏多重采样解析的 GPU 开销
      antialias: false,
      autoDensity: true,
      // 分辨率按档位封顶（Retina 默认 2x 会让填充量翻 4 倍）
      resolution: this.effectiveResolution(),
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      // 明确使用 WebGL：2D 点位场景下 WebGL 兼容性与稳定性优于 WebGPU，
      // 也避免在部分环境（软件渲染）下 WebGPU 初始化/重载异常。
      preference: 'webgl',
      // 请求独显（多 GPU 设备上避免落到核显）
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
    })
    this.app = app
    host.appendChild(app.canvas)

    app.stage.addChild(this.world)
    this.trailLayer.addChild(this.trailGraphics)
    this.world.addChild(this.trailLayer, this.pointsLayer, this.ringLayer, this.previewLayer)
    this.previewLayer.visible = false
    this.trailLayer.visible = false

    this.pointTexture = this.createCircleTexture(TEXTURE_RADIUS, 0xffffff)
    this.ringTexture = this.createRingTexture()

    this.bindStore()
    this.rebuildAll()

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(host)

    app.ticker.add(() => this.sampleFps())
    this.emitRenderInfo()
    this.onViewport?.(this.viewport.scale)
  }

  // ------------------------------------------------------------- 质量档位

  /** 切换渲染质量档位（会重置自适应系数） */
  setQuality(quality: RenderQuality): void {
    this.quality = quality
    this.autoScale = 1
    this.handleResize()
  }

  getQuality(): RenderQuality {
    return this.quality
  }

  /** 当前点的显示半径（世界单位/米） */
  getPointRadius(): number {
    return this.pointRadius
  }

  /** 设置点的显示半径（米），并即时更新已有点 / 选中环 / 预览点 */
  setPointRadius(radius: number): void {
    const r = Math.max(0.05, radius)
    if (r === this.pointRadius) return
    this.pointRadius = r
    const scale = r / TEXTURE_RADIUS
    for (const s of this.sprites.values()) s.scale.set(scale)
    for (const s of this.previewSprites) s.scale.set(scale)
    const ringScale = this.ringRadius() / RING_TEXTURE_RADIUS
    for (const s of this.rings.values()) s.scale.set(ringScale)
    for (const s of this.ringPool) s.scale.set(ringScale)
  }

  /** 选中高亮环的半径（随点半径变化，保证环比点略大） */
  private ringRadius(): number {
    return this.pointRadius + Math.max(1.5, this.pointRadius * 0.6)
  }

  /**
   * 当前实际生效的分辨率倍率。
   * - 手动档：dpr × 档位比例（高 1.0 / 均衡 0.75 / 流畅 0.5）
   * - 自动档：dpr × autoScale（autoScale 随 FPS 在 0.5~1 之间自适应）
   */
  private effectiveResolution(): number {
    const dpr = window.devicePixelRatio || 1
    const factor = this.quality === 'auto' ? this.autoScale : RESOLUTION_FACTOR[this.quality]
    return clamp(dpr * factor, MIN_RESOLUTION, MAX_RESOLUTION)
  }

  private handleResize(): void {
    const app = this.app
    const host = this.host
    if (!app || !host) return
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    app.renderer.resize(width, height, this.effectiveResolution())
    this.applyViewport()
    this.emitRenderInfo()
  }

  private emitRenderInfo(): void {
    this.onRenderInfo?.({
      quality: this.quality,
      resolution: this.effectiveResolution(),
      autoScale: this.autoScale,
    })
  }

  /**
   * 用 2D canvas 的径向渐变生成圆形纹理。
   * 这样即使关闭了 MSAA（antialias:false），点的边缘也是柔和的，
   * 既省 GPU 又避免锯齿——纹理只生成一次，成本可忽略。
   */
  private createCircleTexture(radius: number, color: number): Texture {
    const size = radius * 2
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const r = (color >> 16) & 0xff
    const g = (color >> 8) & 0xff
    const b = color & 0xff
    const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius)
    gradient.addColorStop(0, `rgba(${r},${g},${b},1)`)
    gradient.addColorStop(0.72, `rgba(${r},${g},${b},1)`)
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(radius, radius, radius, 0, Math.PI * 2)
    ctx.fill()
    return Texture.from(canvas)
  }

  private createRingTexture(): Texture {
    const size = RING_TEXTURE_RADIUS * 2
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.strokeStyle = '#36c6ff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(RING_TEXTURE_RADIUS, RING_TEXTURE_RADIUS, RING_TEXTURE_RADIUS - 2, 0, Math.PI * 2)
    ctx.stroke()
    return Texture.from(canvas)
  }

  // ------------------------------------------------------------- 事件绑定

  private bindStore(): void {
    const { events } = this.store
    this.unsubs.push(
      events.on('project:load', () => {
        this.rebuildAll()
        this.fitView()
      }),
      events.on('points:add', ({ ids }) => {
        for (const id of ids) {
          const p = this.store.getPoint(id)
          if (p && !this.sprites.has(id)) this.pointsLayer.addChild(this.createSprite(p))
        }
      }),
      events.on('points:remove', ({ ids }) => {
        for (const id of ids) {
          const sprite = this.sprites.get(id)
          if (sprite) {
            sprite.destroy()
            this.sprites.delete(id)
          }
          this.hideRing(id)
        }
      }),
      events.on('points:move', ({ ids }) => {
        for (const id of ids) {
          const p = this.store.getPoint(id)
          const sprite = this.sprites.get(id)
          if (!p || !sprite) continue
          sprite.x = p.x
          sprite.y = p.y
          const ring = this.rings.get(id)
          if (ring) {
            ring.x = p.x
            ring.y = p.y
          }
        }
      }),
      events.on('points:color', ({ ids }) => {
        for (const id of ids) {
          const p = this.store.getPoint(id)
          const sprite = this.sprites.get(id)
          if (p && sprite) sprite.tint = rgbToHex(p.r, p.g, p.b)
        }
      }),
      events.on('points:lock', ({ ids }) => {
        for (const id of ids) {
          const p = this.store.getPoint(id)
          const sprite = this.sprites.get(id)
          if (p && sprite) sprite.alpha = p.locked ? LOCKED_ALPHA : 1
        }
      }),
      events.on('selection:change', () => this.syncRings()),
      // 切换当前帧：重建为该帧的点位
      events.on('activeFrame:change', () => {
        this.clearPreview()
        this.rebuildAll()
        this.fitView()
      }),
    )
  }

  // ------------------------------------------------------------- 构建

  private createSprite(p: Point): Sprite {
    const sprite = new Sprite(this.pointTexture)
    sprite.anchor.set(0.5)
    sprite.scale.set(this.pointRadius / TEXTURE_RADIUS)
    sprite.x = p.x
    sprite.y = p.y
    sprite.tint = rgbToHex(p.r, p.g, p.b)
    sprite.alpha = p.locked ? LOCKED_ALPHA : 1
    this.sprites.set(p.id, sprite)
    return sprite
  }

  /** 全量重建（加载项目 / 切换当前帧时发生）：只渲染当前帧的点 */
  private rebuildAll(): void {
    for (const sprite of this.sprites.values()) sprite.destroy()
    this.sprites.clear()
    this.pointsLayer.removeChildren()

    for (const p of this.store.getFramePoints(this.store.activeFrameIdValue)) {
      this.pointsLayer.addChild(this.createSprite(p))
    }
    this.recycleAllRings()
    this.syncRings()
  }

  // ------------------------------------------------------------- 过渡预览

  /**
   * 显示一帧「过渡采样」：用预览层临时 Sprite 渲染（最多 N 个），
   * 期间隐藏常规点位层；不写回 store。
   */
  showPreview(samples: MotionSample[]): void {
    this.pointsLayer.visible = false
    this.ringLayer.visible = false
    this.previewLayer.visible = true
    while (this.previewSprites.length < samples.length) {
      const sprite = new Sprite(this.pointTexture)
      sprite.anchor.set(0.5)
      sprite.scale.set(this.pointRadius / TEXTURE_RADIUS)
      this.previewLayer.addChild(sprite)
      this.previewSprites.push(sprite)
    }
    for (let i = 0; i < this.previewSprites.length; i++) {
      const sprite = this.previewSprites[i]
      const sample = samples[i]
      if (!sample) {
        sprite.visible = false
        continue
      }
      sprite.visible = true
      sprite.x = sample.x
      sprite.y = sample.y
      sprite.tint = rgbToHex(sample.r, sample.g, sample.b)
      sprite.alpha = sample.alpha
    }
    this.applyViewport()
  }

  /** 退出预览，恢复显示当前帧的常规点位 */
  clearPreview(): void {
    if (!this.previewLayer.visible) return
    this.previewLayer.visible = false
    for (const sprite of this.previewSprites) sprite.visible = false
    this.pointsLayer.visible = true
    this.ringLayer.visible = true
  }

  // ------------------------------------------------------------- 飞行轨迹

  /** 显示半透明飞行轨迹（世界坐标折线） */
  showTrails(polylines: Array<Array<{ x: number; y: number }>>, color = 0x36c6ff): void {
    const g = this.trailGraphics
    g.clear()
    for (const poly of polylines) {
      if (poly.length < 2) continue
      g.moveTo(poly[0].x, poly[0].y)
      for (let i = 1; i < poly.length; i++) g.lineTo(poly[i].x, poly[i].y)
    }
    // 线更细更淡；条数越多越减淡，避免几千条叠加成一团
    const n = polylines.length
    const alpha = n > 5000 ? 0.04 : n > 2000 ? 0.06 : 0.1
    g.stroke({ width: 0.35, color, alpha })
    this.trailLayer.visible = true
  }

  /** 清除飞行轨迹 */
  clearTrails(): void {
    this.trailLayer.visible = false
    this.trailGraphics.clear()
  }

  // ------------------------------------------------------------- 选中高亮

  private syncRings(): void {
    const selected = this.store.selection
    // 回收不再选中的环
    for (const [id, ring] of this.rings) {
      if (!selected.has(id)) {
        ring.visible = false
        this.ringPool.push(ring)
        this.rings.delete(id)
      }
    }
    // 为新增选中的点复用一个环
    for (const id of selected) {
      if (this.rings.has(id)) continue
      const p = this.store.getPoint(id)
      if (!p) continue
      const ring = this.acquireRing()
      ring.x = p.x
      ring.y = p.y
      ring.visible = true
      this.rings.set(id, ring)
    }
  }

  private acquireRing(): Sprite {
    const pooled = this.ringPool.pop()
    if (pooled) return pooled
    const ring = new Sprite(this.ringTexture)
    ring.anchor.set(0.5)
    ring.scale.set(this.ringRadius() / RING_TEXTURE_RADIUS)
    this.ringLayer.addChild(ring)
    return ring
  }

  private hideRing(id: string): void {
    const ring = this.rings.get(id)
    if (!ring) return
    ring.visible = false
    this.ringPool.push(ring)
    this.rings.delete(id)
  }

  private recycleAllRings(): void {
    for (const ring of this.rings.values()) {
      ring.visible = false
      this.ringPool.push(ring)
    }
    this.rings.clear()
  }

  // ------------------------------------------------------------- 视口

  applyViewport(): void {
    this.world.position.set(this.viewport.x, this.viewport.y)
    this.world.scale.set(this.viewport.scale)
    this.onViewport?.(this.viewport.scale)
  }

  /** 根据点集包围盒适配视图 */
  fitView(padding = 48): void {
    const app = this.app
    if (!app) return
    const points = this.store.project.points
    if (points.length === 0) {
      this.viewport.scale = 1
      this.viewport.x = app.screen.width / 2
      this.viewport.y = app.screen.height / 2
      this.applyViewport()
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    this.viewport.fit(rect, app.screen.width, app.screen.height, padding)
    this.applyViewport()
  }

  // ------------------------------------------------------------- 帧率

  private sampleFps(): void {
    const now = performance.now()
    if (this.lastFpsSample === 0) this.lastFpsSample = now
    this.frames++
    const elapsed = now - this.lastFpsSample
    if (elapsed >= 500) {
      const fps = (this.frames * 1000) / elapsed
      this.frames = 0
      this.lastFpsSample = now
      this.onFps?.(fps)
      if (this.quality === 'auto') this.adaptResolution(fps)
    }
  }

  /**
   * 动态分辨率（auto 档）：GPU 填充压力大 → 降分辨率；恢复后再升回去。
   * 这是对「填充率是瓶颈」最直接有效的优化，且对外表现为画面略软而非掉帧。
   */
  private adaptResolution(fps: number): void {
    const previous = this.autoScale
    if (fps < LOW_FPS) {
      this.autoScale = Math.max(MIN_AUTO_SCALE, this.autoScale - 0.1)
    } else if (fps > HIGH_FPS) {
      this.autoScale = Math.min(1, this.autoScale + 0.05)
    }
    if (Math.abs(this.autoScale - previous) > 1e-3) this.handleResize()
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.app?.destroy(true, { children: true })
    this.app = null
    this.sprites.clear()
    this.rings.clear()
    this.ringPool = []
  }
}
