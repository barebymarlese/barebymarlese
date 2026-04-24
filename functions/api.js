export async function onRequest(context) {x
  const { request, env } = context;
  const url = new URL(request.url);

  const jsonHeaders = { "Content-Type": "application/json" };

  const slotsByDay = {
    1: ["17:00", "17:30", "18:00", "18:30", "19:00"],
    2: ["17:00", "17:30", "18:00", "18:30", "19:00"],
    3: ["17:00", "17:30", "18:00", "18:30", "19:00"],
    4: ["17:00", "17:30", "18:00", "18:30", "19:00"],
    5: ["17:00", "17:30", "18:00", "18:30", "19:00"],
    6: ["09:00", "09:30", "10:00", "10:30"]
  };

  function getDayNumber(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(year, month - 1, day).getDay();
  }

  async function sendEmail({ to, subject, html }) {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to,
        reply_to: env.REPLY_TO_EMAIL || env.TO_EMAIL,
        subject,
        html
      })
    });
  }

  if (request.method === "GET") {
    const date = url.searchParams.get("date");

    if (!date) {
      return new Response(JSON.stringify([]), { headers: jsonHeaders });
    }

    const dayNumber = getDayNumber(date);
    const allSlots = slotsByDay[dayNumber] || [];

    const booked = await env.DB.prepare(
      "SELECT appointment_time FROM appointments WHERE appointment_date = ? AND status = 'confirmed'"
    ).bind(date).all();

    const bookedTimes = booked.results.map(row => row.appointment_time);
    const availableSlots = allSlots.filter(slot => !bookedTimes.includes(slot));

    return new Response(JSON.stringify(availableSlots), { headers: jsonHeaders });
  }

  if (request.method === "POST") {
    const body = await request.json();

    const clientName = body.client_name || "Client";
    const email = body.email || "";
    const phone = body.phone || "";
    const appointmentDate = body.appointment_date;
    const appointmentTime = body.appointment_time;

    if (!appointmentDate || !appointmentTime) {
      return new Response("Missing appointment date or time", { status: 400 });
    }

    try {
      await env.DB.prepare(
        `INSERT INTO appointments
        (client_name, email, phone, appointment_date, appointment_time, status)
        VALUES (?, ?, ?, ?, ?, 'confirmed')`
      )
      .bind(clientName, email, phone, appointmentDate, appointmentTime)
      .run();

      await sendEmail({
        to: env.TO_EMAIL,
        subject: "New BARE by Marlese booking",
        html: `
          <h2>New booking received</h2>
          <p><strong>Client:</strong> ${clientName}</p>
          <p><strong>Email:</strong> ${email || "Not provided"}</p>
          <p><strong>Phone:</strong> ${phone || "Not provided"}</p>
          <p><strong>Date:</strong> ${appointmentDate}</p>
          <p><strong>Time:</strong> ${appointmentTime}</p>
        `
      });

      if (email) {
        await sendEmail({
          to: email,
          subject: "Your BARE by Marlese appointment is confirmed",
          html: `
            <h2>Your appointment is confirmed</h2>
            <p>Thank you for booking with <strong>BARE by Marlese</strong>.</p>
            <p><strong>Date:</strong> ${appointmentDate}</p>
            <p><strong>Time:</strong> ${appointmentTime}</p>
            <p>If you need to change your appointment, please reply to this email.</p>
          `
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: jsonHeaders
      });

    } catch (e) {
      return new Response("Slot already taken", { status: 409 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
}
