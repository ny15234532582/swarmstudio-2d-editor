import puppeteer from 'puppeteer-core'

const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const selected = async () => {
  const t = await page.evaluate(() => document.body.innerText)
  const line = t.split('\n').find((l) => l.includes('已选中')) ?? ''
  return Number(line.replace(/\D/g, '')) || 0
}

const setTool = (value) =>
  page.evaluate((v) => {
    const sel = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === v),
    )
    if (!sel) return false
    sel.value = v
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, value)

const result = {}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  await page.evaluate(() => {
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('生成'))?.click()
  })
  await sleep(3500)

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

  // 3) 切到套索，圈一片区域
  result.toolSwitched = await setTool('lasso')
  await sleep(200)
  const r = Math.min(box.w, box.h) * 0.28
  await page.mouse.move(cx - r, cy)
  await page.mouse.down()
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2
    await page.mouse.move(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    if (i === 40) await page.screenshot({ path: '/tmp/lasso.png' })
  }
  await page.mouse.up()
  await sleep(400)
  result.afterLasso = await selected()

  // 4) Shift + 套索追加
  await page.keyboard.down('Shift')
  await page.mouse.move(cx - r * 0.5, cy - r * 1.4)
  await page.mouse.down()
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2
    await page.mouse.move(cx - r * 0.5 + Math.cos(a) * r * 0.5, cy - r * 1.4 + Math.sin(a) * r * 0.5)
  }
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await sleep(400)
  result.afterLassoAdd = await selected()

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
