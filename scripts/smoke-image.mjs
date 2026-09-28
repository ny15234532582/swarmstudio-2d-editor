import puppeteer from 'puppeteer-core'

const url = process.argv[2] || 'http://localhost:4173/'
const executablePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[image-smoke]', ...a)

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
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + m.text())
})

const clickByText = (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim().includes(t))
    if (b) b.click()
    return !!b
  }, text)

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
  const stat = await text()
  result.recognized = line(stat, '识别像素')
  result.willGenerate = line(stat, '将生成')
  result.stepLine = line(stat, '采样步长')

  log('confirm generate')
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
