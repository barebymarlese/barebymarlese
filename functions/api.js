export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. Fetch available slots
  if (url.pathname === "/api/slots" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT time FROM appointments WHERE status = 'confirmed'").all();
    return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
  }

  // 2. Save a new booking
  if (url.pathname === "/api/book" && request.method === "POST") {
    const { name, email, service, time } = await request.json();
    try {
      await env.DB.prepare(
        "INSERT INTO appointments (name, email, service, time, status) VALUES (?, ?, ?, ?, 'confirmed')"
      ).bind(name, email, service, time).run();
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (e) {
      return new Response("Slot already taken", { status: 400 });
    }
  }

  return new Response("Not Found", { status: 404 });
}
xx
