import {scan} from '@/lib/analyze'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_BYTES = 80_000

export async function POST(req: Request) {
  let code: unknown
  try {
    ;({code} = await req.json())
  } catch {
    return Response.json({error: 'Send JSON: {"code": "..."}'}, {status: 400})
  }
  if (typeof code !== 'string' || !code.trim()) {
    return Response.json({error: 'Paste some code first.'}, {status: 400})
  }
  if (code.length > MAX_BYTES) {
    return Response.json({error: `Keep it under ${MAX_BYTES / 1000} KB; paste one file at a time.`}, {status: 413})
  }
  try {
    return Response.json(await scan(code))
  } catch (err) {
    return Response.json({error: err instanceof Error ? err.message : 'Scan failed'}, {status: 502})
  }
}
