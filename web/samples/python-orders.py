# Written for this demo: a Flask handler that queries Postgres and calls
# an LLM, instrumented with attribute names from several spec eras.
from opentelemetry import trace
from opentelemetry.semconv.trace import SpanAttributes

tracer = trace.get_tracer("orders")


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
        return client.chat(orders)
