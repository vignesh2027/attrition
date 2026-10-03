# Written for this demo: a Flask handler that queries Postgres and calls
# an LLM, instrumented with names from several spec eras.
from opentelemetry import _logs, metrics, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.semconv.trace import SpanAttributes

resource = Resource.create({"cloud.platform": "azure_vm", "service.name": "orders"})
tracer = trace.get_tracer("orders")
meter = metrics.get_meter("orders")
logger = _logs.get_logger("orders")

# Connection pool timing, in milliseconds.
pool_wait = meter.create_histogram("db.client.connections.wait_time", unit="ms")


def list_orders(conn, customer_id):
    with tracer.start_as_current_span("SELECT orders", kind=trace.SpanKind.CLIENT) as span:
        span.set_attribute(SpanAttributes.DB_SYSTEM, "postgresql")
        span.set_attribute(SpanAttributes.DB_STATEMENT, "SELECT * FROM orders WHERE customer_id = %s")
        span.set_attribute("db.sql.table", "orders")
        span.set_attribute("db.name", "shop")
        return conn.execute("SELECT * FROM orders WHERE customer_id = %s", (customer_id,))


def summarize(client, orders):
    with tracer.start_as_current_span("chat gpt-4o") as span:
        span.set_attribute("gen_ai.request.model", "gpt-4o")
        span.set_attribute("gen_ai.usage.input_tokens", 812)
        span.set_attribute("code.function", "summarize")
        reply = client.chat(orders)
        logger.emit(_logs.LogRecord(event_name="gen_ai.choice", body=reply.text))
        return reply
