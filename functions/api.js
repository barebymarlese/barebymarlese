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
    if (type === "treatment") return treatmentSlots[dayNumber] || [];
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

  function isLateCancellation(date, time) {
    const appointmentMs = slotDateTime(date, time).getTime();
    const hoursUntilAppointment = (appointmentMs - Date.now()) / (1000 * 60 * 60);
    return hoursUntilAppointment < 24;
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

  const bookings = await env.DB.prepare(`
    SELECT
      id,
      client_name,
      email,
      phone,
      appointment_date,
      appointment_time,
      status,
      booking_type,
      package_type,
      tattoo_size,
      amount_paid,
      payment_status,
      payment_type,
      sessions_total,
      sessions_used,
      package_status,
      payment_reference,
      treatment_category,
      treatment_name,
      reschedule_token,
      whatsapp_reminder_sent,
      aftercare_sent
    FROM appointments
    ORDER BY appointment_date ASC, appointment_time ASC
  `).all();

  for (const booking of bookings.results) {

    if (booking.booking_type === "treatment") {

      const sessions = await env.DB.prepare(`
        SELECT
  id,
  session_number,
  appointment_date,
  appointment_time,
  status,
  reschedule_token,
  last_cancelled_date,
  last_cancelled_time,
  cancelled_at,
  cancelled_count
FROM treatment_sessions
        WHERE appointment_id = ?
        ORDER BY session_number ASC
      `).bind(booking.id).all();

      booking.sessions = sessions.results || [];

    }

  }

  return new Response(JSON.stringify(bookings.results), {
    headers: jsonHeaders
  });

}

  if (request.method === "POST" && url.searchParams.get("admin") === "cancel") {
  const body = await request.json();
  const id = body.id;

  if (!id) return new Response("Missing booking ID", { status: 400 });

  const booking = await env.DB.prepare(
  `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type, reschedule_token, treatment_category, treatment_name
   FROM appointments
   WHERE id = ?`
).bind(id).first();

  if (!booking) {
    return new Response("Booking not found", { status: 404 });
  }

  if (booking.status !== "confirmed") {
  return new Response("This appointment has already been cancelled, completed, or can no longer be changed.", { status: 409 });
}

  const lateCancellation = isLateCancellation(booking.appointment_date, booking.appointment_time);
  const depositTransferable = !lateCancellation;

  await env.DB.prepare(
    `UPDATE appointments
     SET status = 'cancelled'
     WHERE id = ?`
  ).bind(id).run();

  await sendEmail({
    to: env.TO_EMAIL,
    subject: "Booking Cancelled",
    html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">BOOKING CANCELLED BY ADMIN</div>
    <p><strong>Client:</strong> ${escapeHtml(booking.client_name || "Client")}</p>
    <p><strong>Email:</strong> ${escapeHtml(booking.email || "Not provided")}</p>
    <p><strong>Phone:</strong> ${escapeHtml(booking.phone || "Not provided")}</p>
    <p><strong>Type:</strong> ${escapeHtml(booking.booking_type || "consultation")}</p>
    <br>
    <p><strong>Cancelled appointment</strong></p>
    <p><strong>Date:</strong> ${escapeHtml(booking.appointment_date)}</p>
    <p><strong>Time:</strong> ${escapeHtml(booking.appointment_time)}</p>
    <br>
    <p><strong>Late cancellation:</strong> ${lateCancellation ? "Yes" : "No"}</p>
    <p><strong>Deposit transferable:</strong> ${depositTransferable ? "Yes" : "No"}</p>
  </div>
</div>`
  });

  if (booking.email) {
    await sendEmail({
      to: booking.email,
      subject: "Appointment Cancelled – BARE by Marlese",
      html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">APPOINTMENT CANCELLED</div>
    <p>Hi ${escapeHtml(booking.client_name || "there")},</p>
    <p>Your appointment with <strong>BARE by Marlese</strong> has been cancelled.</p>
    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p><strong>Date:</strong> ${escapeHtml(booking.appointment_date)}</p>
      <p><strong>Time:</strong> ${escapeHtml(booking.appointment_time)}</p>
    </div>
    <p>A minimum of 24 hours’ notice is required to cancel or reschedule an appointment. Late cancellations or missed appointments may result in the session being deducted from your bundle.</p>
    <p>Treatment bundle sessions are valid for 12 months from the date of purchase. Cancelling or delaying appointments does not extend the validity period.</p>
    <p>If your appointment relates to a treatment package and you wish to rebook, please reply to this email.</p>
    <p style="margin-top:20px;">Kind regards,<br><strong>Marlese</strong><br>BARE by Marlese</p>
  </div>
</div>`
    });
  }

  return new Response(JSON.stringify({
    success: true,
    cancelled: true,
    lateCancellation,
    depositTransferable,
    clientEmailSent: Boolean(booking.email)
  }), {
    headers: jsonHeaders
  });
}

  if (request.method === "POST" && url.searchParams.get("admin") === "reminder-sent") {
    const body = await request.json();
    const id = body.id;

    if (!id) return new Response("Missing booking ID", { status: 400 });

    await env.DB.prepare(
      "UPDATE appointments SET whatsapp_reminder_sent = 'yes' WHERE id = ?"
    ).bind(id).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: jsonHeaders
    });
  }

if (request.method === "POST" && url.searchParams.get("admin") === "use-session") {
  const body = await request.json();
  const id = body.id;

  if (!id) return new Response("Missing booking ID", { status: 400 });

  const booking = await env.DB.prepare(`
    SELECT sessions_used, sessions_total
    FROM appointments
    WHERE id = ?
  `).bind(id).first();

  if (!booking) {
    return new Response("Booking not found", { status: 404 });
  }

  const currentUsed = Number(booking.sessions_used || 0);
  const total = Number(booking.sessions_total || 0);

  // 🚫 Stop going over package
  if (total > 0 && currentUsed >= total) {
    return new Response("All sessions already used", { status: 409 });
  }

  const newUsed = currentUsed + 1;

  // ✅ Auto-complete package
  const newPackageStatus = (total > 0 && newUsed >= total)
    ? "completed"
    : "active";

  await env.DB.prepare(`
    UPDATE appointments
    SET sessions_used = ?, package_status = ?
    WHERE id = ?
  `).bind(newUsed, newPackageStatus, id).run();

  return new Response(JSON.stringify({
    success: true,
    sessions_used: newUsed,
    package_status: newPackageStatus
  }), {
    headers: jsonHeaders
  });
}

if (request.method === "POST" && url.searchParams.get("admin") === "mark-paid") {
  const body = await request.json();
  const id = body.id;
  const amountPaid = Number(body.amount_paid || 0);

  if (!id) return new Response("Missing booking ID", { status: 400 });

  await env.DB.prepare(`
    UPDATE appointments
    SET payment_status = 'paid',
        amount_paid = CASE
          WHEN ? > 0 THEN ?
          ELSE amount_paid
        END
    WHERE id = ?
  `).bind(amountPaid, amountPaid, id).run();

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
      `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type, treatment_category, treatment_name
   FROM appointments
   WHERE id = ? AND reschedule_token = ?`
    ).bind(id, token).first();

    if (!booking) {
      return new Response("Booking not found", { status: 404 });
    }

    if (booking.booking_type === "treatment") {
  const sessions = await env.DB.prepare(`
    SELECT
      id,
      session_number,
      appointment_date,
      appointment_time,
      status,
      reschedule_token
    FROM treatment_sessions
    WHERE appointment_id = ?
    ORDER BY session_number ASC
  `).bind(id).all();

  booking.sessions = sessions.results || [];
}

    return new Response(JSON.stringify(booking), {
      headers: jsonHeaders
    });
  }


  if (request.method === "GET" && url.searchParams.get("cancel") === "booking") {
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");

    if (!id || !token) {
      return new Response("Missing booking details", { status: 400 });
    }

    const booking = await env.DB.prepare(
      `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type, treatment_category, treatment_name
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

    const existingBooking = await env.DB.prepare(
      `SELECT id, client_name, email, phone, booking_type, appointment_date, appointment_time, reschedule_token
       FROM appointments
       WHERE id = ? AND reschedule_token = ? AND status = 'confirmed'`
    ).bind(id, token).first();

    if (!existingBooking) {
      return new Response("Booking not found", { status: 404 });
    }

    const bookingType = existingBooking.booking_type || "consultation";

const blockedDate = await env.DB.prepare(`
  SELECT block_date, reason
  FROM blocked_dates
  WHERE block_date = ?
`).bind(appointment_date).first();

if (blockedDate) {
  return new Response("This date is unavailable", { status: 409 });
}

const validSlots = getSlotsByType(bookingType, appointment_date);

    if (!validSlots.includes(appointment_time)) {
      return new Response("Invalid appointment time", { status: 400 });
    }

    if (isPastSlot(appointment_date, appointment_time)) {
      return new Response("This appointment time has already passed", { status: 400 });
    }

    const clash = await env.DB.prepare(
      `SELECT id FROM appointments
       WHERE appointment_date = ?
       AND appointment_time = ?
       AND booking_type = ?
       AND status = 'confirmed'
       AND id != ?`
    ).bind(appointment_date, appointment_time, bookingType, id).first();

    if (clash) {
      return new Response("That slot is already taken", { status: 409 });
    }

    try {
      await env.DB.prepare(
  `UPDATE appointments
   SET appointment_date = ?,
       appointment_time = ?,
       reminder_sent = 'no'
   WHERE id = ?
   AND reschedule_token = ?`
).bind(
  appointment_date,
  appointment_time,
  id,
  token
).run();

      const manageLink = `https://barebymarlese.com/reschedule.html?id=${existingBooking.id}&token=${existingBooking.reschedule_token}`;
      const cancelLink = `https://barebymarlese.com/cancel.html?id=${existingBooking.id}&token=${existingBooking.reschedule_token}`;

      await sendEmail({
        to: env.TO_EMAIL,
        subject: "Booking Amendment",
        html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">
      BOOKING AMENDMENT
    </div>
    <p><strong>Client:</strong> ${escapeHtml(existingBooking.client_name || "Client")}</p>
    <p><strong>Email:</strong> ${escapeHtml(existingBooking.email || "Not provided")}</p>
    <p><strong>Phone:</strong> ${escapeHtml(existingBooking.phone || "Not provided")}</p>
    <p><strong>Type:</strong> ${escapeHtml(existingBooking.booking_type || "consultation")}</p>
    <br>
    <p><strong>Previous appointment</strong></p>
    <p><strong>Date:</strong> ${escapeHtml(existingBooking.appointment_date)}</p>
    <p><strong>Time:</strong> ${escapeHtml(existingBooking.appointment_time)}</p>
    <br>
    <p><strong>New appointment</strong></p>
    <p><strong>Date:</strong> ${escapeHtml(appointment_date)}</p>
    <p><strong>Time:</strong> ${escapeHtml(appointment_time)}</p>
    <div style="text-align:center;margin-top:18px;">
      <a href="${manageLink}" style="display:inline-block;background:#5e6959;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">
        Manage Booking
      </a>
    </div>
  </div>
</div>`
      });

      if (existingBooking.email) {
        await sendEmail({
          to: existingBooking.email,
          subject: existingBooking.booking_type === "treatment"
            ? "Treatment Appointment Updated – BARE by Marlese"
            : "Consultation & Patch Test Updated – BARE by Marlese",
          html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">
      ${existingBooking.booking_type === "treatment" ? "TREATMENT APPOINTMENT UPDATED" : "CONSULTATION & PATCH TEST UPDATED"}
    </div>
    <p>Hi ${escapeHtml(existingBooking.client_name || "there")},</p>
    ${existingBooking.booking_type === "treatment"
      ? `<p>Your treatment appointment with <strong>BARE by Marlese</strong> has been updated.</p>`
      : `<p>Your consultation and patch test with <strong>BARE by Marlese</strong> has been updated.</p>`
    }
    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p style="margin:0 0 8px;"><strong>New appointment details</strong></p>
      <p><strong>Date:</strong> ${escapeHtml(appointment_date)}</p>
      <p><strong>Time:</strong> ${escapeHtml(appointment_time)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(existingBooking.phone || "Not provided")}</p>
    </div>
    <p>You can manage your booking using the buttons below.</p>
    <div style="text-align:center;margin:22px 0;">
      <a href="${manageLink}" style="display:inline-block;background:#5e6959;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">Manage Booking</a>
      <a href="${cancelLink}" style="display:inline-block;background:#878274;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">Cancel Appointment</a>
    </div>
    <p>If you have any questions, simply reply to this email.</p>
    <p style="margin-top:20px;">Kind regards,<br><strong>Marlese</strong><br>BARE by Marlese</p>
  </div>
</div>`
        });
      }

      return new Response(JSON.stringify({
        success: true,
        rescheduleLink: manageLink,
        emailSent: Boolean(existingBooking.email)
      }), {
        headers: jsonHeaders
      });

    } catch (e) {
  await sendErrorAlert(env, "Reschedule booking error", e.stack || e.message || e);
  return new Response("That slot is already taken", { status: 409 });
}
  }

  if (request.method === "POST" && url.searchParams.get("cancel") === "confirm") {
    const body = await request.json();
    const { id, token } = body;

    if (!id || !token) {
      return new Response("Missing cancellation details", { status: 400 });
    }

    const booking = await env.DB.prepare(
      `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type, reschedule_token
       FROM appointments
       WHERE id = ? AND reschedule_token = ?`
    ).bind(id, token).first();

    if (!booking) {
      return new Response("Booking not found", { status: 404 });
    }

    if (booking.status !== "confirmed") {
      return new Response("This appointment has already been cancelled or can no longer be changed.", { status: 409 });
    }

    const lateCancellation = isLateCancellation(booking.appointment_date, booking.appointment_time);
    const depositTransferable = !lateCancellation;

    await env.DB.prepare(
      `UPDATE appointments
       SET status = 'cancelled'
       WHERE id = ? AND reschedule_token = ? AND status = 'confirmed'`
    ).bind(id, token).run();

    await sendEmail({
      to: env.TO_EMAIL,
      subject: "Booking Cancelled",
      html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">BOOKING CANCELLED</div>
    <p><strong>Client:</strong> ${escapeHtml(booking.client_name || "Client")}</p>
    <p><strong>Email:</strong> ${escapeHtml(booking.email || "Not provided")}</p>
    <p><strong>Phone:</strong> ${escapeHtml(booking.phone || "Not provided")}</p>
    <p><strong>Type:</strong> ${escapeHtml(booking.booking_type || "consultation")}</p>
    <br>
    <p><strong>Cancelled appointment</strong></p>
    <p><strong>Date:</strong> ${escapeHtml(booking.appointment_date)}</p>
    <p><strong>Time:</strong> ${escapeHtml(booking.appointment_time)}</p>
    <br>
    <p><strong>Late cancellation:</strong> ${lateCancellation ? "Yes" : "No"}</p>
    <p><strong>Deposit transferable:</strong> ${depositTransferable ? "Yes" : "No"}</p>
  </div>
</div>`
    });

    if (booking.email) {
      await sendEmail({
        to: booking.email,
        subject: "Appointment Cancelled – BARE by Marlese",
        html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">APPOINTMENT CANCELLED</div>
    <p>Hi ${escapeHtml(booking.client_name || "there")},</p>
    <p>Your appointment with <strong>BARE by Marlese</strong> has been cancelled.</p>
    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p><strong>Date:</strong> ${escapeHtml(booking.appointment_date)}</p>
      <p><strong>Time:</strong> ${escapeHtml(booking.appointment_time)}</p>
    </div>
    <p>A minimum of 24 hours’ notice is required to cancel or reschedule an appointment. Late cancellations or missed appointments may result in the session being deducted from your bundle.</p>
    <p>Treatment bundle sessions are valid for 12 months from the date of purchase. Cancelling or delaying appointments does not extend the validity period.</p>
    <p>If your appointment relates to a treatment package and you wish to rebook, please reply to this email.</p>
    <p style="margin-top:20px;">Kind regards,<br><strong>Marlese</strong><br>BARE by Marlese</p>
  </div>
</div>`
      });
    }

    return new Response(JSON.stringify({
      success: true,
      cancelled: true,
      lateCancellation,
      depositTransferable
    }), {
      headers: jsonHeaders
    });
  }

  if (request.method === "GET" && url.searchParams.get("admin") === "blocked-dates") {
  const blocked = await env.DB.prepare(`
    SELECT id, block_date, reason, created_at
    FROM blocked_dates
    ORDER BY block_date ASC
  `).all();

  return new Response(JSON.stringify(blocked.results), {
    headers: jsonHeaders
  });
}

if (request.method === "POST" && url.searchParams.get("admin") === "block-date") {
  const body = await request.json();
  const blockDate = body.block_date;
  const reason = body.reason || "";

  if (!blockDate) return new Response("Missing date", { status: 400 });

  await env.DB.prepare(`
    INSERT OR REPLACE INTO blocked_dates (block_date, reason)
    VALUES (?, ?)
  `).bind(blockDate, reason).run();

  return new Response(JSON.stringify({ success: true }), {
    headers: jsonHeaders
  });
}

if (request.method === "POST" && url.searchParams.get("admin") === "block-range") {
  const body = await request.json();

  const startDate = body.start_date;
  const endDate = body.end_date;
  const reason = body.reason || "";

  if (!startDate || !endDate) {
    return new Response("Missing dates", { status: 400 });
  }

  if (endDate < startDate) {
    return new Response("End date cannot be before start date", { status: 400 });
  }

  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (current <= end) {

    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, "0");
    const day = String(current.getDate()).padStart(2, "0");

    const dateString = `${year}-${month}-${day}`;

    await env.DB.prepare(`
      INSERT OR REPLACE INTO blocked_dates
      (block_date, reason)
      VALUES (?, ?)
    `).bind(dateString, reason).run();

    current.setDate(current.getDate() + 1);
  }

  return new Response(JSON.stringify({
    success: true
  }), {
    headers: jsonHeaders
  });
}
  
if (request.method === "POST" && url.searchParams.get("admin") === "unblock-date") {
  const body = await request.json();
  const blockDate = body.block_date;

  if (!blockDate) return new Response("Missing date", { status: 400 });

  await env.DB.prepare(`
    DELETE FROM blocked_dates
    WHERE block_date = ?
  `).bind(blockDate).run();

  return new Response(JSON.stringify({ success: true }), {
    headers: jsonHeaders
  });
}
if (request.method === "GET" && url.searchParams.get("session") === "booking") {
  const sessionId = url.searchParams.get("session_id");
  const token = url.searchParams.get("token");

  if (!sessionId || !token) {
    return new Response("Missing session details", { status: 400 });
  }

  const session = await env.DB.prepare(`
    SELECT
      s.id,
      s.appointment_id,
      s.session_number,
      s.appointment_date,
      s.appointment_time,
      s.status,
      s.reschedule_token,
      a.client_name,
      a.email,
      a.phone,
      a.booking_type,
      a.treatment_name,
      a.package_type,
      a.tattoo_size
    FROM treatment_sessions s
    JOIN appointments a ON a.id = s.appointment_id
    WHERE s.id = ?
    AND s.reschedule_token = ?
  `).bind(sessionId, token).first();

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  return new Response(JSON.stringify(session), {
    headers: jsonHeaders
  });
}
if (request.method === "POST" && url.searchParams.get("session") === "book") {
  const body = await request.json();
  const { session_id, token, appointment_date, appointment_time } = body;

  if (!session_id || !token || !appointment_date || !appointment_time) {
    return new Response("Missing session booking details", { status: 400 });
  }

  const session = await env.DB.prepare(`
    SELECT
      s.id,
      s.appointment_id,
      s.session_number,
      s.status,
      s.reschedule_token,
      a.client_name,
      a.email,
      a.phone,
      a.treatment_name,
      a.package_type,
      a.tattoo_size
    FROM treatment_sessions s
    JOIN appointments a ON a.id = s.appointment_id
    WHERE s.id = ?
    AND s.reschedule_token = ?
  `).bind(session_id, token).first();

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  if (session.status !== "pending") {
    return new Response("This session is not available to book", { status: 409 });
  }

  const blockedDate = await env.DB.prepare(`
    SELECT block_date
    FROM blocked_dates
    WHERE block_date = ?
  `).bind(appointment_date).first();

  if (blockedDate) {
    return new Response("This date is unavailable", { status: 409 });
  }

  const validSlots = getSlotsByType("treatment", appointment_date);

  if (!validSlots.includes(appointment_time)) {
    return new Response("Invalid appointment time", { status: 400 });
  }

  if (isPastSlot(appointment_date, appointment_time)) {
    return new Response("This appointment time has already passed", { status: 400 });
  }

  const clash = await env.DB.prepare(`
    SELECT appointment_time
    FROM appointments
    WHERE appointment_date = ?
    AND appointment_time = ?
    AND booking_type = 'treatment'
    AND status = 'confirmed'

    UNION

    SELECT appointment_time
    FROM treatment_sessions
    WHERE appointment_date = ?
    AND appointment_time = ?
    AND status = 'booked'
  `).bind(
    appointment_date,
    appointment_time,
    appointment_date,
    appointment_time
  ).first();

  if (clash) {
    return new Response("That slot is already taken", { status: 409 });
  }

  await env.DB.prepare(`
  UPDATE treatment_sessions
  SET appointment_date = ?,
      appointment_time = ?,
      status = 'booked',
      reminder_sent = 'no',
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
  AND reschedule_token = ?
  AND status = 'pending'
`).bind(
  appointment_date,
  appointment_time,
  session_id,
  token
).run();
  
const sessionManageLink = `https://barebymarlese.com/reschedule.html?session_id=${session.id}&token=${session.reschedule_token}`;
const sessionCancelLink = `https://barebymarlese.com/cancel.html?session_id=${session.id}&token=${session.reschedule_token}`;

await sendEmail({
  to: env.TO_EMAIL,
  subject: `Treatment Session ${session.session_number} Booked`,
  html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <p><strong>Client:</strong> ${escapeHtml(session.client_name || "Client")}</p>
    <p><strong>Session:</strong> ${escapeHtml(session.session_number)}</p>
    <p><strong>Treatment:</strong> ${escapeHtml(session.treatment_name || "Treatment")}</p>
    <p><strong>Date:</strong> ${escapeHtml(appointment_date)}</p>
    <p><strong>Time:</strong> ${escapeHtml(appointment_time)}</p>
  </div>
</div>`
});

if (session.email) {
  await sendEmail({
    to: session.email,
    subject: `Treatment Session ${session.session_number} Confirmed – BARE by Marlese`,
    html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <p>Hi ${escapeHtml(session.client_name || "there")},</p>
    <p>Your treatment session ${escapeHtml(session.session_number)} has been booked.</p>
    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p><strong>Date:</strong> ${escapeHtml(appointment_date)}</p>
      <p><strong>Time:</strong> ${escapeHtml(appointment_time)}</p>
    </div>
    <div style="text-align:center;margin:22px 0;">
      <a href="${sessionManageLink}" style="display:inline-block;background:#5e6959;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">Manage Session</a>
      <a href="${sessionCancelLink}" style="display:inline-block;background:#878274;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">Cancel Session</a>
    </div>
    <p>Kind regards,<br><strong>Marlese</strong><br>BARE by Marlese</p>
  </div>
</div>`
  });
}
  return new Response(JSON.stringify({
    success: true,
    session_id,
    appointment_id: session.appointment_id,
    session_number: session.session_number,
    appointment_date,
    appointment_time
  }), {
    headers: jsonHeaders
  });
}
  
  if (request.method === "POST" && url.searchParams.get("session") === "reschedule") {
  const body = await request.json();
  const { session_id, token, appointment_date, appointment_time } = body;

  if (!session_id || !token || !appointment_date || !appointment_time) {
    return new Response("Missing session reschedule details", { status: 400 });
  }

  const session = await env.DB.prepare(`
    SELECT
      s.id,
      s.appointment_id,
      s.session_number,
      s.status,
      s.reschedule_token,
      s.appointment_date AS old_date,
      s.appointment_time AS old_time,
      a.client_name,
      a.email,
      a.phone,
      a.treatment_name
    FROM treatment_sessions s
    JOIN appointments a ON a.id = s.appointment_id
    WHERE s.id = ?
    AND s.reschedule_token = ?
  `).bind(session_id, token).first();

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  if (session.status !== "booked") {
    return new Response("Only booked sessions can be rescheduled", { status: 409 });
  }

  const blockedDate = await env.DB.prepare(`
    SELECT block_date
    FROM blocked_dates
    WHERE block_date = ?
  `).bind(appointment_date).first();

  if (blockedDate) {
    return new Response("This date is unavailable", { status: 409 });
  }

  const validSlots = getSlotsByType("treatment", appointment_date);

  if (!validSlots.includes(appointment_time)) {
    return new Response("Invalid appointment time", { status: 400 });
  }

  if (isPastSlot(appointment_date, appointment_time)) {
    return new Response("This appointment time has already passed", { status: 400 });
  }

  const clash = await env.DB.prepare(`
    SELECT appointment_time
    FROM appointments
    WHERE appointment_date = ?
    AND appointment_time = ?
    AND booking_type = 'treatment'
    AND status = 'confirmed'

    UNION

    SELECT appointment_time
    FROM treatment_sessions
    WHERE appointment_date = ?
    AND appointment_time = ?
    AND status = 'booked'
    AND id != ?
  `).bind(
    appointment_date,
    appointment_time,
    appointment_date,
    appointment_time,
    session_id
  ).first();

  if (clash) {
    return new Response("That slot is already taken", { status: 409 });
  }

  await env.DB.prepare(`
  UPDATE treatment_sessions
  SET appointment_date = ?,
      appointment_time = ?,
      reminder_sent = 'no',
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
  AND reschedule_token = ?
  AND status = 'booked'
`).bind(
  appointment_date,
  appointment_time,
  session_id,
  token
).run();

  const sessionManageLink = `https://barebymarlese.com/reschedule.html?session_id=${session.id}&token=${session.reschedule_token}`;
const sessionCancelLink = `https://barebymarlese.com/cancel.html?session_id=${session.id}&token=${session.reschedule_token}`;

await sendEmail({
  to: env.TO_EMAIL,
  subject: `Treatment Session ${session.session_number} Rescheduled`,
  html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>

    <h2>Treatment Session Rescheduled</h2>

    <p><strong>Client:</strong> ${escapeHtml(session.client_name || "Client")}</p>
    <p><strong>Session:</strong> ${session.session_number}</p>
    <p><strong>Treatment:</strong> ${escapeHtml(session.treatment_name || "Treatment")}</p>

    <hr>

    <p><strong>Previous Date:</strong> ${escapeHtml(session.old_date)}</p>
    <p><strong>Previous Time:</strong> ${escapeHtml(session.old_time)}</p>

    <br>

    <p><strong>New Date:</strong> ${escapeHtml(appointment_date)}</p>
    <p><strong>New Time:</strong> ${escapeHtml(appointment_time)}</p>

  </div>
</div>
`
});

if (session.email) {

  await sendEmail({
    to: session.email,
    subject: `Treatment Session ${session.session_number} Updated – BARE by Marlese`,
    html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">

    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>

    <h2>Treatment Session Updated</h2>

    <p>Hi ${escapeHtml(session.client_name || "there")},</p>

    <p>Your treatment session has been successfully rescheduled.</p>

    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">

      <p><strong>Previous Date:</strong> ${escapeHtml(session.old_date)}</p>
      <p><strong>Previous Time:</strong> ${escapeHtml(session.old_time)}</p>

      <hr>

      <p><strong>New Date:</strong> ${escapeHtml(appointment_date)}</p>
      <p><strong>New Time:</strong> ${escapeHtml(appointment_time)}</p>

    </div>

    <div style="text-align:center;margin:22px 0;">

      <a href="${sessionManageLink}"
         style="display:inline-block;background:#5e6959;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">
        Manage Session
      </a>

      <a href="${sessionCancelLink}"
         style="display:inline-block;background:#878274;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">
        Cancel Session
      </a>

    </div>

    <p>If you have any questions, simply reply to this email.</p>

    <p style="margin-top:20px;">
      Kind regards,<br>
      <strong>Marlese</strong><br>
      BARE by Marlese
    </p>

  </div>
</div>
`
  });

}

  return new Response(JSON.stringify({
    success: true,
    session_id,
    appointment_id: session.appointment_id,
    session_number: session.session_number,
    previous_date: session.old_date,
    previous_time: session.old_time,
    appointment_date,
    appointment_time
  }), {
    headers: jsonHeaders
  });
}
  if (request.method === "POST" && url.searchParams.get("session") === "cancel") {
  const body = await request.json();
  const { session_id, token } = body;

  if (!session_id || !token) {
    return new Response("Missing session cancellation details", { status: 400 });
  }

  const session = await env.DB.prepare(`
    SELECT
      s.id,
      s.appointment_id,
      s.session_number,
      s.appointment_date,
      s.appointment_time,
      s.status,
      s.reschedule_token,
      a.client_name,
      a.email,
      a.phone,
      a.treatment_name
    FROM treatment_sessions s
    JOIN appointments a ON a.id = s.appointment_id
    WHERE s.id = ?
    AND s.reschedule_token = ?
  `).bind(session_id, token).first();

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  if (session.status !== "booked") {
    return new Response("Only booked sessions can be cancelled", { status: 409 });
  }

  const lateCancellation = isLateCancellation(session.appointment_date, session.appointment_time);

  await env.DB.prepare(`
  UPDATE treatment_sessions
  SET status = 'pending',
    last_cancelled_date = appointment_date,
    last_cancelled_time = appointment_time,
    cancelled_at = CURRENT_TIMESTAMP,
    cancelled_count = COALESCE(cancelled_count, 0) + 1,
    appointment_date = NULL,
    appointment_time = NULL,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
  AND reschedule_token = ?
  AND status = 'booked'
`).bind(session_id, token).run();

  await sendEmail({
  to: env.TO_EMAIL,
  subject: `Treatment Session ${session.session_number} Cancelled`,
  html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>

    <h2>Treatment Session Cancelled</h2>

    <p><strong>Client:</strong> ${escapeHtml(session.client_name || "Client")}</p>
    <p><strong>Session:</strong> ${session.session_number}</p>
    <p><strong>Treatment:</strong> ${escapeHtml(session.treatment_name || "Treatment")}</p>
    <p><strong>Date:</strong> ${escapeHtml(session.appointment_date)}</p>
    <p><strong>Time:</strong> ${escapeHtml(session.appointment_time)}</p>
    <p><strong>Late cancellation:</strong> ${lateCancellation ? "Yes" : "No"}</p>
  </div>
</div>
`
});

if (session.email) {
  await sendEmail({
    to: session.email,
    subject: `Treatment Session ${session.session_number} Cancelled – BARE by Marlese`,
    html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>

    <h2>Treatment Session Cancelled</h2>

    <p>Hi ${escapeHtml(session.client_name || "there")},</p>

    <p>Your treatment session has been cancelled.</p>

    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p><strong>Date:</strong> ${escapeHtml(session.appointment_date)}</p>
      <p><strong>Time:</strong> ${escapeHtml(session.appointment_time)}</p>
      <p><strong>Late cancellation:</strong> ${lateCancellation ? "Yes" : "No"}</p>
    </div>

    <p>A minimum of 24 hours’ notice is required to cancel or reschedule an appointment. Late cancellations or missed appointments may result in the session being deducted from your bundle.</p>

    <p>Your session is now available to rebook. Please reply to this email and I will arrange a new date and time for you.</p>

    <p style="margin-top:20px;">
      Kind regards,<br>
      <strong>Marlese</strong><br>
      BARE by Marlese
    </p>
  </div>
</div>
`
  });
}

  return new Response(JSON.stringify({
    success: true,
    cancelled: true,
    session_id,
    appointment_id: session.appointment_id,
    session_number: session.session_number,
    appointment_date: session.appointment_date,
    appointment_time: session.appointment_time,
    lateCancellation
  }), {
    headers: jsonHeaders
  });
}
  if (request.method === "POST" && url.searchParams.get("session") === "complete") {
  const body = await request.json();
  const { session_id } = body;

  if (!session_id) {
    return new Response("Missing session ID", { status: 400 });
  }

  const session = await env.DB.prepare(`
    SELECT
      s.id,
      s.appointment_id,
      s.session_number,
      s.status,
      a.sessions_total
    FROM treatment_sessions s
    JOIN appointments a ON a.id = s.appointment_id
    WHERE s.id = ?
  `).bind(session_id).first();

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  if (session.status !== "booked") {
    return new Response("Only booked sessions can be marked completed", { status: 409 });
  }

  await env.DB.prepare(`
    UPDATE treatment_sessions
    SET status = 'completed',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(session_id).run();

  const completed = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM treatment_sessions
    WHERE appointment_id = ?
    AND status = 'completed'
  `).bind(session.appointment_id).first();

  const completedCount = Number(completed.count || 0);
  const total = Number(session.sessions_total || 0);

  await env.DB.prepare(`
    UPDATE appointments
    SET sessions_used = ?,
        package_status = CASE
          WHEN ? > 0 AND ? >= ? THEN 'completed'
          ELSE 'active'
        END
    WHERE id = ?
  `).bind(
    completedCount,
    total,
    completedCount,
    total,
    session.appointment_id
  ).run();

  return new Response(JSON.stringify({
    success: true,
    session_id,
    appointment_id: session.appointment_id,
    sessions_used: completedCount,
    package_status: total > 0 && completedCount >= total ? "completed" : "active"
  }), {
    headers: jsonHeaders
  });
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

const blockedDate = await env.DB.prepare(`
  SELECT block_date, reason
  FROM blocked_dates
  WHERE block_date = ?
`).bind(date).first();

if (blockedDate) {
  return new Response(JSON.stringify({
    slots: [],
    nextAvailable: null,
    blocked: true,
    reason: blockedDate.reason || ""
  }), { headers: jsonHeaders });
}

const allSlots = getSlotsByType(bookingType, date);

    let bookedTimes = [];

if (bookingType === "treatment") {
  const booked = await env.DB.prepare(`
    SELECT appointment_time
    FROM appointments
    WHERE appointment_date = ?
    AND booking_type = 'treatment'
    AND status = 'confirmed'

    UNION

    SELECT appointment_time
    FROM treatment_sessions
    WHERE appointment_date = ?
    AND status = 'booked'
  `).bind(date, date).all();

  bookedTimes = booked.results.map(row => row.appointment_time);
} else {
  const booked = await env.DB.prepare(`
    SELECT appointment_time
    FROM appointments
    WHERE appointment_date = ?
    AND booking_type = ?
    AND status = 'confirmed'
  `).bind(date, bookingType).all();

  bookedTimes = booked.results.map(row => row.appointment_time);
}

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
    const tattooSize = body.tattoo_size || null;
    const treatmentCategory = body.treatment_category || null;
    const treatmentName = body.treatment_name || null;
    const amountPaid = Number(body.amount_paid || 0);
    const paymentReference = body.payment_reference || null;

    let paymentStatus = "unpaid";
    let paymentType = null;
    let sessionsTotal = 0;
    let sessionsUsed = 0;
    let packageStatus = "none";

    if (bookingType === "consultation") {
      if (amountPaid >= 30) {
        paymentStatus = "deposit_paid";
        paymentType = "consultation_deposit";
      }
    }

if (bookingType === "treatment") {
  paymentType = "treatment_payment";

  if (packageType === "single_session") {
  sessionsTotal = 1;
  packageStatus = "active";
}

if (packageType === "three_sessions" || packageType === "3_sessions") {
  sessionsTotal = 3;
  packageStatus = "active";
}

if (packageType === "4_sessions") {
  sessionsTotal = 4;
  packageStatus = "active";
}

if (packageType === "six_sessions" || packageType === "6_sessions") {
  sessionsTotal = 6;
  packageStatus = "active";
}

  paymentStatus = amountPaid > 0 ? "paid" : "unpaid";
}

    const packageDisplay = packageType
  ? packageType.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase())
  : null;

const displayAmount = amountPaid > 1000
  ? (amountPaid / 100).toFixed(2)
  : Number(amountPaid).toFixed(2);

const priceDisplay = amountPaid ? `£${displayAmount}` : null;

    if (!appointmentDate || !appointmentTime) {
      return new Response("Missing appointment date or time", { status: 400 });
    }

    const blockedDate = await env.DB.prepare(`
  SELECT block_date, reason
  FROM blocked_dates
  WHERE block_date = ?
`).bind(appointmentDate).first();

if (blockedDate) {
  return new Response("This date is unavailable", { status: 409 });
}

    const validSlots = getSlotsByType(bookingType, appointmentDate);

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
  (
    client_name,
    email,
    phone,
    appointment_date,
    appointment_time,
    status,
    reschedule_token,
    booking_type,
    package_type,
    tattoo_size,
    amount_paid,
    payment_status,
    payment_type,
    sessions_total,
    sessions_used,
    package_status,
    payment_reference,
    treatment_category,
    treatment_name
  )
  VALUES (
  ?, ?, ?, ?, ?,
  'confirmed',
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?
)`
)
.bind(
  clientName,
  email,
  phone,
  appointmentDate,
  appointmentTime,
  rescheduleToken,
  bookingType,
  packageType,
  tattooSize,
  amountPaid,
  paymentStatus,
  paymentType,
  sessionsTotal,
  sessionsUsed,
  packageStatus,
  paymentReference,
  treatmentCategory,
  treatmentName
)
.run();

      const bookingId = insertResult.meta.last_row_id;

let firstSessionId = null;
let firstSessionToken = null;

if (bookingType === "treatment" && sessionsTotal > 1) {
  for (let i = 1; i <= sessionsTotal; i++) {
    const sessionToken = crypto.randomUUID();

    const sessionInsert = await env.DB.prepare(`
      INSERT INTO treatment_sessions
      (
        appointment_id,
        session_number,
        appointment_date,
        appointment_time,
        status,
        reschedule_token
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      bookingId,
      i,
      i === 1 ? appointmentDate : null,
      i === 1 ? appointmentTime : null,
      i === 1 ? "booked" : "pending",
      sessionToken
    ).run();

    if (i === 1) {
      firstSessionId = sessionInsert.meta.last_row_id;
      firstSessionToken = sessionToken;
    }
  }
}
      const rescheduleLink = firstSessionId && firstSessionToken
  ? `https://barebymarlese.com/reschedule.html?session_id=${firstSessionId}&token=${firstSessionToken}`
  : `https://barebymarlese.com/reschedule.html?id=${bookingId}&token=${rescheduleToken}`;

      const cancelLink = firstSessionId && firstSessionToken
  ? `https://barebymarlese.com/cancel.html?session_id=${firstSessionId}&token=${firstSessionToken}`
  : `https://barebymarlese.com/cancel.html?id=${bookingId}&token=${rescheduleToken}`;

      const safeName = escapeHtml(clientName);
      const safeEmail = escapeHtml(email || "Not provided");
      const safePhone = escapeHtml(phone || "Not provided");
      const safeDate = escapeHtml(appointmentDate);
      const safeTime = escapeHtml(appointmentTime);
      const safePaymentStatus = escapeHtml(paymentStatus.replaceAll("_", " "));
      const safePackageStatus = escapeHtml(packageStatus);
      const safeSessions = `${sessionsUsed}/${sessionsTotal}`;

      await sendEmail({
        to: env.TO_EMAIL,
        subject: bookingType === "treatment"
          ? "New BARE by Marlese treatment booking"
          : "New BARE by Marlese consultation booking",
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
      <p style="margin:0 0 8px;"><strong>Appointment summary</strong></p>
      <p><strong>Name:</strong> ${safeName}</p>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Phone:</strong> ${safePhone}</p>
      <p><strong>Date:</strong> ${safeDate}</p>
      <p><strong>Time:</strong> ${safeTime}</p>
      <p><strong>Type:</strong> ${escapeHtml(bookingType)}</p>
      ${treatmentName
  ? `<p><strong>Treatment:</strong> ${escapeHtml(treatmentName)}</p>`
  : packageDisplay
    ? `<p><strong>Package:</strong> ${escapeHtml(packageDisplay)} Tattoo Removal</p>`
    : ""
}
      ${priceDisplay ? `<p><strong>Amount Paid:</strong> ${escapeHtml(priceDisplay)}</p>` : ""}
      <p><strong>Payment Status:</strong> ${safePaymentStatus}</p>
      ${bookingType === "treatment" ? `<p><strong>Package Status:</strong> ${safePackageStatus}</p><p><strong>Sessions Used:</strong> ${safeSessions}</p>` : ""}
    </div>
    <p>This appointment has been saved in your Cloudflare D1 booking database.</p>
  </div>
</div>`
      });

      if (email) {
        await sendEmail({
          to: email,
          subject: bookingType === "treatment"
            ? "Treatment Booking Confirmed – BARE by Marlese"
            : "Consultation & Patch Test Confirmed – BARE by Marlese",
          html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">
      ${bookingType === "treatment" ? "TREATMENT BOOKING CONFIRMED" : "CONSULTATION & PATCH TEST CONFIRMED"}
    </div>
    <p>Hi ${safeName},</p>
    ${bookingType === "treatment"
      ? `<p>Thank you for booking with <strong>BARE by Marlese</strong>. Your treatment appointment has been confirmed.</p>`
      : `<p>Thank you for completing your consultation form and booking your consultation & patch test with <strong>BARE by Marlese</strong>.</p>
         <p>Your consultation and patch test is confirmed for <strong>${safeDate}</strong> at <strong>${safeTime}</strong>.</p>
         <p>Your details have been received and will be reviewed thoroughly before your appointment.</p>`
    }
    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p style="margin:0 0 8px;"><strong>Appointment summary</strong></p>
      ${treatmentName
  ? `<p><strong>Treatment:</strong> ${escapeHtml(treatmentName)}</p>`
  : packageDisplay
    ? `<p><strong>Package:</strong> ${escapeHtml(packageDisplay)} Tattoo Removal</p>`
    : ""
}
      ${priceDisplay ? `<p><strong>Amount Paid:</strong> ${escapeHtml(priceDisplay)}</p>` : ""}
      ${bookingType === "treatment" ? `<p><strong>Sessions:</strong> ${safeSessions}</p>` : ""}
      <p><strong>Date:</strong> ${safeDate}</p>
      <p><strong>Time:</strong> ${safeTime}</p>
      <p><strong>Phone:</strong> ${safePhone}</p>
    </div>
    ${bookingType === "treatment"
      ? `<p>Your first treatment session has been booked. If you purchased a treatment package, your remaining sessions can be arranged after your first appointment.</p>`
      : `<p>Your £30 deposit will be deducted from your treatment cost.</p>`
    }
    <p>If you need to reschedule or cancel, please use one of the links below. At least 24 hours' notice is required for your deposit to remain transferable.</p>
    <div style="text-align:center;margin:22px 0;">
      <a href="${rescheduleLink}" style="display:inline-block;background:#5e6959;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">Manage Booking</a>
      <a href="${cancelLink}" style="display:inline-block;background:#878274;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;margin:4px;">Cancel Appointment</a>
    </div>
    <p>If you have any questions, simply reply to this email.</p>
    <p style="margin-top:20px;">Kind regards,<br><strong>Marlese</strong><br>BARE by Marlese</p>
  </div>
</div>`
        });
      }

      return new Response(JSON.stringify({
        success: true,
        bookingId,
        rescheduleLink,
        cancelLink,
        emailSent: Boolean(email),
        payment_status: paymentStatus,
        payment_type: paymentType,
        package_status: packageStatus,
        sessions_total: sessionsTotal,
        sessions_used: sessionsUsed
      }), {
        status: 200,
        headers: jsonHeaders
      });

    } catch (e) {
      await sendErrorAlert(env, "New booking error", e.stack || e.message || e);
      return new Response("Slot already taken", { status: 409 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
}
async function sendErrorAlert(env, title, details) {
  try {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.TO_EMAIL) return;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: env.TO_EMAIL,
        subject: `BARE System Alert: ${title}`,
        html: `
          <p><strong>${title}</strong></p>
          <pre style="white-space:pre-wrap;">${String(details)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")}</pre>
        `
      })
    });
  } catch (e) {
    // fail silently to avoid alert loops
  }
}
