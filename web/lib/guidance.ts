// Pulls per-attribute migration guidance out of Knowledge Base entries.
//
// The registry says what an attribute was renamed to. The official migration
// guides, distilled into the Knowledge Base, say what else changed with it:
// behaviour, requirement level, and how to dual-emit during the move. This
// module finds the table row that mentions a key and keeps its comment.

export type Guidance = {
  entry: string
  section: string | null
  change: string
  comment: string | null
  appliesToOtherSpanKind?: boolean
  // The registry calls it a rename, but the guide says the old attribute was
  // removed and folded into the new one. The value may need reshaping.
  disagreesWithRegistry?: boolean
}

export const GUIDE_FOR_NAMESPACE: Record<string, string> = {
  http: 'migration/guides/http',
  net: 'migration/guides/http',
  url: 'migration/guides/http',
  db: 'migration/guides/database',
  rpc: 'migration/guides/rpc',
  code: 'migration/guides/code',
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

export function guidanceFor(key: string, entry: string, text: string): Guidance | null {
  const needle = `\`${key}\``
  let section: string | null = null
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{2,4}\s+(.+)$/)
    if (heading) section = heading[1].trim()
    if (!line.trim().startsWith('|') || !line.includes(needle)) continue
    const [change, ...rest] = cells(line)
    // Only rows where the key is the subject of the change, not a mention in a comment.
    if (!change.startsWith(needle)) continue
    const comment = rest.join(' ').trim()
    return {entry, section, change: change.replace(/`/g, ''), comment: comment || null}
  }
  return null
}

export function optInHint(text: string): string | null {
  const lines = text.split('\n').filter((l) => l.includes('OTEL_SEMCONV_STABILITY_OPT_IN') && !l.trim().startsWith('|'))
  const line = lines.find((l) => l.includes('/dup')) ?? lines.find((l) => /\b(MAY use|support)/.test(l))
  return line ? line.replace(/\s*\[\d+\]/g, '').trim() : null
}
