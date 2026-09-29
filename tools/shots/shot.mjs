// Takes screenshots of the running app for the README and the DEV post.
import {chromium} from 'playwright-core'
import {homedir} from 'node:os'
import {readdirSync} from 'node:fs'

const base = process.argv[2] ?? 'http://localhost:3333'
const out = process.argv[3] ?? '.'
const dir = `${homedir()}/Library/Caches/ms-playwright`
const shell = readdirSync(dir).find((d) => d.startsWith('chromium_headless_shell'))
const executablePath = `${dir}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`

const browser = await chromium.launch({executablePath})
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({viewport: {width: 1400, height: 1000}, deviceScaleFactor: 2, colorScheme: scheme})
  await page.goto(base, {waitUntil: 'networkidle'})
  for (const [label, file] of [['Checkout service', 'node'], ['My Bug Smash winner', 'bugsmash'], ['Orders and an LLM call', 'python']]) {
    await page.getByRole('button', {name: new RegExp(label)}).click()
    await page.waitForSelector('.stats', {timeout: 30000})
    await page.waitForTimeout(400)
    await page.screenshot({path: `${out}/${file}-${scheme}.png`, fullPage: true})
  }
  await page.close()
}
await browser.close()
console.log('done')
