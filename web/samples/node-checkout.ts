// Written for this demo: a checkout service that is both an HTTP server and an
// HTTP client, instrumented by hand with the pre-1.21 constant names.
import {metrics, trace, SpanKind} from '@opentelemetry/api'
import {
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_STATUS_CODE,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_HTTP_URL,
} from '@opentelemetry/semantic-conventions'

const tracer = trace.getTracer('checkout')
const meter = metrics.getMeter('checkout')

// Request timing, recorded the way the pre-1.21 conventions described it.
const serverDuration = meter.createHistogram('http.server.duration', {unit: 'ms'})
const clientDuration = meter.createHistogram('http.client.duration', {unit: 'ms'})

export async function handleCheckout(req: Request): Promise<Response> {
  const started = performance.now()
  return tracer.startActiveSpan('POST /checkout', {kind: SpanKind.SERVER}, async (server) => {
    server.setAttribute(SEMATTRS_HTTP_METHOD, req.method)
    server.setAttribute(SEMATTRS_NET_PEER_NAME, new URL(req.url).hostname)

    const quote = await fetchQuote('https://pricing.internal/quote')

    server.setAttribute(SEMATTRS_HTTP_STATUS_CODE, 200)
    serverDuration.record(performance.now() - started)
    server.end()
    return Response.json(quote)
  })
}

async function fetchQuote(url: string) {
  return tracer.startActiveSpan('GET /quote', {kind: SpanKind.CLIENT}, async (client) => {
    client.setAttribute(SEMATTRS_HTTP_URL, url)
    client.setAttribute('net.peer.name', new URL(url).hostname)
    client.setAttribute('http.method', 'GET')
    const t0 = performance.now()
    const res = await fetch(url)
    clientDuration.record(performance.now() - t0)
    client.setAttribute('http.status_code', res.status)
    client.end()
    return res.json()
  })
}
