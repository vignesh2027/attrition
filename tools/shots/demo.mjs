// Records a short click-through of the live app as frames, then docs/img/demo.gif.
import {chromium} from 'playwright'
import {execFileSync} from 'node:child_process'
import {mkdirSync, rmSync} from 'node:fs'
const base = 'https://attrition-otel.vercel.app'
const dir = '/tmp/attrition-frames'
rmSync(dir, {recursive: true, force: true})
mkdirSync(dir)
const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1})
let n = 0
const frames = []
const snap = async (ms) => {
  const f = `${dir}/${String(n++).padStart(3, '0')}.png`
  await page.screenshot({path: f})
  frames.push([f, ms])
}
await page.goto(base, {waitUntil: 'networkidle'})
await snap(1800)
for (const [label, scrolls] of [['Checkout service', [430, 820]], ['Orders and an LLM call', [430, 900, 1400]]]) {
  await page.getByRole('button', {name: new RegExp(label)}).click()
  await page.waitForSelector('.trace', {timeout: 60000})
  await page.waitForTimeout(400)
  await snap(1200)
  for (const y of scrolls) {
    await page.evaluate((top) => window.scrollTo({top}), y)
    await page.waitForTimeout(300)
    await snap(2200)
  }
  await page.evaluate(() => window.scrollTo({top: 0}))
}
await page.goto(`${base}/decisions`, {waitUntil: 'networkidle'})
await snap(1800)
await page.evaluate(() => window.scrollTo({top: 360}))
await page.waitForTimeout(300)
await snap(2600)
await browser.close()
execFileSync('python3', ['-c', `
import json,sys
from PIL import Image
frames=json.loads(sys.argv[1])
ims=[Image.open(f).convert('RGB').resize((960,600), Image.LANCZOS) for f,_ in frames]
pal=[im.quantize(colors=128, method=Image.Quantize.MEDIANCUT) for im in ims]
pal[0].save(sys.argv[2], save_all=True, append_images=pal[1:], duration=[d for _,d in frames], loop=0, optimize=True)
`, JSON.stringify(frames), new URL('../../docs/img/demo.gif', import.meta.url).pathname])
console.log('frames', frames.length)
