/**
 * smoke-select.mjs — 选择交互（Shift 加选 / 套索）端到端（E2E）无头冒烟测试
 *
 * 用途：覆盖编辑器的多种选择方式与拖拽：
 *       1) 单击选中；2) Shift + 单击加选；3) Alt/Option + 拖拽套索圈选；
 *       4) Shift + Alt 套索追加；5) 单击后拖拽移动点位（校验撤销标题为「撤销：移动点位」）。
 *       通过读取「已选中」计数与撤销按钮标题来断言行为是否符合预期。
 *
 * 用法（PNPM 脚本）：
 *   pnpm smoke:select                         # 默认访问 http://localhost:4173/
 *   pnpm smoke:select http://localhost:5173/  # 指定被测地址
 *
 * 环境要求：
 *   - 需先启动被测服务（pnpm preview 或 pnpm dev）。
 *   - CHROME_PATH：可选，Chrome 可执行文件路径；未设置时回退到 macOS 默认安装路径。
 *
 * 关键步骤见文件内注释；脚本以 JSON 打印结果，不抛非零退出码。
 */
import puppeteer from 'puppeteer-core'

// 被测地址、Chrome 路径及通用工具
const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 无头启动 Chrome；swiftshader 参数为无 GPU 环境提供 WebGL 软件渲染
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage()
page.setDefaultTimeout(20000)
await page.setViewport({ width: 1400, height: 900 })
// 收集页面异常，收尾时统计
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

// 读取撤销按钮的禁用状态与 title（title 反映最近一次操作的名称）
const undoTitle = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('撤销'))
    return b ? { disabled: b.disabled, title: b.getAttribute('title') } : null
  })

// 从「已选中 N」这一行解析当前选中数量（去除所有非数字字符）
const selected = async () => {
  const t = await page.evaluate(() => document.body.innerText)
  const line = t.split('\n').find((l) => l.includes('已选中')) ?? ''
  return Number(line.replace(/\D/g, '')) || 0
}

const result = {}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  // 先生成一批测试点位作为选择对象
  await page.evaluate(() => {
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('生成'))?.click()
  })
  await sleep(3500)

  // 获取画布相对视口的矩形，用于把交互坐标换算到屏幕坐标；cx/cy 为画布中心
  const box = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2

  // 1) 单击
  await page.mouse.click(cx, cy)
  await sleep(300)
  result.afterClick = await selected()

  // 2) Shift + 单击加选
  await page.keyboard.down('Shift')
  await page.mouse.click(cx + 40, cy + 30)
  await sleep(300)
  await page.keyboard.up('Shift')
  result.afterShiftClick = await selected()

  // 3) Alt/Option + 拖拽 = 套索，圈一片区域
  //    绕中心按圆形轨迹移动鼠标，模拟套索路径；r 为套索半径
  const r = Math.min(box.w, box.h) * 0.28
  await page.keyboard.down('Alt')
  await page.mouse.move(cx - r, cy)
  await page.mouse.down()
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2
    await page.mouse.move(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    if (i === 40) await page.screenshot({ path: '/tmp/lasso.png' })
  }
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await sleep(400)
  result.afterLasso = await selected()

  // 4) Shift + Alt + 套索追加
  await page.keyboard.down('Shift')
  await page.keyboard.down('Alt')
  await page.mouse.move(cx - r * 0.5, cy - r * 1.4)
  await page.mouse.down()
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2
    await page.mouse.move(cx - r * 0.5 + Math.cos(a) * r * 0.5, cy - r * 1.4 + Math.sin(a) * r * 0.5)
  }
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.keyboard.up('Shift')
  await sleep(400)
  result.afterLassoAdd = await selected()

  // 5) 拖拽回归：单击选中后拖动，撤销记录应出现「移动点位」
  //    先清空选择，再单击选中一个点，然后按住拖拽一段距离
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('取消选择'))
    b?.click()
  })
  await sleep(200)
  await page.mouse.click(cx, cy)
  await sleep(250)
  const before = await undoTitle()
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 6, cy + i * 4)
  await page.mouse.up()
  await sleep(400)
  // 断言拖拽后撤销标题变为「撤销：移动点位」，说明移动被记入历史
  result.dragBefore = before?.title
  result.dragAfter = (await undoTitle())?.title
  result.dragWorks = result.dragAfter === '撤销：移动点位'

  result.errorCount = errors.length
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
} catch (err) {
  console.log('SELECT SMOKE FAILED: ' + err.message)
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
} finally {
  await browser.close()
}
