import puppeteer from 'puppeteer-core'

const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[smoke]', ...a)

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage()
page.setDefaultTimeout(20000)
await page.setViewport({ width: 1400, height: 900 })

const errors = []
const consoleErrors = []
page.on('dialog', (d) => d.accept())
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

const clickByText = (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim().includes(t))
    if (b) b.click()
    return !!b
  }, text)

const text = () => page.evaluate(() => document.body.innerText)
const line = (haystack, needle) => haystack.split('\n').find((l) => l.includes(needle)) ?? null

let result = {}
try {
  log('goto')
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  result.storageLine = line(await text(), '存储：')
  result.sqliteReady = result.storageLine !== null

  log('create project')
  await page.type('.section input[placeholder="项目名称"]', 'SQLite 冒烟')
  await clickByText('创建')
  await sleep(800)

  log('generate test data')
  await clickByText('生成')
  await sleep(4000)
  result.afterGenerate = line(await text(), '总点数')

  log('add point + color')
  await clickByText('新增点')
  await sleep(300)
  await clickByText('应用到选中')
  await sleep(1200)
  result.afterEdit = line(await text(), '总点数')
  result.undoAfterEdit = line(await text(), '已选中')

  log('wait autosave')
  await sleep(1200)

  log('reload')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2500)

  result.projectsAfterReload = await page.evaluate(() =>
    [...document.querySelectorAll('.list .p-name')].map((el) => el.textContent?.trim()),
  )

  log('open project')
  await page.evaluate(() => document.querySelector('.list li .meta')?.click())
  await sleep(2500)
  result.afterOpen = line(await text(), '总点数')
  result.fpsAfterOpen = line(await text(), 'FPS：')
  result.undoState = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('撤销'))
    return b ? !b.disabled : null
  })

  log('delete current project -> canvas should clear')
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
