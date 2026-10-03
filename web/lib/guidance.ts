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

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

export function guidanceFor(key: string, entry: string, text: string): Guidance | null {
  const needle = `\`${key}\``
  let section: string | null = null
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    const heading = line.match(/^#{2,4}\s+(.+)$/)
    if (heading) section = heading[1].trim()
    // Heading layout: "### `old` → `new`", followed by bullets such as "- **Unit**: `ms` → `s`".
    if (heading && heading[1].trim().startsWith(needle) && heading[1].includes('→')) {
      const target = heading[1].split('→')[1].replace(/`/g, '').trim()
      const unit = lines
        .slice(i + 1, i + 6)
        .map((l) => l.match(/\*\*Unit\*\*:\s*`([^`]+)`\s*→\s*`([^`]+)`/))
        .find(Boolean)
      return {entry, section: 'Metrics', change: `${key} → ${target}`, comment: unit ? `Unit changes from ${unit[1]} to ${unit[2]}` : null}
    }
    if (!line.trim().startsWith('|') || !line.includes(needle)) continue
    const [change, ...rest] = cells(line)
    // Metric tables: "| Name | `old` | `new` |", with a "| Unit | ... |" row nearby.
    if (/^name$/i.test(change) && rest[0] === needle && rest[1]) {
      const unit = lines.slice(i + 1, i + 4).find((l) => /^\|\s*Unit\s*\|/i.test(l))
      const u = unit ? cells(unit) : null
      return {
        entry,
        section,
        change: `${key} → ${rest[1].replace(/`/g, '')}`,
        comment: u && u[1] !== u[2] ? `Unit changes from ${u[1].replace(/`/g, '')} to ${u[2].replace(/`/g, '')}` : null,
      }
    }
    // Only rows where the key is the subject of the change, not a mention in a comment.
    if (!change.startsWith(needle)) continue
    // Two table layouts occur: "old -> new | comment" and "old | new | comment".
    if (!change.includes('→') && rest.length >= 2 && /^`[^`]+`(\s*(,|and|or)\s*`[^`]+`)*$/.test(rest[0])) {
      const comment = rest.slice(1).join(' ').replace(/\s*\[\d+\]/g, '').trim()
      return {entry, section, change: `${key} → ${rest[0].replace(/`/g, '')}`, comment: comment || null}
    }
    const comment = rest.join(' ').replace(/\s*\[\d+\]/g, '').trim()
    return {entry, section, change: change.replace(/`/g, ''), comment: comment || null}
  }
  // Prose fallback: "`db.name` (integrated into `db.namespace`)".
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const line of lines) {
    const m = line.match(new RegExp(`${esc}\\s*\\(([^)]*\\b(?:integrated|replaced|removed|renamed)\\b[^)]*)\\)`, 'i'))
    if (m) return {entry, section: null, change: key, comment: m[1].replace(/`/g, '').trim()}
  }
  return null
}

// The dual-emit setting a guide recommends, from its opt-in table or prose.
export function optInHint(text: string): string | null {
  if (!text.includes('OTEL_SEMCONV_STABILITY_OPT_IN')) return null
  const dup = text.split('\n').find((l) => /`[a-z]+\/dup`/.test(l))
  if (!dup) return null
  const value = dup.match(/`([a-z]+\/dup)`/)![1]
  const rest = dup.trim().startsWith('|') ? dup.split('|').map((c) => c.trim()).filter(Boolean).slice(1).join(' ') : ''
  return `Set OTEL_SEMCONV_STABILITY_OPT_IN=${value} to ${rest ? rest.charAt(0).toLowerCase() + rest.slice(1).replace(/\s*\[\d+\]/g, '') : 'emit both the old and the new conventions during the move'}.`
}
