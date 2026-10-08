/**
 * smoke-image.mjs — 「图片 → 点位」功能的端到端（E2E）无头冒烟测试
 *
 * 用途：验证编辑器的图片导入流程——打开「导入图片生成点位」对话框、在页面
 *       上下文内动态生成一张黑底白圆的测试图并注入 file input、检查预览画布
 *       与识别统计（识别像素 / 将生成 / 采样步长）、确认生成后校验点位数与
 *       新建项目名。
 *
 * 用法（PNPM 脚本）：
 *   pnpm smoke:image                         # 默认访问 http://localhost:4173/
 *   pnpm smoke:image http://localhost:5173/  # 指定被测地址
 *
 * 环境要求：
 *   - 需先启动被测服务（pnpm preview 或 pnpm dev）。
 *   - CHROME_PATH：可选，Chrome 可执行文件路径；未设置时回退到 macOS 默认安装路径。
 *
 * 关键步骤见文件内注释；脚本以 JSON 打印结果，不抛非零退出码。
 */
import puppeteer from 'puppeteer-core'

// 被测地址、Chrome 路径及通用工具；sleep 用于等待渲染/生成等异步流程
const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[image-smoke]', ...a)

// 无头启动 Chrome；swiftshader 参数为无 GPU 环境提供 WebGL 软件渲染
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage()
page.setDefaultTimeout(20000)
await page.setViewport({ width: 1400, height: 900 })
// 收集运行期错误（pageerror）与告警/错误 console（本次也关注 warning）
const errors = []
const consoleErrors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + m.text())
})

// 在页面上下文按按钮文本（包含匹配）查找并点击，返回是否命中
const clickByText = (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim().includes(t))
    if (b) b.click()
    return !!b
  }, text)

// 读取整页文本并按关键词取行
const text = () => page.evaluate(() => document.body.innerText)
const line = (h, n) => h.split('\n').find((l) => l.includes(n)) ?? null

const result = {}
try {
  log('goto')
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  log('open dialog')
  await clickByText('导入图片生成点位')
  await sleep(400)

  log('inject a test image (white circle on black)')
  // 在页面上下文中用 canvas 绘制黑底白圆，转成 File 并写入对话框的 file input，
  // 再派发 change 事件以触发编辑器的图片解析逻辑（等价于用户选择文件）
  const injected = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 64, 64)
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(32, 32, 24, 0, Math.PI * 2)
    ctx.fill()
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const file = new File([blob], 'circle.png', { type: 'image/png' })
    const input = document.querySelector('.dialog input[type=file]')
    if (!input) return false
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })
  result.injected = injected
  await sleep(1500)

  result.dialogText = await page.evaluate(
    () => (document.querySelector('.dialog')?.innerText ?? '').replace(/\n+/g, ' | '),
  )
  await page.screenshot({ path: '/tmp/image-dialog.png' })
  // 读取预览 canvas 的像素统计：统计亮度 > 100 的像素数量，用于确认图片已被正确绘制
  const previewStats = await page.evaluate(() => {
    const c = document.querySelector('.dialog canvas')
    if (!c) return null
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let bright = 0
    const first = []
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 100) bright++
      if (first.length < 4) first.push([d[i], d[i + 1], d[i + 2], d[i + 3]])
    }
    return { w: c.width, h: c.height, bright, first }
  })
  result.previewStats = previewStats
  // 从对话框文本中提取识别结果与将生成的点数等断言信息
  const stat = await text()
  result.recognized = line(stat, '识别像素')
  result.willGenerate = line(stat, '将生成')
  result.stepLine = line(stat, '采样步长')

  log('confirm generate')
  // 确认生成并载入，等待点位写入画布与项目列表更新
  await clickByText('生成并载入')
  await sleep(2500)

  const after = await text()
  result.pointCount = line(after, '总点数')
  result.projectName = await page.evaluate(
    () => document.querySelector('.list .p-name')?.textContent?.trim() ?? null,
  )
  result.errorCount = errors.length
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
  if (consoleErrors.length) console.log('CONSOLE:\n' + consoleErrors.slice(0, 12).join('\n'))
} catch (err) {
  console.log('IMAGE SMOKE FAILED: ' + err.message)
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
} finally {
  await browser.close()
}
