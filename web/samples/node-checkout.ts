// Written for this demo: a checkout service that is both an HTTP server and an
// HTTP client, instrumented by hand with the pre-1.21 constant names.
import {trace, SpanKind} from '@opentelemetry/api'
import {
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_STATUS_CODE,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_HTTP_URL,
} from '@opentelemetry/semantic-conventions'

const tracer = trace.getTracer('checkout')

export async function handleCheckout(req: Request): Promise<Response> {
  return tracer.startActiveSpan('POST /checkout', {kind: SpanKind.SERVER}, async (server) => {
    server.setAttribute(SEMATTRS_HTTP_METHOD, req.method)
    server.setAttribute(SEMATTRS_NET_PEER_NAME, new URL(req.url).hostname)

    const quote = await fetchQuote('https://pricing.internal/quote')

    server.setAttribute(SEMATTRS_HTTP_STATUS_CODE, 200)
    server.end()
    return Response.json(quote)
  })
}

async function fetchQuote(url: string) {
  return tracer.startActiveSpan('GET /quote', {kind: SpanKind.CLIENT}, async (client) => {
    client.setAttribute(SEMATTRS_HTTP_URL, url)
    client.setAttribute('net.peer.name', new URL(url).hostname)
    client.setAttribute('http.method', 'GET')
    const res = await fetch(url)
    client.setAttribute('http.status_code', res.status)
    client.end()
    return res.json()
  })
}
