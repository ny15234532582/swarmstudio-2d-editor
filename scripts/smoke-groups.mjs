/**
 * smoke-groups.mjs — 分组 / 锁定 / 刷新持久化端到端（E2E）无头冒烟测试
 *
 * 用途：生成点位后套索选中一批点，验证：
 *       - 「成组」后分组面板出现记录；
 *       - 「锁定选中」后锁定点无法被再次点选命中；
 *       - 等待自动保存后刷新并重新打开项目，分组信息仍能恢复；
 *       - 「解锁全部」后锁定点恢复可选中。
 *
 * 用法（PNPM 脚本）：
 *   pnpm smoke:groups                         # 默认访问 http://localhost:4173/
 *   pnpm smoke:groups http://localhost:5173/  # 指定被测地址
 *
 * 环境要求：
 *   - 需先启动被测服务（pnpm preview 或 pnpm dev）。
 *   - CHROME_PATH：可选，Chrome 可执行文件路径；未设置时回退到 macOS 默认安装路径。
 *   - SMOKE_SCREENSHOT：可选，截图输出路径（默认 /tmp/groups.png）。
 *
 * 关键步骤见文件内注释；脚本以 JSON 打印结果，不抛非零退出码。
 */
import puppeteer from 'puppeteer-core'
import { injectTestPoints } from './smoke-utils.mjs'

// 被测地址、Chrome 路径及通用工具
const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[groups]', ...a)

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

// 在页面上下文按按钮文本（包含匹配）查找并点击，返回是否命中
const clickByText = (t) =>
  page.evaluate((text) => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes(text))
    if (b) b.click()
    return !!b
  }, t)

// 从「已选中 N」这一行解析当前选中数量（去除所有非数字字符）
const selected = async () => {
  const t = await page.evaluate(() => document.body.innerText)
  const line = t.split('\n').find((l) => l.includes('已选中')) ?? ''
  return Number(line.replace(/\D/g, '')) || 0
}

// 读取分组面板中的所有条目文本（折叠空白，便于断言）
const groupRows = () =>
  page.$$eval('.group-panel .list li', (els) =>
    els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
  )

const result = {}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(2200)

  // 注入测试点位，作为套索选中的对象（旧的「生成测试数据」按钮已移除）
  await injectTestPoints(page, 20000)
  await sleep(3500)

  // 获取画布矩形并计算中心点与套索半径，便于将交互换算到屏幕坐标
  const box = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const r = Math.min(box.w, box.h) * 0.22

  // Alt/Option + 拖拽 = 套索，圈一片
  await page.keyboard.down('Alt')
  await page.mouse.move(cx - r, cy)
  await page.mouse.down()
  for (let i = 1; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2
    await page.mouse.move(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  }
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await sleep(500)
  result.lassoSelected = await selected()

  // 成组 → 锁定选中
  await clickByText('成组')
  await sleep(400)
  result.afterGroup = await groupRows()
  await clickByText('锁定选中')
  await sleep(400)
  result.afterLock = await groupRows()
  result.selectedAfterLock = await selected()

  // 锁定点不可命中：点击中心后选中数不应变化
  await page.mouse.click(cx, cy)
  await sleep(300)
  result.selectedAfterClickLocked = await selected()
  await page.screenshot({
    path: process.env.SMOKE_SCREENSHOT || '/tmp/groups.png',
  })

  // 滚轮缩放/等待自动保存后刷新
  // 等待自动保存落库，然后刷新页面并重新打开项目，验证分组是否持久化
  await sleep(1200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2500)
  await page.evaluate(() => document.querySelector('.list li .meta')?.click())
  await sleep(2500)
  result.groupAfterReload = await groupRows()

  // 解锁全部后应可再次选中：解锁后点击中心应恢复选中
  await clickByText('解锁全部')
  await sleep(400)
  result.groupAfterUnlock = await groupRows()
  await page.mouse.click(cx, cy)
  await sleep(300)
  result.selectedAfterUnlock = await selected()

  result.errorCount = errors.length
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
} catch (err) {
  console.log('GROUPS SMOKE FAILED: ' + err.message)
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
} finally {
  await browser.close()
}
