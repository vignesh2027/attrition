import {chromium} from '../tools/shots/node_modules/playwright-core/index.mjs'
import {homedir} from 'node:os'
import {readdirSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
const dir = `${homedir()}/Library/Caches/ms-playwright`
const shell = readdirSync(dir).find((d) => d.startsWith('chromium_headless_shell'))
const browser = await chromium.launch({executablePath: `${dir}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`})
const page = await browser.newPage({viewport: {width: 1000, height: 420}, deviceScaleFactor: 2})
await page.goto(pathToFileURL(process.cwd() + '/cover.html').href)
await page.screenshot({path: 'cover.png'})
await browser.close()
