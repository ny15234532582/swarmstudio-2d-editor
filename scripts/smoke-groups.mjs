import puppeteer from 'puppeteer-core'

const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[groups]', ...a)

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage()
page.setDefaultTimeout(20000)
await page.setViewport({ width: 1400, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const clickByText = (t) =>
  page.evaluate((text) => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes(text))
    if (b) b.click()
    return !!b
  }, t)

const selected = async () => {
  const t = await page.evaluate(() => document.body.innerText)
  const line = t.split('\n').find((l) => l.includes('已选中')) ?? ''
  return Number(line.replace(/\D/g, '')) || 0
}

const groupRows = () =>
  page.$$eval('.group-panel .list li', (els) =>
    els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
  )

const result = {}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(2200)

  await clickByText('生成')
  await sleep(3500)

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

  // 锁定点不可命中
  await page.mouse.click(cx, cy)
  await sleep(300)
  result.selectedAfterClickLocked = await selected()
  await page.screenshot({
    path: process.env.SMOKE_SCREENSHOT || '/tmp/groups.png',
  })

  // 滚轮缩放/等待自动保存后刷新
  await sleep(1200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2500)
  await page.evaluate(() => document.querySelector('.list li .meta')?.click())
  await sleep(2500)
  result.groupAfterReload = await groupRows()

  // 解锁全部后应可再次选中
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
