// Builds a unified diff from line-level string replacements.
export type Edit = {line: number; from: string; to: string}

export function buildPatch(code: string, edits: Edit[], file = 'input'): string {
  const lines = code.split('\n')
  const after = [...lines]
  const changed = new Set<number>()
  for (const e of edits) {
    const i = e.line - 1
    if (after[i]?.includes(e.from)) {
      after[i] = after[i].split(e.from).join(e.to)
      changed.add(i)
    }
  }
  if (!changed.size) return ''

  const CONTEXT = 2
  const idx = [...changed].sort((a, b) => a - b)
  const hunks: Array<[number, number]> = []
  for (const i of idx) {
    const start = Math.max(0, i - CONTEXT)
    const end = Math.min(lines.length - 1, i + CONTEXT)
    const last = hunks.at(-1)
    if (last && start <= last[1] + 1) last[1] = end
    else hunks.push([start, end])
  }

  const out = [`--- a/${file}`, `+++ b/${file}`]
  for (const [start, end] of hunks) {
    const len = end - start + 1
    out.push(`@@ -${start + 1},${len} +${start + 1},${len} @@`)
    for (let i = start; i <= end; i++) {
      if (changed.has(i)) out.push(`-${lines[i]}`, `+${after[i]}`)
      else out.push(` ${lines[i]}`)
    }
  }
  return out.join('\n') + '\n'
}
