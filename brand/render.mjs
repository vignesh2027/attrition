import {chromium} from '../tools/shots/node_modules/playwright-core/index.mjs'
import {homedir} from 'node:os'
import {readdirSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
const dir = `${homedir()}/Library/Caches/ms-playwright`
const shell = readdirSync(dir).find((d) => d.startsWith('chromium_headless_shell'))
const browser = await chromium.launch({executablePath: `${dir}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`})
const page = await browser.newPage({viewport: {width: 1200, height: 630}, deviceScaleFactor: 1})
await page.goto(pathToFileURL(process.cwd() + '/og.html').href)
await page.screenshot({path: 'og.png'})
const p2 = await browser.newPage({viewport: {width: 512, height: 512}})
await p2.setContent(`<body style="margin:0"><img src="${pathToFileURL(process.cwd() + '/mark.svg').href}" width="512" height="512"></body>`)
await p2.screenshot({path: 'mark-512.png', omitBackground: true})
await browser.close()
