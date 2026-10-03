// Reads the Knowledge Base's conflict decisions and standing instructions,
// so anyone can see what Attrition was told to treat as ground truth.
import 'server-only'
import {createClient} from '@sanity/client'

export type Side = {claim: string; value?: string; entryPaths?: string[]; sourceIds?: string[]}
export type Decision = {id: string; issue: string; severity: string; sides: Side[]; chosen: number | null; status: string; updatedAt: string}
export type Instruction = {id: string; statement: string; origin: string; status: string; createdAt: string; sourceCount: number}

export async function loadDecisions(): Promise<{decisions: Decision[]; instructions: Instruction[]; otherIssues: number} | null> {
  const token = process.env.SANITY_ORGANIZATION_TOKEN
  const kbId = process.env.SANITY_KB_ID
  if (!token || !kbId) return null
  const kb = createClient({
    apiVersion: '2026-08-25',
    token,
    useCdn: false,
    resource: {type: 'knowledge-base', id: kbId},
    context: {organizationId: process.env.SANITY_ORG_ID ?? 'oc2g3x7ee'},
  })
  const [issues, instructions] = await Promise.all([kb.context.issues.list(), kb.context.instructions.list()])
  type Raw = {_id: string; _updatedAt: string; status: string; resolution?: number | null; content: {kind: string; issue: string; severity: string; sides?: Side[]}}
  const raw = issues as unknown as Raw[]
  return {
    decisions: raw
      .filter((i) => i.content.kind === 'conflict')
      .map((i) => ({
        id: i._id,
        issue: i.content.issue,
        severity: i.content.severity,
        sides: i.content.sides ?? [],
        chosen: typeof i.resolution === 'number' ? i.resolution : null,
        status: i.status,
        updatedAt: i._updatedAt,
      })),
    instructions: (instructions as unknown as Array<{_id: string; _createdAt: string; statement: string; origin: string; status: string; scopeSources?: unknown[]}>)
      .filter((i) => i.status === 'active')
      .map((i) => ({id: i._id, statement: i.statement, origin: i.origin, status: i.status, createdAt: i._createdAt, sourceCount: i.scopeSources?.length ?? 0})),
    otherIssues: raw.filter((i) => i.content.kind !== 'conflict').length,
  }
}
