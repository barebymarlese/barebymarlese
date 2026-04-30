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
        reschedule_token,
        whatsapp_reminder_sent,
        aftercare_sent
      FROM appointments
      ORDER BY appointment_date ASC, appointment_time ASC
    `).all();

    return new Response(JSON.stringify(bookings.results), {
      headers: jsonHeaders
    });
  }

  if (request.method === "POST" && url.searchParams.get("admin") === "cancel") {
  const body = await request.json();
  const id = body.id;

  if (!id) return new Response("Missing booking ID", { status: 400 });

  const booking = await env.DB.prepare(
    `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type, reschedule_token
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
      `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type
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

  if (request.method === "GET" && url.searchParams.get("cancel") === "booking") {
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");

    if (!id || !token) {
      return new Response("Missing booking details", { status: 400 });
    }

    const booking = await env.DB.prepare(
      `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type
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
         SET appointment_date = ?, appointment_time = ?
         WHERE id = ? AND reschedule_token = ?`
      ).bind(appointment_date, appointment_time, id, token).run();

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
    const tattooSize = body.tattoo_size || null;
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

  if (packageType === "three_sessions") {
    sessionsTotal = 3;
    packageStatus = "active";
  }

  if (packageType === "six_sessions") {
    sessionsTotal = 6;
    packageStatus = "active";
  }

  paymentStatus = amountPaid > 0 ? "paid" : "unpaid";
}

    const packageDisplay = packageType
      ? packageType.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase())
      : null;

    const priceDisplay = amountPaid ? `£${amountPaid}` : null;

    if (!appointmentDate || !appointmentTime) {
      return new Response("Missing appointment date or time", { status: 400 });
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
          payment_reference
        )
        VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        paymentReference
      )
      .run();

      const bookingId = insertResult.meta.last_row_id;
      const rescheduleLink = `https://barebymarlese.com/reschedule.html?id=${bookingId}&token=${rescheduleToken}`;
      const cancelLink = `https://barebymarlese.com/cancel.html?id=${bookingId}&token=${rescheduleToken}`;

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
      ${packageDisplay ? `<p><strong>Package:</strong> ${escapeHtml(packageDisplay)} Tattoo Removal</p>` : ""}
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
      ${packageDisplay ? `<p><strong>Package:</strong> ${escapeHtml(packageDisplay)} Tattoo Removal</p>` : ""}
      ${priceDisplay ? `<p><strong>Amount Paid:</strong> ${escapeHtml(priceDisplay)}</p>` : ""}
      ${bookingType === "treatment" ? `<p><strong>Sessions:</strong> ${safeSessions}</p>` : ""}
      <p><strong>Date:</strong> ${safeDate}</p>
      <p><strong>Time:</strong> ${safeTime}</p>
      <p><strong>Phone:</strong> ${safePhone}</p>
    </div>
    ${bookingType === "treatment"
      ? `<p>Your treatment booking has been saved against your package record.</p>`
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
