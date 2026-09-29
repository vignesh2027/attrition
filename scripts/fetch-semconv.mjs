// Downloads every tagged release of open-telemetry/semantic-conventions from
// v1.21.0 onwards into .cache/semconv/<tag>. Only the model/ folder is kept.
// Re-running skips tags that are already present.
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'

const REPO = 'https://github.com/open-telemetry/semantic-conventions'
const CACHE = join(process.cwd(), '.cache', 'semconv')
const FIRST = [1, 21, 0]

function parse(tag) {
  return tag.slice(1).split('.').map(Number)
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

const tags = execFileSync('git', ['ls-remote', '--tags', REPO], {encoding: 'utf8'})
  .split('\n')
  .map((line) => line.match(/refs\/tags\/(v\d+\.\d+\.\d+)$/)?.[1])
  .filter(Boolean)
  .filter((tag) => cmp(parse(tag), FIRST) >= 0)
  .sort((a, b) => cmp(parse(a), parse(b)))

mkdirSync(CACHE, {recursive: true})
for (const tag of tags) {
  const dest = join(CACHE, tag)
  if (existsSync(join(dest, 'model'))) continue
  mkdirSync(dest, {recursive: true})
  const url = `https://codeload.github.com/open-telemetry/semantic-conventions/tar.gz/refs/tags/${tag}`
  execFileSync('sh', ['-c', `curl -sfL "${url}" | tar xz -C "${dest}" --strip-components=1 "*/model"`])
  console.log(`fetched ${tag}`)
}
console.log(`${tags.length} releases in ${CACHE}`)
