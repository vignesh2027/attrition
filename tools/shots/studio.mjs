// Screenshots of the Studio, served locally with token auth (same project and data as the hosted one).
import {chromium} from 'playwright'
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
const out = process.argv[2]
const only = process.argv[3]
const {authToken} = JSON.parse(readFileSync(homedir() + '/.config/sanity/config.json', 'utf8'))
const browser = await chromium.launch()
const ctx = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 2})
await ctx.addInitScript((t) => localStorage.setItem('__studio_auth_token_y9raau23', JSON.stringify({token: t, time: new Date().toISOString()})), authToken)
const page = await ctx.newPage()
const open = async () => {
  await page.goto('http://localhost:3334/structure', {waitUntil: 'domcontentloaded', timeout: 120000})
  await page.getByText('Deprecated, by verdict').waitFor({timeout: 60000})
  await page.waitForTimeout(1500)
}
const click = async (text, exact = true) => {
  await page.getByText(text, {exact}).first().click()
  await page.waitForTimeout(2500)
}
const hideToast = () =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll('div,section,aside')) {
      if (el.textContent?.startsWith("What's new") && el.getBoundingClientRect().height < 200) el.remove()
    }
  })
const shot = async (name) => {
  if (only && only !== name) return
  await hideToast()
  await page.mouse.move(1430, 890)
  await page.waitForTimeout(800)
  await page.screenshot({path: `${out}/${name}.png`})
  console.log('saved', name)
}

// Opens a list from the root, filters it with its search box, opens the document,
// and waits for the form instead of a loading spinner.
const openDoc = async (path, name, tab, scrollTo) => {
  await open()
  for (const p of path) await click(p)
  const search = page.getByPlaceholder('Search list').last()
  await search.fill(name)
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="pane-content"] a, [data-ui="PreviewCard"]').filter({hasText: name}).first().click().catch(() => page.getByText(name, {exact: true}).last().click())
  await page.waitForTimeout(1500)
  await page.getByText('Loading document').waitFor({state: 'detached', timeout: 90000}).catch(() => {})
  await page.waitForTimeout(3000)
  if (tab) {
    await page.getByRole('tab', {name: tab}).first().click().catch(() => {})
    await page.waitForTimeout(1500)
  }
  if (scrollTo) {
    await page.getByText(scrollTo, {exact: true}).first().scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(1000)
  }
}

if (!only || only === 'studio-span-kind') await openDoc(['Deprecated, by verdict', 'Depends on span kind (client vs server)'], 'net.peer.name', 'Deprecation', 'Replacements')
await shot('studio-span-kind')

if (!only || only === 'studio-dropped-metric') await openDoc(['Dropped without notice'], 'http.server.duration', 'Deprecation')
await shot('studio-dropped-metric')

if (!only || only === 'studio-unit-change') await openDoc(['Metrics with a unit change'], 'db.client.connections.wait_time', 'Deprecation', 'Unit Change')
await shot('studio-unit-change')

if (!only || only === 'studio-erratum') await openDoc(['Spec errata'], 'system.linux.memory.available', 'Spec', 'Known spec erratum')
await shot('studio-erratum')

if (!only || only === 'studio-agent-context') await openDoc(['Agent Context'], 'Attrition', null, 'Instructions')
await shot('studio-agent-context')
await browser.close()
