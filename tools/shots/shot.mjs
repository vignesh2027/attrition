// Screenshots of the live app for the README, the project page and the DEV post.
//   node shot.mjs https://attrition-otel.vercel.app ../../docs/img
import {chromium} from 'playwright'

const base = process.argv[2] ?? 'https://attrition-otel.vercel.app'
const out = process.argv[3] ?? '.'
const SAMPLES = [
  ['Checkout service', 'node'],
  ['Orders and an LLM call', 'python'],
  ['My Bug Smash winner', 'bugsmash'],
]

const browser = await chromium.launch()

async function scanSample(page, label) {
  await page.getByRole('button', {name: new RegExp(label)}).click()
  await page.waitForSelector('.stats', {timeout: 60000})
  await page.waitForSelector('.trace', {timeout: 60000})
  await page.waitForTimeout(600)
}

for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 2, colorScheme: scheme})
  await page.goto(base, {waitUntil: 'networkidle'})
  for (const [label, file] of SAMPLES) {
    await scanSample(page, label)
    await page.screenshot({path: `${out}/${file}-${scheme}.png`, fullPage: true})
    console.log('saved', `${file}-${scheme}`)
  }
  await page.goto(`${base}/decisions`, {waitUntil: 'networkidle'})
  await page.screenshot({path: `${out}/decisions-${scheme}.png`, fullPage: true})
  console.log('saved', `decisions-${scheme}`)
  await page.close()
}

// The first screen a visitor sees after one click: the hero plus the first findings.
{
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}, deviceScaleFactor: 2, colorScheme: 'light'})
  await page.goto(base, {waitUntil: 'networkidle'})
  await scanSample(page, 'Checkout service')
  await page.screenshot({path: `${out}/hero.png`})
  console.log('saved hero')

  // A real chat answer, with the Context calls behind it opened.
  await page.getByPlaceholder('Ask about any attribute, namespace or release').fill('We still record http.server.duration in milliseconds. What should we use now?')
  await page.getByRole('button', {name: 'Ask'}).click()
  await page.waitForSelector('.msg.assistant .md', {timeout: 90000})
  await page.waitForFunction(() => !document.querySelector('.chat-input button')?.textContent?.includes('Thinking'), null, {timeout: 90000})
  await page.locator('.toolcalls summary').first().click().catch(() => {})
  await page.waitForTimeout(800)
  await page.locator('.chat').screenshot({path: `${out}/chat.png`})
  console.log('saved chat')
  await page.close()
}

// Phone width.
{
  const page = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 3, colorScheme: 'light'})
  await page.goto(base, {waitUntil: 'networkidle'})
  await scanSample(page, 'Checkout service')
  await page.locator('.results').scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await page.screenshot({path: `${out}/mobile.png`})
  console.log('saved mobile')
  await page.close()
}

await browser.close()
