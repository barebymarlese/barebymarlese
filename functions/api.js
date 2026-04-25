export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const jsonHeaders = { "Content-Type": "application/json" };

const consultationSlots = {
  1: ["17:00", "17:30", "18:00", "18:30", "19:00"],
  2: ["17:00", "17:30", "18:00", "18:30", "19:00"],
  3: ["17:00", "17:30", "18:00", "18:30", "19:00"],
  4: ["17:00", "17:30", "18:00", "18:30", "19:00"],
  5: ["17:00", "17:30", "18:00", "18:30", "19:00"],
  6: ["09:00", "09:30", "10:00", "10:30"]
};

const treatmentSlots = {
  1: ["17:00", "18:00", "19:00"],
  2: ["17:00", "18:00", "19:00"],
  3: ["17:00", "18:00", "19:00"],
  4: ["17:00", "18:00", "19:00"],
  5: ["17:00", "18:00", "19:00"],
  6: ["09:00", "10:00", "11:00"]
};
function getSlotsByType(type, dateString) {
  const dayNumber = getDayNumber(dateString);

  if (type === "treatment") {
    return treatmentSlots[dayNumber] || [];
  }

  return consultationSlots[dayNumber] || [];
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getDayNumber(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day).getDay();
}

function slotDateTime(date, time) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

function isPastSlot(date, time) {
  return slotDateTime(date, time).getTime() <= Date.now();
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
if (request.method === "GET" && url.searchParams.get("admin") === "bookings") {
  const bookings = await env.DB.prepare(
    `SELECT id, client_name, email, phone, appointment_date, appointment_time, status
     FROM appointments
     ORDER BY appointment_date ASC, appointment_time ASC`
  ).all();

  return new Response(JSON.stringify(bookings.results), {
    headers: jsonHeaders
  });
}

if (request.method === "POST" && url.searchParams.get("admin") === "cancel") {
  const body = await request.json();
  const id = body.id;

  if (!id) {
    return new Response("Missing booking ID", { status: 400 });
  }

  await env.DB.prepare(
    "UPDATE appointments SET status = 'cancelled' WHERE id = ?"
  ).bind(id).run();

  return new Response(JSON.stringify({ success: true }), {
    headers: jsonHeaders
  });
}

if (request.method === "GET" && url.searchParams.get("reschedule") === "booking") {
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");

  if (!id || !token) {
    return new Response("Missing booking details", { status: 400 });
  }

  const booking = await env.DB.prepare(
    `SELECT id, client_name, email, phone, appointment_date, appointment_time, status
     FROM appointments
     WHERE id = ? AND reschedule_token = ?`
  ).bind(id, token).first();

  if (!booking) {
    return new Response("Booking not found", { status: 404 });
  }

  return new Response(JSON.stringify(booking), {
    headers: jsonHeaders
  });
}

if (request.method === "POST" && url.searchParams.get("reschedule") === "update") {
  const body = await request.json();

  const { id, token, appointment_date, appointment_time } = body;

  if (!id || !token || !appointment_date || !appointment_time) {
    return new Response("Missing reschedule details", { status: 400 });
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM appointments WHERE id = ? AND reschedule_token = ? AND status = 'confirmed'`
  ).bind(id, token).first();

  if (!existing) {
    return new Response("Booking not found", { status: 404 });
  }

  const dayNumber = getDayNumber(appointment_date);
  const validSlots = slotsByDay[dayNumber] || [];

  if (!validSlots.includes(appointment_time)) {
    return new Response("Invalid appointment time", { status: 400 });
  }

  if (isPastSlot(appointment_date, appointment_time)) {
    return new Response("This appointment time has already passed", { status: 400 });
  }

  try {
    await env.DB.prepare(
      `UPDATE appointments
       SET appointment_date = ?, appointment_time = ?
       WHERE id = ? AND reschedule_token = ?`
    ).bind(appointment_date, appointment_time, id, token).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: jsonHeaders
    });

  } catch (e) {
    return new Response("That slot is already taken", { status: 409 });
  }
}
  
if (request.method === "GET") {
  const date = url.searchParams.get("date");

  if (!date) {
    return new Response(JSON.stringify({
      slots: [],
      nextAvailable: null
    }), { headers: jsonHeaders });
  }

  const bookingType = url.searchParams.get("type") || "consultation";
  const allSlots = getSlotsByType(bookingType, date);

  const booked = await env.DB.prepare(
    "SELECT appointment_time FROM appointments WHERE appointment_date = ? AND booking_type = ? AND status = 'confirmed'"
).bind(date, bookingType).all();

  const bookedTimes = booked.results.map(row => row.appointment_time);

  const availableSlots = allSlots.filter(slot => {
    return !bookedTimes.includes(slot) && !isPastSlot(date, slot);
  });

  const nextAvailable = availableSlots.length ? availableSlots[0] : null;

  return new Response(JSON.stringify({
    slots: availableSlots,
    nextAvailable
  }), { headers: jsonHeaders });
}

  if (request.method === "POST") {
    const body = await request.json();

    const clientName = body.client_name || "Client";
    const email = body.email || "";
    const phone = body.phone || "";
    const appointmentDate = body.appointment_date;
    const appointmentTime = body.appointment_time;
    const bookingType = body.booking_type || "consultation";
    const packageType = body.package_type || null;
    const amountPaid = body.amount_paid || null;

if (!appointmentDate || !appointmentTime) {
  return new Response("Missing appointment date or time", { status: 400 });
}

const validSlots = getSlotsByType(bookingType, appointmentDate);
const validSlots = slotsByDay[dayNumber] || [];

if (!validSlots.includes(appointmentTime)) {
  return new Response("Invalid appointment time", { status: 400 });
}

if (isPastSlot(appointmentDate, appointmentTime)) {
  return new Response("This appointment time has already passed", { status: 400 });
}

try {
const rescheduleToken = crypto.randomUUID();

const insertResult = await env.DB.prepare(
  `INSERT INTO appointments
  (client_name, email, phone, appointment_date, appointment_time, status, reschedule_token)
  VALUES (?, ?, ?, ?, ?, 'confirmed', ?)`
)
.bind(clientName, email, phone, appointmentDate, appointmentTime, rescheduleToken)
.run();

const bookingId = insertResult.meta.last_row_id;
const rescheduleLink = `https://barebymarlese.com/reschedule.html?id=${bookingId}&token=${rescheduleToken}`;

      const safeName = escapeHtml(clientName);
      const safeEmail = escapeHtml(email || "Not provided");
      const safePhone = escapeHtml(phone || "Not provided");
      const safeDate = escapeHtml(appointmentDate);
      const safeTime = escapeHtml(appointmentTime);

      await sendEmail({
        to: env.TO_EMAIL,
        subject: "New BARE by Marlese booking",
        html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>

    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">
      NEW BOOKING RECEIVED
    </div>

    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p><strong>Client:</strong> ${safeName}</p>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Phone:</strong> ${safePhone}</p>
      <p><strong>Date:</strong> ${safeDate}</p>
      <p><strong>Time:</strong> ${safeTime}</p>
    </div>

    <p>This appointment has been saved in your Cloudflare D1 booking database.</p>
  </div>
</div>
        `
      });

      if (email) {
        const replyAddress = env.REPLY_TO_EMAIL || env.TO_EMAIL;

        await sendEmail({
          to: email,
          subject: "Appointment Confirmed – BARE by Marlese",
          html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;box-shadow:0 10px 30px rgba(0,0,0,0.08);">

    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>

    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">
      APPOINTMENT CONFIRMED
    </div>

    <p>Hi ${safeName},</p>

    <p>Thank you for booking with <strong>BARE by Marlese</strong>. Your appointment has been confirmed.</p>

    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p style="margin:0 0 8px;"><strong>Appointment summary</strong></p>
      <p><strong>Date:</strong> ${safeDate}</p>
      <p><strong>Time:</strong> ${safeTime}</p>
      <p><strong>Phone:</strong> ${safePhone}</p>
    </div>

    <p>Your £30 deposit will be deducted from your treatment cost.</p>

    <p>If you need to reschedule or cancel, please use one of the links below. At least 24 hours' notice is required for your deposit to remain transferable.</p>

    <div style="text-align:center;margin:22px 0;">
      <a href="${rescheduleLink}"
         style="display:inline-block;background:#5e6959;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">
        Reschedule
      </a>

      <a href="mailto:${replyAddress}?subject=Cancel appointment - ${safeDate} ${safeTime}"
         style="display:inline-block;background:#878274;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">
        Cancel
      </a>
    </div>

    <p>If you have any questions, simply reply to this email.</p>

    <p style="margin-top:20px;">
      Kind regards,<br>
      <strong>Marlese</strong><br>
      BARE by Marlese
    </p>

    <p style="margin-top:12px;">
      <a href="https://barebymarlese.com" style="color:#5e6959;text-decoration:none;">
        barebymarlese.com
      </a>
    </p>

  </div>
</div>
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
