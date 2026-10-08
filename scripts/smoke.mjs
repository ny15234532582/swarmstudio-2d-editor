/**
 * smoke.mjs — 编辑器端到端（E2E）无头冒烟测试
 *
 * 用途：在真实浏览器中走通编辑器的核心闭环——加载后确认 SQLite 存储就绪、
 *       创建项目、生成测试数据、新增点并上色、等待自动保存、刷新重载、
 *       重新打开项目（校验记录恢复与撤销状态）、删除项目（校验画布清空），
 *       最后输出断言结果与截图。
 *
 * 用法（PNPM 脚本）：
 *   pnpm smoke                         # 默认访问 http://localhost:4173/
 *   pnpm smoke http://localhost:5173/  # 指定已被测地址（通常先 pnpm preview / pnpm dev）
 *
 * 环境要求：
 *   - 需先启动被测服务（pnpm preview 或 pnpm dev）。
 *   - CHROME_PATH：可选，Chrome 可执行文件路径；未设置时回退到 macOS 默认安装路径。
 *   - SMOKE_SCREENSHOT：可选，截图输出路径（默认 /tmp/swarm-smoke.png）。
 *
 * 关键步骤见文件内注释；脚本以 JSON 打印结果，不抛非零退出码，需人工判读。
 */
import puppeteer from 'puppeteer-core'

// 被测地址、Chrome 路径及通用工具；sleep 用于等待渲染/自动保存等异步完成
const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[smoke]', ...a)

// 以无头模式启动 Chrome；swiftshader 参数用于在无 GPU 环境下提供 WebGL 软件渲染
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage()
page.setDefaultTimeout(20000)
await page.setViewport({ width: 1400, height: 900 })

// 收集运行期错误：（页面异常 / console.error），并在收尾时统计
const errors = []
const consoleErrors = []
// 自动接受 alert/confirm 等原生弹窗，避免脚本被阻塞
page.on('dialog', (d) => d.accept())
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

// 在页面上下文中按按钮文本（包含匹配）查找并点击，返回是否命中
const clickByText = (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim().includes(t))
    if (b) b.click()
    return !!b
  }, text)

// 读取整页可见文本，并按关键词定位某一行（用于断言统计信息）
const text = () => page.evaluate(() => document.body.innerText)
const line = (haystack, needle) => haystack.split('\n').find((l) => l.includes(needle)) ?? null

let result = {}
try {
  log('goto')
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  // 断言 SQLite(WASM)/OPFS 存储已初始化：状态栏出现「存储：」即视为就绪
  result.storageLine = line(await text(), '存储：')
  result.sqliteReady = result.storageLine !== null

  log('create project')
  await page.type('.section input[placeholder="项目名称"]', 'SQLite 冒烟')
  await clickByText('创建')
  await sleep(800)

  log('generate test data')
  // 点击「生成」后等待 4s，让大批量点位完成生成/写入
  await clickByText('生成')
  await sleep(4000)
  result.afterGenerate = line(await text(), '总点数')

  log('add point + color')
  // 新增一个点并给选中点上色，随后记录统计信息变化
  await clickByText('新增点')
  await sleep(300)
  await clickByText('应用到选中')
  await sleep(1200)
  result.afterEdit = line(await text(), '总点数')
  result.undoAfterEdit = line(await text(), '已选中')

  log('wait autosave')
  // 等待自动保存（防抖）落库，保证后续刷新能读到最新数据
  await sleep(1200)

  log('reload')
  // 刷新页面以验证持久化：项目列表与统计信息应从存储恢复
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2500)

  result.projectsAfterReload = await page.evaluate(() =>
    [...document.querySelectorAll('.list .p-name')].map((el) => el.textContent?.trim()),
  )

  log('open project')
  // 点击项目条目的 meta 区域重新打开该项目
  await page.evaluate(() => document.querySelector('.list li .meta')?.click())
  await sleep(2500)
  result.afterOpen = line(await text(), '总点数')
  result.fpsAfterOpen = line(await text(), 'FPS：')
  // 撤销按钮此时应可用（说明历史栈已从存储恢复）
  result.undoState = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('撤销'))
    return b ? !b.disabled : null
  })

  log('delete current project -> canvas should clear')
  // 删除当前项目后，画布应清空且列表数量减少
  result.pointsBeforeDelete = line(await text(), '总点数')
  await page.evaluate(() => document.querySelector('.list li .danger')?.click())
  await sleep(1500)
  result.pointsAfterDelete = line(await text(), '总点数')
  result.projectCountAfterDelete = await page.$$eval('.list li', (els) => els.length)

  result.errorCount = errors.length
  result.consoleErrorCount = consoleErrors.length
  await sleep(3500) // 等 toast 消失后再截图
  await page.screenshot({ path: process.env.SMOKE_SCREENSHOT || '/tmp/swarm-smoke.png' })
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
  if (consoleErrors.length) console.log('CONSOLE ERRORS:\n' + consoleErrors.slice(0, 8).join('\n'))
} catch (err) {
  console.log('SMOKE FAILED: ' + err.message)
  console.log(JSON.stringify(result, null, 2))
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.slice(0, 5).join('\n'))
  if (consoleErrors.length) console.log('CONSOLE ERRORS:\n' + consoleErrors.slice(0, 8).join('\n'))
} finally {
  await browser.close()
}
