import 'server-only'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

export type Sample = {id: string; label: string; language: string; origin: string; code: string}

const read = (file: string) => readFileSync(join(process.cwd(), 'samples', file), 'utf8')

export function samples(): Sample[] {
  return [
    {
      id: 'bugsmash',
      label: 'My Bug Smash winner',
      language: 'Go',
      origin: 'Real code: redishook.go from github.com/vignesh2027/bugsmash-sentry-demo, the entry that won DEV Summer Bug Smash.',
      code: read('bugsmash-redishook.go'),
    },
    {
      id: 'node',
      label: 'Checkout service',
      language: 'TypeScript',
      origin: 'Written for this demo: one file that is both an HTTP server and an HTTP client, with request-duration metrics.',
      code: read('node-checkout.ts'),
    },
    {
      id: 'python',
      label: 'Orders and an LLM call',
      language: 'Python',
      origin: 'Written for this demo: a database span, a GenAI span, a pool metric, a chat event and a cloud resource, using names from several spec eras.',
      code: read('python-orders.py'),
    },
  ]
}
