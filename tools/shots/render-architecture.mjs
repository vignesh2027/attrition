// Renders brand/architecture.html to docs/img/architecture.png.
import {chromium} from 'playwright'
import {fileURLToPath, pathToFileURL} from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1400, height: 720}, deviceScaleFactor: 2})
await page.goto(pathToFileURL(`${root}brand/architecture.html`).href)
await page.screenshot({path: `${root}docs/img/architecture.png`})
await browser.close()
