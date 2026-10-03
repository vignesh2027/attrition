// Renders the social card (og.png), the DEV cover (cover.png) and the mark at 512 px
// from the HTML and SVG sources in brand/.
import {chromium} from 'playwright'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {join} from 'node:path'

const BRAND = fileURLToPath(new URL('../../brand/', import.meta.url))
const url = (f) => pathToFileURL(join(BRAND, f)).href
const browser = await chromium.launch()
for (const [file, w, h, scale, out] of [
  ['og.html', 1200, 630, 1, 'og.png'],
  ['cover.html', 1000, 420, 2, 'cover.png'],
]) {
  const page = await browser.newPage({viewport: {width: w, height: h}, deviceScaleFactor: scale})
  await page.goto(url(file))
  await page.screenshot({path: join(BRAND, out)})
}
const page = await browser.newPage({viewport: {width: 512, height: 512}})
await page.setContent(`<body style="margin:0"><img src="${url('mark.svg')}" width="512" height="512"></body>`)
await page.waitForTimeout(300)
await page.screenshot({path: join(BRAND, 'mark-512.png'), omitBackground: true})
await browser.close()
console.log('rendered into', BRAND)
