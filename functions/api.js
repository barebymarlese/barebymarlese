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

  function timeToMinutes(time = "") {
    const [hour, minute] = String(time).split(":").map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return (hour * 60) + minute;
  }

  function bookingDurationMinutes(bookingType = "consultation") {
    return bookingType === "treatment" ? 60 : 30;
  }

  function appointmentTimesOverlap(
    firstTime,
    firstType,
    secondTime,
    secondType
  ) {
    const firstStart = timeToMinutes(firstTime);
    const secondStart = timeToMinutes(secondTime);

    if (firstStart === null || secondStart === null) return false;

    const firstEnd =
      firstStart + bookingDurationMinutes(firstType);
    const secondEnd =
      secondStart + bookingDurationMinutes(secondType);

    return firstStart < secondEnd && secondStart < firstEnd;
  }

  async function getOccupiedClinicTimes(
    date,
    env,
    excludeAppointmentId = null
  ) {
    const appointmentQuery = excludeAppointmentId
      ? `
        SELECT id, appointment_time, booking_type
        FROM appointments
        WHERE appointment_date = ?
          AND status IN ('confirmed', 'completed')
          AND id != ?
      `
      : `
        SELECT id, appointment_time, booking_type
        FROM appointments
        WHERE appointment_date = ?
          AND status IN ('confirmed', 'completed')
      `;

    const appointments = excludeAppointmentId
      ? await env.DB.prepare(appointmentQuery)
          .bind(date, excludeAppointmentId)
          .all()
      : await env.DB.prepare(appointmentQuery)
          .bind(date)
          .all();

    const sessionQuery = excludeAppointmentId
      ? `
        SELECT id, appointment_id, appointment_time
        FROM treatment_sessions
        WHERE appointment_date = ?
          AND status = 'booked'
          AND appointment_id != ?
      `
      : `
        SELECT id, appointment_id, appointment_time
        FROM treatment_sessions
        WHERE appointment_date = ?
          AND status = 'booked'
      `;

    const sessions = excludeAppointmentId
      ? await env.DB.prepare(sessionQuery)
          .bind(date, excludeAppointmentId)
          .all()
      : await env.DB.prepare(sessionQuery)
          .bind(date)
          .all();

    const occupied = [];

    for (const appointment of appointments.results || []) {
      // Treatment appointments that already have a treatment_sessions row
      // are represented by that row below, so do not count them twice.
      if (
        appointment.booking_type === "treatment" &&
        (sessions.results || []).some(
          session =>
            Number(session.appointment_id) === Number(appointment.id)
        )
      ) {
        continue;
      }

      occupied.push({
        time: appointment.appointment_time,
        type:
          appointment.booking_type === "treatment"
            ? "treatment"
            : "consultation"
      });
    }

    for (const session of sessions.results || []) {
      occupied.push({
        time: session.appointment_time,
        type: "treatment"
      });
    }

    return occupied;
  }

  async function isClinicSlotOccupied(
    date,
    time,
    bookingType,
    env,
    excludeAppointmentId = null
  ) {
    const occupied = await getOccupiedClinicTimes(
      date,
      env,
      excludeAppointmentId
    );

    return occupied.some(item =>
      appointmentTimesOverlap(
        time,
        bookingType,
        item.time,
        item.type
      )
    );
  }

  async function getStripeDiscountDetails(stripe = {}, env) {
  const discountAmount =
    Number(stripe.total_details?.amount_discount || 0) / 100;

  const promotionCodeValues = [
    stripe.discounts?.[0]?.promotion_code,
    stripe.discounts?.[0]?.source?.promotion_code,
    stripe.total_details?.breakdown?.discounts?.[0]
      ?.discount?.promotion_code
  ];

  // First look for an already-expanded promotion-code object.
  for (const value of promotionCodeValues) {
    if (
      value &&
      typeof value === "object" &&
      String(value.code || "").trim()
    ) {
      return {
        discountAmount,
        couponCode: String(value.code).trim()
      };
    }
  }

  // If Stripe returned only promo_xxx, retrieve the readable code.
  const promotionCodeId = promotionCodeValues
    .map(value =>
      typeof value === "string"
        ? value.trim()
        : String(value?.id || "").trim()
    )
    .find(value => value.startsWith("promo_"));

  if (promotionCodeId && env.STRIPE_SECRET_KEY) {
    const response = await fetch(
      `https://api.stripe.com/v1/promotion_codes/${encodeURIComponent(
        promotionCodeId
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`
        }
      }
    );

    if (response.ok) {
      const promotionCode = await response.json();

      const readableCode = String(
        promotionCode.code || ""
      ).trim();

      if (readableCode) {
        return {
          discountAmount,
          couponCode: readableCode
        };
      }
    } else {
      console.error(
        "Stripe promotion code lookup failed",
        promotionCodeId,
        response.status,
        await response.text()
      );
    }
  }

  // Final fallback for discounts created directly from a coupon.
  const couponNameCandidates = [
    stripe.discounts?.[0]?.coupon?.name,
    stripe.total_details?.breakdown?.discounts?.[0]
      ?.discount?.coupon?.name
  ];

  const couponCode =
    couponNameCandidates
      .map(value => String(value || "").trim())
      .find(Boolean) || null;

  return {
    discountAmount,
    couponCode
  };
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
  async function getStripeCheckout(sessionId, env) {
    if (!sessionId || !env.STRIPE_SECRET_KEY) {
      return null;
    }

    const stripeUrl = new URL(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`
    );

    stripeUrl.searchParams.append(
  "expand[]",
  "discounts"
);

    const response = await fetch(stripeUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Stripe Checkout lookup failed (${response.status}): ${errorText}`
      );
    }

    return await response.json();
  }

async function createStripeConsultationCheckout(category, env) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  const normalisedCategory = String(category || "").toLowerCase();

  const consultationPriceLookup = {
    carbon: env.STRIPE_PRICE_CONSULTATION_CARBON,
    fungal: env.STRIPE_PRICE_CONSULTATION_FUNGAL
  };

  const stripePriceId =
    consultationPriceLookup[normalisedCategory] || "";

  if (!stripePriceId.startsWith("price_")) {
    throw new Error(
      `Stripe consultation Price ID is not configured for ${normalisedCategory}.`
    );
  }

  const form = new URLSearchParams();

  form.set("mode", "payment");

  form.set(
    "success_url",
    "https://barebymarlese.com/booking.html?paid=true&session_id={CHECKOUT_SESSION_ID}"
  );

  form.set(
    "cancel_url",
    `https://barebymarlese.com/deposit.html?treatment=${encodeURIComponent(normalisedCategory)}`
  );

  form.set("allow_promotion_codes", "true");

  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price]", stripePriceId);

  form.set("metadata[payment_purpose]", "consultation_deposit");
  form.set("metadata[treatment_category]", normalisedCategory);

  form.set(
    "payment_intent_data[metadata][payment_purpose]",
    "consultation_deposit"
  );

  form.set(
    "payment_intent_data[metadata][treatment_category]",
    normalisedCategory
  );

  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Stripe consultation Checkout Session could not be created."
    );
  }

  if (!data.id || !data.url) {
    throw new Error(
      "Stripe did not return a consultation Checkout URL."
    );
  }

  return data;
}
  
async function createStripeBalanceCheckout(booking, env) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  const remainingBalance = Number(booking.remaining_balance || 0);
  const balancePence = Math.round(remainingBalance * 100);

  if (!Number.isInteger(balancePence) || balancePence <= 0) {
    throw new Error("This booking has no valid remaining balance.");
  }

  const form = new URLSearchParams();

  form.set("mode", "payment");

  form.set(
    "success_url",
    "https://barebymarlese.com/payment-complete.html" +
    "?session_id={CHECKOUT_SESSION_ID}"
  );

  form.set(
    "cancel_url",
    "https://barebymarlese.com/payment-cancelled.html"
  );

  form.set("client_reference_id", String(booking.id));
  form.set("metadata[appointment_id]", String(booking.id));
  form.set("metadata[payment_purpose]", "treatment_balance");

  form.set(
    "payment_intent_data[metadata][appointment_id]",
    String(booking.id)
  );

  form.set(
    "payment_intent_data[metadata][payment_purpose]",
    "treatment_balance"
  );

  form.set("allow_promotion_codes", "true");

  if (booking.email) {
    form.set("customer_email", booking.email);
  }

  const category = String(
    booking.treatment_category || ""
  ).toLowerCase();

  const packageType = String(
    booking.package_type || ""
  ).toLowerCase();

  const tattooSize = String(
    booking.tattoo_size || ""
  ).toLowerCase();

  const stripePriceLookup = {
    tattoo: {
      single_session: {
        tiny: env.STRIPE_PRICE_TATTOO_TINY_SINGLE_CC,
        small: env.STRIPE_PRICE_TATTOO_SMALL_SINGLE_CC,
        medium: env.STRIPE_PRICE_TATTOO_MEDIUM_SINGLE_CC,
        large: env.STRIPE_PRICE_TATTOO_LARGE_SINGLE_CC,
        xl: env.STRIPE_PRICE_TATTOO_XL_SINGLE_CC
      },

      six_sessions: {
        tiny: env.STRIPE_PRICE_TATTOO_TINY_BUNDLE_CC,
        small: env.STRIPE_PRICE_TATTOO_SMALL_BUNDLE_CC,
        medium: env.STRIPE_PRICE_TATTOO_MEDIUM_BUNDLE_CC,
        large: env.STRIPE_PRICE_TATTOO_LARGE_BUNDLE_CC,
        xl: env.STRIPE_PRICE_TATTOO_XL_BUNDLE_CC
      },

      "6_sessions": {
        tiny: env.STRIPE_PRICE_TATTOO_TINY_BUNDLE_CC,
        small: env.STRIPE_PRICE_TATTOO_SMALL_BUNDLE_CC,
        medium: env.STRIPE_PRICE_TATTOO_MEDIUM_BUNDLE_CC,
        large: env.STRIPE_PRICE_TATTOO_LARGE_BUNDLE_CC,
        xl: env.STRIPE_PRICE_TATTOO_XL_BUNDLE_CC
      }
    },

    carbon: {
      single_session: env.STRIPE_PRICE_CARBON_SINGLE_BALANCE,
      three_sessions: env.STRIPE_PRICE_CARBON_COURSE3_BALANCE,
      "3_sessions": env.STRIPE_PRICE_CARBON_COURSE3_BALANCE
    },

    fungal: {
      single_nail: env.STRIPE_PRICE_FUNGAL_SINGLE_NAIL_BALANCE,
      one_foot: env.STRIPE_PRICE_FUNGAL_ONE_FOOT_BALANCE,
      both_feet: env.STRIPE_PRICE_FUNGAL_BOTH_FEET_BALANCE,
      course4_one_foot: env.STRIPE_PRICE_FUNGAL_COURSE4_ONE_FOOT_BALANCE,
      course4_both_feet: env.STRIPE_PRICE_FUNGAL_COURSE4_BOTH_FEET_BALANCE
    }
  };

  form.set("line_items[0][quantity]", "1");

  const stripePriceId =
    category === "tattoo"
      ? stripePriceLookup.tattoo?.[packageType]?.[tattooSize] || ""
      : stripePriceLookup[category]?.[packageType] || "";

  if (!stripePriceId.startsWith("price_")) {
    throw new Error(
      `Stripe Price ID is not configured for ${category} ${packageType}${tattooSize ? ` ${tattooSize}` : ""}.`
    );
  }

  form.set("line_items[0][price]", stripePriceId);

  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Stripe Checkout Session could not be created."
    );
  }

  if (!data.id || !data.url) {
    throw new Error(
      "Stripe did not return a Checkout URL."
    );
  }

  return data;
}


function getReturningTreatmentDefinition(
  category,
  packageKey,
  tattooSize,
  packageType,
  env
) {
  const normalisedCategory = String(category || "").toLowerCase();
  const normalisedKey = String(packageKey || "").toLowerCase();
  const normalisedSize = String(tattooSize || "").toLowerCase();
  const normalisedPackageType = String(packageType || "").toLowerCase();

  const tattooPrices = {
    tiny: {
      single: 70,
      bundle: 360,
      name: "Tiny Tattoo",
      singlePriceId: env.STRIPE_PRICE_TATTOO_TINY_SINGLE,
      bundlePriceId: env.STRIPE_PRICE_TATTOO_TINY_BUNDLE
    },

    small: {
      single: 95,
      bundle: 495,
      name: "Small Tattoo",
      singlePriceId: env.STRIPE_PRICE_TATTOO_SMALL_SINGLE,
      bundlePriceId: env.STRIPE_PRICE_TATTOO_SMALL_BUNDLE
    },

    medium: {
      single: 120,
      bundle: 620,
      name: "Medium Tattoo",
      singlePriceId: env.STRIPE_PRICE_TATTOO_MEDIUM_SINGLE,
      bundlePriceId: env.STRIPE_PRICE_TATTOO_MEDIUM_BUNDLE
    },

    large: {
      single: 160,
      bundle: 820,
      name: "Large Tattoo",
      singlePriceId: env.STRIPE_PRICE_TATTOO_LARGE_SINGLE,
      bundlePriceId: env.STRIPE_PRICE_TATTOO_LARGE_BUNDLE
    },

    xl: {
      single: 200,
      bundle: 1050,
      name: "XL Tattoo",
      singlePriceId: env.STRIPE_PRICE_TATTOO_XL_SINGLE,
      bundlePriceId: env.STRIPE_PRICE_TATTOO_XL_BUNDLE
    }
  };

  const laserPrices = {
    carbon: {
      carbon_single: {
        amount: 85,
        name: "Single Carbon Facial",
        packageType: "single_session",
        sessionsTotal: 1
      },
      carbon_course3: {
        amount: 225,
        name: "Course of 3 Treatments",
        packageType: "three_sessions",
        sessionsTotal: 3
      }
    },
    fungal: {
      fungal_single_nail: {
        amount: 45,
        name: "Single Nail",
        packageType: "single_nail",
        sessionsTotal: 1
      },
      fungal_one_foot: {
        amount: 85,
        name: "One Foot (Up to 5 Nails)",
        packageType: "one_foot",
        sessionsTotal: 1
      },
      fungal_both_feet: {
        amount: 120,
        name: "Both Feet",
        packageType: "both_feet",
        sessionsTotal: 1
      },
      fungal_course4_one_foot: {
        amount: 300,
        name: "Course of 4 Sessions (One Foot)",
        packageType: "course4_one_foot",
        sessionsTotal: 4
      },
      fungal_course4_both_feet: {
        amount: 420,
        name: "Course of 4 Sessions (Both Feet)",
        packageType: "course4_both_feet",
        sessionsTotal: 4
      }
    }
  };

  if (normalisedCategory === "tattoo") {
    const tattoo = tattooPrices[normalisedSize];
    if (!tattoo) return null;

    const isSingle = normalisedPackageType === "single_session";
    const isBundle = ["six_sessions", "6_sessions"].includes(normalisedPackageType);
    if (!isSingle && !isBundle) return null;

    return {
      category: "tattoo",
      packageKey: normalisedSize,
      packageType: isSingle ? "single_session" : "six_sessions",
      tattooSize: normalisedSize,
      amount: isSingle ? tattoo.single : tattoo.bundle,
      name: `${tattoo.name} - ${isSingle ? "Single Session" : "6 Session Bundle"}`,
      sessionsTotal: isSingle ? 1 : 6,
      stripePriceId: isSingle
        ? tattoo.singlePriceId
        : tattoo.bundlePriceId
    };
  }

  const definition = laserPrices[normalisedCategory]?.[normalisedKey];
  if (!definition) return null;

  return {
    category: normalisedCategory,
    packageKey: normalisedKey,
    packageType: definition.packageType,
    tattooSize: null,
    amount: definition.amount,
    name: definition.name,
    sessionsTotal: definition.sessionsTotal
  };
}

async function createReturningTreatmentCheckout(booking, env) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set(
    "success_url",
    "https://barebymarlese.com/payment-complete.html?session_id={CHECKOUT_SESSION_ID}"
  );
  form.set(
    "cancel_url",
    "https://barebymarlese.com/payment-cancelled.html?client=existing"
  );

  form.set("metadata[payment_purpose]", "returning_treatment_payment");
  form.set("metadata[client_name]", String(booking.client_name || ""));
  form.set("metadata[email]", String(booking.email || ""));
  form.set("metadata[phone]", String(booking.phone || ""));
  form.set("metadata[appointment_date]", String(booking.appointment_date || ""));
  form.set("metadata[appointment_time]", String(booking.appointment_time || ""));
  form.set("metadata[treatment_category]", String(booking.treatment_category || ""));
  form.set("metadata[treatment_name]", String(booking.treatment_name || ""));
  form.set("metadata[package_type]", String(booking.package_type || ""));
  form.set("metadata[tattoo_size]", String(booking.tattoo_size || ""));
  form.set("metadata[sessions_total]", String(booking.sessions_total || 1));
  form.set("metadata[full_price]", String(booking.full_price || 0));

  form.set(
    "payment_intent_data[metadata][payment_purpose]",
    "returning_treatment_payment"
  );
  form.set("allow_promotion_codes", "true");

  if (booking.email) {
    form.set("customer_email", booking.email);
  }

  form.set("line_items[0][quantity]", "1");

  const stripePriceId = String(
    booking.stripe_price_id || ""
  ).trim();

  if (stripePriceId.startsWith("price_")) {
    form.set(
      "line_items[0][price]",
      stripePriceId
    );
  } else {
    form.set(
      "line_items[0][price_data][currency]",
      "gbp"
    );

    form.set(
      "line_items[0][price_data][unit_amount]",
      String(
        Math.round(
          Number(booking.full_price || 0) * 100
        )
      )
    );

    form.set(
      "line_items[0][price_data][product_data][name]",
      booking.treatment_name ||
      "Returning Client Treatment"
    );
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Stripe returning-client Checkout Session could not be created."
    );
  }

  if (!data.id || !data.url) {
    throw new Error("Stripe did not return a Checkout URL.");
  }

  return data;
}

async function applyReturningTreatmentPayment(sessionId, env) {
  if (!sessionId || !sessionId.startsWith("cs_")) {
    throw new Error("Invalid Stripe Checkout Session.");
  }

  const stripe = await getStripeCheckout(sessionId, env);

  if (!stripe || stripe.payment_status !== "paid" || stripe.status !== "complete") {
    throw new Error("Stripe returning-client payment is not complete.");
  }

  if (stripe.currency && stripe.currency !== "gbp") {
    throw new Error("Unexpected Stripe payment currency.");
  }

  if (stripe.metadata?.payment_purpose !== "returning_treatment_payment") {
    throw new Error("This Checkout Session is not a returning-client treatment payment.");
  }

  // Idempotency: never create two appointments for the same Stripe payment.
  const existingBooking = await env.DB.prepare(`
    SELECT *
    FROM appointments
    WHERE payment_reference = ?
    LIMIT 1
  `).bind(stripe.id).first();

  if (existingBooking) {
    return {
      success: true,
      already_applied: true,
      booking_id: existingBooking.id,
      client_name: existingBooking.client_name,
      treatment_name: existingBooking.treatment_name,
      appointment_date: existingBooking.appointment_date,
      appointment_time: existingBooking.appointment_time,
      payment_status: existingBooking.payment_status,
      amount_paid: Number(existingBooking.amount_paid || 0),
      remaining_balance: Number(existingBooking.remaining_balance || 0),
      coupon_code: existingBooking.coupon_code || null,
      discount_amount: Number(existingBooking.discount_amount || 0),
      price_before_discount: Number(
        existingBooking.price_before_discount || existingBooking.full_price || 0
      )
    };
  }

  const metadata = stripe.metadata || {};
  const clientName = String(metadata.client_name || "").trim();
  const email = String(metadata.email || "").trim();
  const phone = String(metadata.phone || "").trim();
  const appointmentDate = String(metadata.appointment_date || "").trim();
  const appointmentTime = String(metadata.appointment_time || "").trim();
  const treatmentCategory = String(metadata.treatment_category || "").trim().toLowerCase();
  const treatmentName = String(metadata.treatment_name || "").trim();
  const packageType = String(metadata.package_type || "").trim();
  const tattooSize = String(metadata.tattoo_size || "").trim() || null;
  const sessionsTotal = Number(metadata.sessions_total || 1);
  const fullPrice = Number(metadata.full_price || 0);

  if (
    !clientName ||
    !email ||
    !phone ||
    !appointmentDate ||
    !appointmentTime ||
    !treatmentName ||
    !packageType
  ) {
    throw new Error("The Stripe payment is missing required booking details.");
  }

  if (!["tattoo", "carbon", "fungal"].includes(treatmentCategory)) {
    throw new Error("The Stripe payment contains an invalid treatment category.");
  }

  if (!Number.isInteger(sessionsTotal) || sessionsTotal <= 0) {
    throw new Error("The Stripe payment contains an invalid session total.");
  }

  if (!Number.isFinite(fullPrice) || fullPrice <= 0) {
    throw new Error("The Stripe payment contains an invalid treatment price.");
  }

  const blockedDate = await env.DB.prepare(`
    SELECT block_date
    FROM blocked_dates
    WHERE block_date = ?
    LIMIT 1
  `).bind(appointmentDate).first();

  if (blockedDate) {
    throw new Error("The selected treatment date has since been blocked.");
  }

  const validSlots = getSlotsByType("treatment", appointmentDate);
  if (!validSlots.includes(appointmentTime)) {
    throw new Error("The selected treatment time is no longer valid.");
  }

  // Read-only duration-aware clash check. No existing record is changed.
  const slotOccupied = await isClinicSlotOccupied(
    appointmentDate,
    appointmentTime,
    "treatment",
    env
  );

  if (slotOccupied) {
    await sendErrorAlert(
      env,
      "Paid returning-client slot clash",
      `Stripe payment ${stripe.id} was received for ${clientName}, but ${appointmentDate} at ${appointmentTime} is already occupied. The payment has not been attached to an appointment.`
    );

    throw new Error(
      "This appointment time was taken while payment was being completed. The payment has been received, but the client must be moved to another available time."
    );
  }

  const amountPaid = Number(stripe.amount_total || 0) / 100;
  const {
  discountAmount,
  couponCode
} = await getStripeDiscountDetails(stripe, env);
  const remainingBalance = Math.max(0, fullPrice - amountPaid - discountAmount);
  const rescheduleToken = crypto.randomUUID();

  // Create a new confirmed appointment only after Stripe confirms payment.
  const insert = await env.DB.prepare(`
    INSERT INTO appointments
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
      treatment_name,
      full_price,
      remaining_balance,
      coupon_code,
      discount_amount,
      price_before_discount,
      consultation_complete,
      patch_test_complete
    )
    VALUES (
      ?, ?, ?, ?, ?,
      'confirmed',
      ?, 'treatment', ?, ?, ?, 'paid',
      'returning_treatment_payment',
      ?, 0, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0
    )
  `).bind(
    clientName,
    email,
    phone,
    appointmentDate,
    appointmentTime,
    rescheduleToken,
    packageType,
    tattooSize,
    amountPaid,
    sessionsTotal,
    stripe.id,
    treatmentCategory,
    treatmentName,
    fullPrice,
    remainingBalance,
    couponCode,
    discountAmount,
    fullPrice
  ).run();

  const bookingId = Number(insert.meta?.last_row_id);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new Error("The paid treatment appointment could not be created.");
  }

  for (let sessionNumber = 1; sessionNumber <= sessionsTotal; sessionNumber++) {
    await env.DB.prepare(`
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
      sessionNumber,
      sessionNumber === 1 ? appointmentDate : null,
      sessionNumber === 1 ? appointmentTime : null,
      sessionNumber === 1 ? "booked" : "pending",
      crypto.randomUUID()
    ).run();
  }

  await sendEmail({
    to: env.TO_EMAIL,
    subject: "Returning Client Treatment Paid & Confirmed",
    html: `
      <p><strong>Client:</strong> ${escapeHtml(clientName)}</p>
      <p><strong>Treatment:</strong> ${escapeHtml(treatmentName)}</p>
      <p><strong>Date:</strong> ${escapeHtml(appointmentDate)}</p>
      <p><strong>Time:</strong> ${escapeHtml(appointmentTime)}</p>
      <p><strong>Paid:</strong> £${amountPaid.toFixed(2)}</p>
      <p><strong>Returning client:</strong> Verify previous consultation and patch test before treatment.</p>
    `
  });

  await sendEmail({
    to: email,
    subject: "Treatment Appointment Confirmed – BARE by Marlese",
    html: `
      <p>Hi ${escapeHtml(clientName || "there")},</p>
      <p>Your treatment appointment has been confirmed.</p>
      <p><strong>Treatment:</strong> ${escapeHtml(treatmentName)}</p>
      <p><strong>Date:</strong> ${escapeHtml(appointmentDate)}</p>
      <p><strong>Time:</strong> ${escapeHtml(appointmentTime)}</p>
      <p>Your previous consultation and patch-test history will be checked before treatment proceeds.</p>
      <p>Kind regards,<br><strong>Marlese</strong><br>BARE by Marlese</p>
    `
  });

  return {
    success: true,
    already_applied: false,
    booking_id: bookingId,
    client_name: clientName,
    treatment_name: treatmentName,
    appointment_date: appointmentDate,
    appointment_time: appointmentTime,
    checkout_session_id: stripe.id,
    amount_paid: amountPaid,
    remaining_balance: remainingBalance,
    payment_status: "paid",
    coupon_code: couponCode,
    discount_amount: discountAmount,
    price_before_discount: fullPrice
  };
}

function hexToBytes(hex = "") {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function safeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!rawBody || !signatureHeader || !webhookSecret) return false;

  const parts = signatureHeader.split(",");
  let timestamp = "";
  const signatures = [];

  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }

  const timestampNumber = Number(timestamp);
  if (!timestamp || !Number.isFinite(timestampNumber) || signatures.length === 0) {
    return false;
  }

  // Reject replayed webhook requests older than five minutes.
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const calculated = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedPayload)
    )
  );

  return signatures.some(signature =>
    safeEqualBytes(calculated, hexToBytes(signature))
  );
}

async function applyStripeBalancePayment(sessionId, env) {
  if (!sessionId || !sessionId.startsWith("cs_")) {
    throw new Error("Invalid Stripe Checkout Session.");
  }

  const stripe = await getStripeCheckout(sessionId, env);

  if (!stripe || stripe.payment_status !== "paid" || stripe.status !== "complete") {
    throw new Error("Stripe balance payment is not complete.");
  }

  if (stripe.currency && stripe.currency !== "gbp") {
    throw new Error("Unexpected Stripe payment currency.");
  }

  if (stripe.metadata?.payment_purpose !== "treatment_balance") {
    throw new Error("This Checkout Session is not a treatment balance payment.");
  }

  const bookingId = Number(
    stripe.metadata?.appointment_id || stripe.client_reference_id
  );

  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new Error("Stripe payment is missing its appointment reference.");
  }

  const booking = await env.DB.prepare(`
    SELECT
      id,
      client_name,
      treatment_name,
      booking_type,
      treatment_category,
      payment_status,
      full_price,
      amount_paid,
      remaining_balance,
      coupon_code,
      discount_amount,
      price_before_discount,
      balance_payment_reference
    FROM appointments
    WHERE id = ?
  `).bind(bookingId).first();

  if (!booking) throw new Error("The linked appointment was not found.");

  const category = String(booking.treatment_category || "").toLowerCase();
  if (!["consultation", "treatment"].includes(booking.booking_type) || !["tattoo", "carbon", "fungal"].includes(category)) {
    throw new Error("The linked appointment is not eligible for a balance payment.");
  }

  if (booking.balance_payment_reference === stripe.id) {
    return {
      success: true,
      already_applied: true,
      booking_id: booking.id,
      client_name: booking.client_name,
      treatment_name: booking.treatment_name,
      payment_status: booking.payment_status,
      amount_paid: Number(booking.amount_paid || 0),
      remaining_balance: Number(booking.remaining_balance || 0),
      coupon_code: booking.coupon_code || null,
      discount_amount: Number(booking.discount_amount || 0),
      price_before_discount: Number(booking.price_before_discount || booking.full_price || 0)
    };
  }

  if (booking.balance_payment_reference) {
    throw new Error("A different balance payment has already been applied.");
  }

  const balanceCashPaid = Number(stripe.amount_total || 0) / 100;
  const {
  discountAmount: balanceDiscount,
  couponCode: balanceCoupon
} = await getStripeDiscountDetails(stripe, env);

  const fullPrice = Number(booking.full_price || 0);
  const existingPaid = Number(booking.amount_paid || 0);
  const existingDiscount = Number(booking.discount_amount || 0);
  const newAmountPaid = existingPaid + balanceCashPaid;
  const newDiscountAmount = existingDiscount + balanceDiscount;
  const newRemainingBalance = Math.max(
    0,
    fullPrice - newAmountPaid - newDiscountAmount
  );
  const newPaymentStatus = newRemainingBalance <= 0.005 ? "paid" : "deposit_paid";

  const update = await env.DB.prepare(`
    UPDATE appointments
    SET
      amount_paid = ?,
      payment_status = ?,
      remaining_balance = ?,
      coupon_code = COALESCE(?, coupon_code),
      discount_amount = ?,
      price_before_discount = CASE
        WHEN full_price > 0 THEN full_price
        ELSE COALESCE(price_before_discount, 0)
      END,
      balance_payment_reference = ?
    WHERE id = ?
      AND balance_payment_reference IS NULL
  `).bind(
    newAmountPaid,
    newPaymentStatus,
    newRemainingBalance,
    balanceCoupon,
    newDiscountAmount,
    stripe.id,
    booking.id
  ).run();

  if (!update.meta?.changes) {
    const latest = await env.DB.prepare(`
      SELECT balance_payment_reference
      FROM appointments
      WHERE id = ?
    `).bind(booking.id).first();

    if (latest?.balance_payment_reference === stripe.id) {
      return applyStripeBalancePayment(stripe.id, env);
    }
    throw new Error("The balance payment could not be applied.");
  }

  return {
    success: true,
    already_applied: false,
    booking_id: booking.id,
    client_name: booking.client_name,
    treatment_name: booking.treatment_name,
    checkout_session_id: stripe.id,
    balance_cash_paid: balanceCashPaid,
    balance_discount: balanceDiscount,
    amount_paid: newAmountPaid,
    remaining_balance: newRemainingBalance,
    payment_status: newPaymentStatus,
    coupon_code: balanceCoupon || booking.coupon_code || null,
    discount_amount: newDiscountAmount,
    price_before_discount: fullPrice
  };
}


/* =========================================================
   TREATMENT RECORDS — Cloudflare D1
   Routes:
   GET    ?treatment-records=1
   POST   ?treatment-records=1
   PUT    ?treatment-records=1
   DELETE ?treatment-records=1&id=123
   ========================================================= */

function treatmentRecordJson(value) {
  return JSON.stringify(Array.isArray(value) ? value : (value || []));
}

function parseTreatmentRecordJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normaliseTreatmentRecord(row) {
  if (!row) return null;

  return {
    ...row,
    cooling: parseTreatmentRecordJson(row.cooling),
    tattoo_colours: parseTreatmentRecordJson(row.tattoo_colours),
    tattoo_response: parseTreatmentRecordJson(row.tattoo_response),
    carbon_response: parseTreatmentRecordJson(row.carbon_response),
    affected_foot: parseTreatmentRecordJson(row.affected_foot),
    nails_treated: parseTreatmentRecordJson(row.nails_treated),
    nail_appearance: parseTreatmentRecordJson(row.nail_appearance)
  };
}

function cleanOptionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cleanRequiredSessionNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function treatmentRecordPayload(body = {}) {
  return {
    appointment_id: cleanOptionalInteger(body.appointment_id),
    treatment_session_id: cleanOptionalInteger(body.treatment_session_id),
    client_name: String(body.client_name || "").trim(),
    treatment_type: String(body.treatment_type || "").trim(),
    package_name: String(body.package_name || "").trim(),
    session_number: cleanRequiredSessionNumber(body.session_number),
    treatment_date: String(body.treatment_date || "").trim(),
    practitioner: String(body.practitioner || "Marlese Rosch Haden").trim(),
    treatment_area: String(body.treatment_area || "").trim(),
    machine: String(body.machine || "").trim(),
    wavelength: String(body.wavelength || "").trim(),
    fluence: String(body.fluence || "").trim(),
    cooling: treatmentRecordJson(body.cooling),
    tattoo_colours: treatmentRecordJson(body.tattoo_colours),
    tattoo_response: treatmentRecordJson(body.tattoo_response),
    carbon_layer: String(body.carbon_layer || "").trim(),
    carbon_response: treatmentRecordJson(body.carbon_response),
    affected_foot: treatmentRecordJson(body.affected_foot),
    nails_treated: treatmentRecordJson(body.nails_treated),
    nail_appearance: treatmentRecordJson(body.nail_appearance),
    client_tolerance: String(body.client_tolerance || "").trim(),
    next_session_plan: String(body.next_session_plan || "").trim(),
    next_treatment_date: String(body.next_treatment_date || "").trim(),
    recommended_interval: String(body.recommended_interval || "").trim()
  };
}

function validateTreatmentRecordPayload(record) {
  if (!record.client_name) return "Client name is required.";
  if (!record.treatment_type) return "Treatment type is required.";
  if (!record.package_name) return "Treatment option is required.";
  if (!record.session_number) return "A valid session number is required.";
  if (!record.treatment_date) return "Treatment date is required.";
  return "";
}

if (
  url.searchParams.get("treatment-records") === "1" &&
  request.method === "GET"
) {
  try {
    const id = cleanOptionalInteger(url.searchParams.get("id"));
    const appointmentId = cleanOptionalInteger(
      url.searchParams.get("appointment_id")
    );
    const treatmentSessionId = cleanOptionalInteger(
      url.searchParams.get("treatment_session_id")
    );
    const clientName = String(
      url.searchParams.get("client_name") || ""
    ).trim();

    if (id) {
      const record = await env.DB.prepare(`
        SELECT *
        FROM treatment_records
        WHERE id = ?
      `).bind(id).first();

      if (!record) {
        return new Response(
          JSON.stringify({ success: false, message: "Treatment record not found." }),
          { status: 404, headers: jsonHeaders }
        );
      }

      return new Response(
        JSON.stringify({ success: true, record: normaliseTreatmentRecord(record) }),
        { status: 200, headers: jsonHeaders }
      );
    }

    let query = `
      SELECT *
      FROM treatment_records
    `;
    const bindings = [];

    if (appointmentId) {
      query += ` WHERE appointment_id = ?`;
      bindings.push(appointmentId);
    } else if (treatmentSessionId) {
      query += ` WHERE treatment_session_id = ?`;
      bindings.push(treatmentSessionId);
    } else if (clientName) {
      query += ` WHERE LOWER(client_name) = LOWER(?)`;
      bindings.push(clientName);
    }

    query += `
      ORDER BY treatment_date DESC, session_number DESC, id DESC
    `;

    const result = bindings.length
      ? await env.DB.prepare(query).bind(...bindings).all()
      : await env.DB.prepare(query).all();

    return new Response(
      JSON.stringify({
        success: true,
        records: (result.results || []).map(normaliseTreatmentRecord)
      }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (error) {
    await sendErrorAlert(
      env,
      "Load treatment records error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message: error.message || "Treatment records could not be loaded."
      }),
      { status: 500, headers: jsonHeaders }
    );
  }
}

if (
  url.searchParams.get("treatment-records") === "1" &&
  request.method === "POST"
) {
  try {
    const body = await request.json();
    const record = treatmentRecordPayload(body);
    const validationError = validateTreatmentRecordPayload(record);

    if (validationError) {
      return new Response(
        JSON.stringify({ success: false, message: validationError }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (record.appointment_id) {
      const appointment = await env.DB.prepare(`
        SELECT id
        FROM appointments
        WHERE id = ?
      `).bind(record.appointment_id).first();

      if (!appointment) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "The linked appointment was not found."
          }),
          { status: 404, headers: jsonHeaders }
        );
      }
    }

    if (record.treatment_session_id) {
      const session = await env.DB.prepare(`
        SELECT id, appointment_id, session_number
        FROM treatment_sessions
        WHERE id = ?
      `).bind(record.treatment_session_id).first();

      if (!session) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "The linked treatment session was not found."
          }),
          { status: 404, headers: jsonHeaders }
        );
      }

      if (
        record.appointment_id &&
        Number(session.appointment_id) !== record.appointment_id
      ) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "The treatment session does not belong to this appointment."
          }),
          { status: 409, headers: jsonHeaders }
        );
      }
    }

    let existing = null;

    if (record.appointment_id) {
      existing = await env.DB.prepare(`
        SELECT id
        FROM treatment_records
        WHERE appointment_id = ?
          AND session_number = ?
      `).bind(
        record.appointment_id,
        record.session_number
      ).first();
    }

    if (!existing && record.treatment_session_id) {
      existing = await env.DB.prepare(`
        SELECT id
        FROM treatment_records
        WHERE treatment_session_id = ?
      `).bind(record.treatment_session_id).first();
    }

    if (existing) {
      const updated = await env.DB.prepare(`
        UPDATE treatment_records
        SET
          appointment_id = ?,
          treatment_session_id = ?,
          client_name = ?,
          treatment_type = ?,
          package_name = ?,
          session_number = ?,
          treatment_date = ?,
          practitioner = ?,
          treatment_area = ?,
          machine = ?,
          wavelength = ?,
          fluence = ?,
          cooling = ?,
          tattoo_colours = ?,
          tattoo_response = ?,
          carbon_layer = ?,
          carbon_response = ?,
          affected_foot = ?,
          nails_treated = ?,
          nail_appearance = ?,
          client_tolerance = ?,
          next_session_plan = ?,
          next_treatment_date = ?,
          recommended_interval = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        record.appointment_id,
        record.treatment_session_id,
        record.client_name,
        record.treatment_type,
        record.package_name,
        record.session_number,
        record.treatment_date,
        record.practitioner,
        record.treatment_area,
        record.machine,
        record.wavelength,
        record.fluence,
        record.cooling,
        record.tattoo_colours,
        record.tattoo_response,
        record.carbon_layer,
        record.carbon_response,
        record.affected_foot,
        record.nails_treated,
        record.nail_appearance,
        record.client_tolerance,
        record.next_session_plan,
        record.next_treatment_date || null,
        record.recommended_interval,
        existing.id
      ).run();

      const saved = await env.DB.prepare(`
        SELECT *
        FROM treatment_records
        WHERE id = ?
      `).bind(existing.id).first();

      return new Response(
        JSON.stringify({
          success: true,
          created: false,
          updated: Boolean(updated.meta?.changes),
          record: normaliseTreatmentRecord(saved)
        }),
        { status: 200, headers: jsonHeaders }
      );
    }

    const inserted = await env.DB.prepare(`
      INSERT INTO treatment_records
      (
        appointment_id,
        treatment_session_id,
        client_name,
        treatment_type,
        package_name,
        session_number,
        treatment_date,
        practitioner,
        treatment_area,
        machine,
        wavelength,
        fluence,
        cooling,
        tattoo_colours,
        tattoo_response,
        carbon_layer,
        carbon_response,
        affected_foot,
        nails_treated,
        nail_appearance,
        client_tolerance,
        next_session_plan,
        next_treatment_date,
        recommended_interval
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).bind(
      record.appointment_id,
      record.treatment_session_id,
      record.client_name,
      record.treatment_type,
      record.package_name,
      record.session_number,
      record.treatment_date,
      record.practitioner,
      record.treatment_area,
      record.machine,
      record.wavelength,
      record.fluence,
      record.cooling,
      record.tattoo_colours,
      record.tattoo_response,
      record.carbon_layer,
      record.carbon_response,
      record.affected_foot,
      record.nails_treated,
      record.nail_appearance,
      record.client_tolerance,
      record.next_session_plan,
      record.next_treatment_date || null,
      record.recommended_interval
    ).run();

    const newId = Number(inserted.meta?.last_row_id);

    const saved = await env.DB.prepare(`
      SELECT *
      FROM treatment_records
      WHERE id = ?
    `).bind(newId).first();

    return new Response(
      JSON.stringify({
        success: true,
        created: true,
        record: normaliseTreatmentRecord(saved)
      }),
      { status: 201, headers: jsonHeaders }
    );
  } catch (error) {
    const isConflict =
      String(error.message || "").includes("UNIQUE constraint failed");

    await sendErrorAlert(
      env,
      "Save treatment record error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message: isConflict
          ? "A treatment record already exists for this appointment and session."
          : (error.message || "The treatment record could not be saved.")
      }),
      { status: isConflict ? 409 : 500, headers: jsonHeaders }
    );
  }
}

if (
  url.searchParams.get("treatment-records") === "1" &&
  request.method === "PUT"
) {
  try {
    const body = await request.json();
    const id = cleanOptionalInteger(body.id);
    const record = treatmentRecordPayload(body);
    const validationError = validateTreatmentRecordPayload(record);

    if (!id) {
      return new Response(
        JSON.stringify({ success: false, message: "Treatment record ID is required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (validationError) {
      return new Response(
        JSON.stringify({ success: false, message: validationError }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const exists = await env.DB.prepare(`
      SELECT id
      FROM treatment_records
      WHERE id = ?
    `).bind(id).first();

    if (!exists) {
      return new Response(
        JSON.stringify({ success: false, message: "Treatment record not found." }),
        { status: 404, headers: jsonHeaders }
      );
    }

    await env.DB.prepare(`
      UPDATE treatment_records
      SET
        appointment_id = ?,
        treatment_session_id = ?,
        client_name = ?,
        treatment_type = ?,
        package_name = ?,
        session_number = ?,
        treatment_date = ?,
        practitioner = ?,
        treatment_area = ?,
        machine = ?,
        wavelength = ?,
        fluence = ?,
        cooling = ?,
        tattoo_colours = ?,
        tattoo_response = ?,
        carbon_layer = ?,
        carbon_response = ?,
        affected_foot = ?,
        nails_treated = ?,
        nail_appearance = ?,
        client_tolerance = ?,
        next_session_plan = ?,
        next_treatment_date = ?,
        recommended_interval = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      record.appointment_id,
      record.treatment_session_id,
      record.client_name,
      record.treatment_type,
      record.package_name,
      record.session_number,
      record.treatment_date,
      record.practitioner,
      record.treatment_area,
      record.machine,
      record.wavelength,
      record.fluence,
      record.cooling,
      record.tattoo_colours,
      record.tattoo_response,
      record.carbon_layer,
      record.carbon_response,
      record.affected_foot,
      record.nails_treated,
      record.nail_appearance,
      record.client_tolerance,
      record.next_session_plan,
      record.next_treatment_date || null,
      record.recommended_interval,
      id
    ).run();

    const saved = await env.DB.prepare(`
      SELECT *
      FROM treatment_records
      WHERE id = ?
    `).bind(id).first();

    return new Response(
      JSON.stringify({
        success: true,
        updated: true,
        record: normaliseTreatmentRecord(saved)
      }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (error) {
    const isConflict =
      String(error.message || "").includes("UNIQUE constraint failed");

    await sendErrorAlert(
      env,
      "Update treatment record error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message: isConflict
          ? "Another treatment record already uses this appointment and session."
          : (error.message || "The treatment record could not be updated.")
      }),
      { status: isConflict ? 409 : 500, headers: jsonHeaders }
    );
  }
}

if (
  url.searchParams.get("treatment-records") === "1" &&
  request.method === "DELETE"
) {
  try {
    const id = cleanOptionalInteger(url.searchParams.get("id"));

    if (!id) {
      return new Response(
        JSON.stringify({ success: false, message: "Treatment record ID is required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const deleted = await env.DB.prepare(`
      DELETE FROM treatment_records
      WHERE id = ?
    `).bind(id).run();

    if (!deleted.meta?.changes) {
      return new Response(
        JSON.stringify({ success: false, message: "Treatment record not found." }),
        { status: 404, headers: jsonHeaders }
      );
    }

    return new Response(
      JSON.stringify({ success: true, deleted: true, id }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (error) {
    await sendErrorAlert(
      env,
      "Delete treatment record error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message: error.message || "The treatment record could not be deleted."
      }),
      { status: 500, headers: jsonHeaders }
    );
  }
}

/* =========================================================
   PATCH TEST RECORDS — Cloudflare D1
   Routes:
   GET    ?patch-test-records=1
   POST   ?patch-test-records=1
   PUT    ?patch-test-records=1
   DELETE ?patch-test-records=1&id=123
   ========================================================= */

function patchTestRecordJson(value) {
  return JSON.stringify(
    Array.isArray(value) ? value : value ? [value] : []
  );
}

function parsePatchTestRecordJson(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value)
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
  }
}

function normalisePatchTestRecord(row) {
  if (!row) return null;

  return {
    ...row,
    immediate_reaction: parsePatchTestRecordJson(
      row.immediate_reaction
    )
  };
}

function patchTestRecordPayload(body = {}) {
  return {
    appointment_id: cleanOptionalInteger(body.appointment_id),

    practitioner: String(
      body.practitioner || "Marlese Rosch Haden"
    ).trim(),

    test_date: String(body.test_date || "").trim(),
    client_name: String(body.client_name || "").trim(),
    date_of_birth: String(body.date_of_birth || "").trim(),

    treatment_type: String(body.treatment_type || "").trim(),
    test_area: String(body.test_area || "").trim(),
    skin_type: String(body.skin_type || "").trim(),

    serial_no: String(body.serial_no || "").trim(),
    wavelength: String(body.wavelength || "").trim(),
    joules: String(body.joules || "").trim(),
    test_shots: String(body.test_shots || "").trim(),

    earliest_treatment_date: String(
      body.earliest_treatment_date || ""
    ).trim(),

    immediate_reaction: patchTestRecordJson(
      body.immediate_reaction
    ),

    eye_protection: String(
      body.eye_protection || "Yes"
    ).trim(),

    practitioner_notes: String(
      body.practitioner_notes || ""
    ).trim(),

    signature: String(body.signature || ""),
    signed_at: String(body.signed_at || "").trim()
  };
}

function validatePatchTestRecordPayload(record) {
  if (!record.client_name) {
    return "Client name is required.";
  }

  if (!record.test_date) {
    return "Patch-test date is required.";
  }

  if (!record.treatment_type) {
    return "Treatment type is required.";
  }

  if (!record.signature) {
    return "Client signature is required.";
  }

  return "";
}

/* GET PATCH TEST RECORDS */

if (
  url.searchParams.get("patch-test-records") === "1" &&
  request.method === "GET"
) {
  try {
    const id = cleanOptionalInteger(
      url.searchParams.get("id")
    );

    const appointmentId = cleanOptionalInteger(
      url.searchParams.get("appointment_id")
    );

    const clientName = String(
      url.searchParams.get("client_name") || ""
    ).trim();

    if (id) {
      const record = await env.DB.prepare(`
        SELECT *
        FROM patch_test_records
        WHERE id = ?
      `).bind(id).first();

      if (!record) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "Patch test record not found."
          }),
          {
            status: 404,
            headers: jsonHeaders
          }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          record: normalisePatchTestRecord(record)
        }),
        {
          status: 200,
          headers: jsonHeaders
        }
      );
    }

    let query = `
      SELECT *
      FROM patch_test_records
    `;

    const bindings = [];

    if (appointmentId) {
      query += ` WHERE appointment_id = ?`;
      bindings.push(appointmentId);
    } else if (clientName) {
      query += ` WHERE LOWER(client_name) = LOWER(?)`;
      bindings.push(clientName);
    }

    query += `
      ORDER BY test_date DESC, id DESC
    `;

    const result = bindings.length
      ? await env.DB.prepare(query).bind(...bindings).all()
      : await env.DB.prepare(query).all();

    return new Response(
      JSON.stringify({
        success: true,
        records: (result.results || []).map(
          normalisePatchTestRecord
        )
      }),
      {
        status: 200,
        headers: jsonHeaders
      }
    );
  } catch (error) {
    await sendErrorAlert(
      env,
      "Load patch test records error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message:
          error.message ||
          "Patch test records could not be loaded."
      }),
      {
        status: 500,
        headers: jsonHeaders
      }
    );
  }
}

/* CREATE PATCH TEST RECORD */

if (
  url.searchParams.get("patch-test-records") === "1" &&
  request.method === "POST"
) {
  try {
    const body = await request.json();
    const record = patchTestRecordPayload(body);

    const validationError =
      validatePatchTestRecordPayload(record);

    if (validationError) {
      return new Response(
        JSON.stringify({
          success: false,
          message: validationError
        }),
        {
          status: 400,
          headers: jsonHeaders
        }
      );
    }

    if (record.appointment_id) {
      const appointment = await env.DB.prepare(`
        SELECT id
        FROM appointments
        WHERE id = ?
      `).bind(record.appointment_id).first();

      if (!appointment) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "The linked appointment was not found."
          }),
          {
            status: 404,
            headers: jsonHeaders
          }
        );
      }
    }

    const inserted = await env.DB.prepare(`
      INSERT INTO patch_test_records
      (
        appointment_id,
        practitioner,
        test_date,
        client_name,
        date_of_birth,
        treatment_type,
        test_area,
        skin_type,
        serial_no,
        wavelength,
        joules,
        test_shots,
        earliest_treatment_date,
        immediate_reaction,
        eye_protection,
        practitioner_notes,
        signature,
        signed_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).bind(
      record.appointment_id,
      record.practitioner,
      record.test_date,
      record.client_name,
      record.date_of_birth || null,
      record.treatment_type,
      record.test_area,
      record.skin_type,
      record.serial_no,
      record.wavelength,
      record.joules,
      record.test_shots,
      record.earliest_treatment_date || null,
      record.immediate_reaction,
      record.eye_protection,
      record.practitioner_notes,
      record.signature,
      record.signed_at
    ).run();

    const savedId = Number(
      inserted.meta?.last_row_id
    );

    const saved = await env.DB.prepare(`
      SELECT *
      FROM patch_test_records
      WHERE id = ?
    `).bind(savedId).first();

    return new Response(
      JSON.stringify({
        success: true,
        created: true,
        record: normalisePatchTestRecord(saved)
      }),
      {
        status: 201,
        headers: jsonHeaders
      }
    );
  } catch (error) {
    await sendErrorAlert(
      env,
      "Save patch test record error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message:
          error.message ||
          "The patch test record could not be saved."
      }),
      {
        status: 500,
        headers: jsonHeaders
      }
    );
  }
}

/* UPDATE PATCH TEST RECORD */

if (
  url.searchParams.get("patch-test-records") === "1" &&
  request.method === "PUT"
) {
  try {
    const body = await request.json();
    const id = cleanOptionalInteger(body.id);

    if (!id) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "A valid patch test record ID is required."
        }),
        {
          status: 400,
          headers: jsonHeaders
        }
      );
    }

    const record = patchTestRecordPayload(body);

    const validationError =
      validatePatchTestRecordPayload(record);

    if (validationError) {
      return new Response(
        JSON.stringify({
          success: false,
          message: validationError
        }),
        {
          status: 400,
          headers: jsonHeaders
        }
      );
    }

    const existing = await env.DB.prepare(`
      SELECT id
      FROM patch_test_records
      WHERE id = ?
    `).bind(id).first();

    if (!existing) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Patch test record not found."
        }),
        {
          status: 404,
          headers: jsonHeaders
        }
      );
    }

    if (record.appointment_id) {
      const appointment = await env.DB.prepare(`
        SELECT id
        FROM appointments
        WHERE id = ?
      `).bind(record.appointment_id).first();

      if (!appointment) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "The linked appointment was not found."
          }),
          {
            status: 404,
            headers: jsonHeaders
          }
        );
      }
    }

    await env.DB.prepare(`
      UPDATE patch_test_records
      SET
        appointment_id = ?,
        practitioner = ?,
        test_date = ?,
        client_name = ?,
        date_of_birth = ?,
        treatment_type = ?,
        test_area = ?,
        skin_type = ?,
        serial_no = ?,
        wavelength = ?,
        joules = ?,
        test_shots = ?,
        earliest_treatment_date = ?,
        immediate_reaction = ?,
        eye_protection = ?,
        practitioner_notes = ?,
        signature = ?,
        signed_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      record.appointment_id,
      record.practitioner,
      record.test_date,
      record.client_name,
      record.date_of_birth || null,
      record.treatment_type,
      record.test_area,
      record.skin_type,
      record.serial_no,
      record.wavelength,
      record.joules,
      record.test_shots,
      record.earliest_treatment_date || null,
      record.immediate_reaction,
      record.eye_protection,
      record.practitioner_notes,
      record.signature,
      record.signed_at,
      id
    ).run();

    const saved = await env.DB.prepare(`
      SELECT *
      FROM patch_test_records
      WHERE id = ?
    `).bind(id).first();

    return new Response(
      JSON.stringify({
        success: true,
        updated: true,
        record: normalisePatchTestRecord(saved)
      }),
      {
        status: 200,
        headers: jsonHeaders
      }
    );
  } catch (error) {
    await sendErrorAlert(
      env,
      "Update patch test record error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message:
          error.message ||
          "The patch test record could not be updated."
      }),
      {
        status: 500,
        headers: jsonHeaders
      }
    );
  }
}

/* DELETE PATCH TEST RECORD */

if (
  url.searchParams.get("patch-test-records") === "1" &&
  request.method === "DELETE"
) {
  try {
    const id = cleanOptionalInteger(
      url.searchParams.get("id")
    );

    if (!id) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "A valid patch test record ID is required."
        }),
        {
          status: 400,
          headers: jsonHeaders
        }
      );
    }

    const deleted = await env.DB.prepare(`
      DELETE FROM patch_test_records
      WHERE id = ?
    `).bind(id).run();

    if (!deleted.meta?.changes) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Patch test record not found."
        }),
        {
          status: 404,
          headers: jsonHeaders
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        deleted: true,
        id
      }),
      {
        status: 200,
        headers: jsonHeaders
      }
    );
  } catch (error) {
    await sendErrorAlert(
      env,
      "Delete patch test record error",
      error.stack || error.message || error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message:
          error.message ||
          "The patch test record could not be deleted."
      }),
      {
        status: 500,
        headers: jsonHeaders
      }
    );
  }
}

if (
  request.method === "POST" &&
  url.searchParams.get("payment") === "create-consultation-checkout"
) {
  try {
    const body = await request.json();
    const category = String(body.category || "").toLowerCase();

    if (!["carbon", "fungal"].includes(category)) {
      return new Response(
        "Consultation Checkout is only available for Carbon and Fungal.",
        { status: 400 }
      );
    }

    const checkout =
      await createStripeConsultationCheckout(category, env);

    return new Response(
      JSON.stringify({
        success: true,
        category,
        checkout_session_id: checkout.id,
        checkout_url: checkout.url
      }),
      {
        status: 200,
        headers: jsonHeaders
      }
    );

  } catch (error) {
    await sendErrorAlert(
      env,
      "Create consultation Checkout error",
      error.stack || error.message || error
    );

    return new Response(
      error.message ||
      "The consultation payment link could not be created.",
      { status: 500 }
    );
  }
}
  

if (
  request.method === "POST" &&
  url.searchParams.get("payment") === "create-returning-treatment-checkout"
) {
  try {
    const body = await request.json();

    if (
      body.client_type !== "existing" ||
      body.returning_client_confirmation !== true
    ) {
      return new Response(
        "Returning-client confirmation is required.",
        { status: 400 }
      );
    }

    const definition = getReturningTreatmentDefinition(
      body.treatment_category,
      body.package_key,
      body.tattoo_size,
      body.package_type,
      env
    );

    if (!definition) {
      return new Response(
        "Invalid returning-client treatment or package.",
        { status: 400 }
      );
    }

    const clientName = String(body.client_name || "").trim();
    const email = String(body.email || "").trim();
    const phone = String(body.phone || "").trim();
    const appointmentDate = String(body.appointment_date || "").trim();
    const appointmentTime = String(body.appointment_time || "").trim();

    if (!clientName || !email || !phone) {
      return new Response(
        "Name, email and phone number are required.",
        { status: 400 }
      );
    }

    if (!appointmentDate || !appointmentTime) {
      return new Response(
        "Appointment date and time are required.",
        { status: 400 }
      );
    }

    const blockedDate = await env.DB.prepare(`
      SELECT block_date
      FROM blocked_dates
      WHERE block_date = ?
      LIMIT 1
    `).bind(appointmentDate).first();

    if (blockedDate) {
      return new Response("This date is unavailable.", { status: 409 });
    }

    const validSlots = getSlotsByType("treatment", appointmentDate);
    if (!validSlots.includes(appointmentTime)) {
      return new Response("Invalid treatment time.", { status: 400 });
    }

    if (isPastSlot(appointmentDate, appointmentTime)) {
      return new Response(
        "This appointment time has already passed.",
        { status: 400 }
      );
    }

    // Duration-aware check against all genuine clinic bookings.
    const slotOccupied = await isClinicSlotOccupied(
      appointmentDate,
      appointmentTime,
      "treatment",
      env
    );

    if (slotOccupied) {
      return new Response("That slot is already taken.", { status: 409 });
    }

    // Temporary in-memory object only: nothing is inserted into D1 before payment.
    const booking = {
      client_name: clientName,
      email,
      phone,
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      treatment_category: definition.category,
      treatment_name: definition.name,
      package_type: definition.packageType,
      tattoo_size: definition.tattooSize,
      sessions_total: definition.sessionsTotal,
      full_price: definition.amount,
      stripe_price_id: definition.stripePriceId
    };

    const checkout = await createReturningTreatmentCheckout(booking, env);

    return new Response(JSON.stringify({
      success: true,
      checkout_session_id: checkout.id,
      checkout_url: checkout.url
    }), {
      status: 200,
      headers: jsonHeaders
    });
  } catch (error) {
    await sendErrorAlert(
      env,
      "Create returning treatment Checkout error",
      error.stack || error.message || error
    );

    return new Response(
      error.message ||
      "The returning-client treatment payment could not be created.",
      { status: 500 }
    );
  }
}

if (
  request.method === "POST" &&
  url.searchParams.get("payment") === "create-balance-checkout"
) {
  try {
    const body = await request.json();
    const bookingId = Number(body.id);

    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return new Response("Invalid booking ID", { status: 400 });
    }

    const booking = await env.DB.prepare(`
      SELECT
        id,
        client_name,
        email,
        status,
        booking_type,
        package_type,
        tattoo_size,
        treatment_category,
        treatment_name,
        payment_status,
        full_price,
        amount_paid,
        remaining_balance,
        balance_payment_reference,
        consultation_complete,
        patch_test_complete
      FROM appointments
      WHERE id = ?
    `).bind(bookingId).first();

    if (!booking) return new Response("Booking not found", { status: 404 });

    const category = String(booking.treatment_category || "").toLowerCase();
    if (!["consultation", "treatment"].includes(booking.booking_type) || !["tattoo", "carbon", "fungal"].includes(category)) {
      return new Response(
        "This booking is not eligible for a balance payment.",
        { status: 400 }
      );
    }

    if (booking.status === "cancelled") {
      return new Response(
        "A balance payment cannot be taken for a cancelled booking.",
        { status: 409 }
      );
    }

    if (booking.booking_type === "consultation" && (
      Number(booking.consultation_complete || 0) !== 1 ||
      Number(booking.patch_test_complete || 0) !== 1
    )) {
      return new Response(
        "Complete the consultation and patch test before collecting the balance.",
        { status: 409 }
      );
    }

    if (
      booking.payment_status === "paid" ||
      Number(booking.remaining_balance || 0) <= 0
    ) {
      return new Response("This appointment has already been paid in full.", {
        status: 409
      });
    }

    if (booking.balance_payment_reference) {
      return new Response(
        "A balance payment has already been recorded for this appointment.",
        { status: 409 }
      );
    }

    const checkout = await createStripeBalanceCheckout(booking, env);

    return new Response(JSON.stringify({
      success: true,
      booking_id: booking.id,
      client_name: booking.client_name,
      treatment_name: booking.treatment_name,
      balance_due: Number(booking.remaining_balance || 0),
      checkout_session_id: checkout.id,
      checkout_url: checkout.url
    }), {
      status: 200,
      headers: jsonHeaders
    });
  } catch (error) {
    await sendErrorAlert(
      env,
      "Create balance Checkout error",
      error.stack || error.message || error
    );
    return new Response(
      error.message || "The balance payment link could not be created.",
      { status: 500 }
    );
  }
}

if (
  request.method === "POST" &&
  url.searchParams.get("stripe") === "webhook"
) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Stripe webhook secret is not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("Stripe-Signature") || "";
  const validSignature = await verifyStripeWebhookSignature(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET
  );

  if (!validSignature) {
    return new Response("Invalid Stripe webhook signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid webhook payload", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data?.object;

      if (session?.metadata?.payment_purpose === "treatment_balance") {
        await applyStripeBalancePayment(session.id, env);
      }

      if (session?.metadata?.payment_purpose === "returning_treatment_payment") {
        await applyReturningTreatmentPayment(session.id, env);
      }
    }

    

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: jsonHeaders
    });
  } catch (error) {
    await sendErrorAlert(
      env,
      "Stripe balance webhook error",
      error.stack || error.message || error
    );
    return new Response("Webhook processing failed", { status: 500 });
  }
}

if (
  request.method === "GET" &&
  url.searchParams.get("payment") === "balance-status"
) {
  const sessionId = url.searchParams.get("session_id") || "";

  if (!sessionId.startsWith("cs_")) {
    return new Response(JSON.stringify({
      success: false,
      message: "Invalid payment reference."
    }), { status: 400, headers: jsonHeaders });
  }

  try {
    const stripe = await getStripeCheckout(sessionId, env);
    const purpose = stripe?.metadata?.payment_purpose;

    const result = purpose === "returning_treatment_payment"
      ? await applyReturningTreatmentPayment(sessionId, env)
      : await applyStripeBalancePayment(sessionId, env);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: jsonHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      processing: true,
      message: "Your payment is still being confirmed."
    }), { status: 202, headers: jsonHeaders });
  }
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
      balance_payment_reference,
      treatment_category,
      treatment_name,
      full_price,
      remaining_balance,
      coupon_code,
      discount_amount,
      price_before_discount,
      reschedule_token,
      aftercare_sent,
      consultation_complete,
      patch_test_complete
    FROM appointments
    ORDER BY appointment_date ASC, appointment_time ASC
  `).all();

  for (const booking of bookings.results) {
    // Always load linked treatment sessions. Consultation-parent bookings keep
    // booking_type = "consultation", so visibility must not depend on type.
    const sessions = await env.DB.prepare(`
      SELECT
        id,
        session_number,
        appointment_date,
        appointment_time,
        status,
        reschedule_token,
        reminder_sent,
        aftercare_sent,
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


  return new Response(JSON.stringify(bookings.results), {
    headers: jsonHeaders
  });

}

if (request.method === "POST" && url.searchParams.get("admin") === "patch-test-complete") {
  const body = await request.json();
  const id = Number(body.id);
  const complete = body.complete !== false ? 1 : 0;

  if (!Number.isInteger(id) || id <= 0) {
    return new Response("Invalid booking ID", { status: 400 });
  }

  const booking = await env.DB.prepare(`
    SELECT id, booking_type
    FROM appointments
    WHERE id = ?
  `).bind(id).first();

  if (!booking || booking.booking_type !== "consultation") {
    return new Response("Only consultation bookings can be updated", { status: 409 });
  }

  await env.DB.prepare(`
    UPDATE appointments
    SET consultation_complete = ?, patch_test_complete = ?
    WHERE id = ?
  `).bind(complete, complete, id).run();

  return new Response(JSON.stringify({
    success: true,
    consultation_complete: complete,
    patch_test_complete: complete
  }), { headers: jsonHeaders });
}


if (
  request.method === "POST" &&
  url.searchParams.get("admin") === "prepare-tattoo-treatment"
) {
  try {
    const body = await request.json();
    const consultationId = Number(body.consultation_id);
    const tattooSize = String(body.tattoo_size || "").trim().toLowerCase();
    const requestedPackageType = String(body.package_type || "").trim().toLowerCase();

    const prices = {
      tiny:   { single_session:{full:70,balance:40,sessions:1}, six_sessions:{full:360,balance:330,sessions:6} },
      small:  { single_session:{full:95,balance:65,sessions:1}, six_sessions:{full:495,balance:465,sessions:6} },
      medium: { single_session:{full:120,balance:90,sessions:1}, six_sessions:{full:620,balance:590,sessions:6} },
      large:  { single_session:{full:160,balance:130,sessions:1}, six_sessions:{full:820,balance:790,sessions:6} },
      xl:     { single_session:{full:200,balance:170,sessions:1}, six_sessions:{full:1050,balance:1020,sessions:6} }
    };

    if (!Number.isInteger(consultationId) || consultationId <= 0) {
      return new Response("Invalid consultation ID.", { status: 400 });
    }

    const selected = prices[tattooSize]?.[requestedPackageType];
    if (!selected) {
      return new Response("Choose a valid Tattoo size and treatment option.", { status: 400 });
    }

    const booking = await env.DB.prepare(`
      SELECT *
      FROM appointments
      WHERE id = ?
    `).bind(consultationId).first();

    if (!booking) return new Response("Consultation not found.", { status: 404 });

    const category = String(booking.treatment_category || "").toLowerCase();
    const treatmentText = `${booking.treatment_name || ""} ${booking.package_type || ""}`.toLowerCase();
    const isTattoo = category === "tattoo" || (!category && treatmentText.includes("tattoo"));

    if (booking.booking_type !== "consultation" || !isTattoo) {
      return new Response("Only Tattoo consultation records can use this option.", { status: 409 });
    }
    if (booking.status === "cancelled") {
      return new Response("A cancelled consultation cannot be prepared for treatment.", { status: 409 });
    }
if (
  Number(booking.consultation_complete || 0) !== 1 ||
  Number(booking.patch_test_complete || 0) !== 1
) {
  return new Response(
    "The consultation and patch test must be marked complete first.",
    { status: 409 }
  );
}

const hasSelectedTreatment =
  Boolean(booking.package_type) &&
  Number(booking.sessions_total || 0) > 0 &&
  Number(booking.full_price || 0) > 0;

const hasCompletedTreatmentPayment =
  hasSelectedTreatment &&
  (
    Boolean(booking.balance_payment_reference) ||
    (
      booking.payment_status === "paid" &&
      Number(booking.remaining_balance || 0) <= 0.005
    )
  );

if (hasCompletedTreatmentPayment) {
  return new Response(
    "This consultation already has a completed treatment payment.",
    { status: 409 }
  );
}

if (
  booking.package_type &&
  Number(booking.remaining_balance || 0) > 0
) {
  return new Response(
    "A Tattoo treatment option has already been selected for this consultation.",
    { status: 409 }
  );
}
    const sizeLabel = tattooSize === "xl"
      ? "XL"
      : tattooSize.charAt(0).toUpperCase() + tattooSize.slice(1);
    const optionLabel = requestedPackageType === "six_sessions"
      ? "6-Session Package"
      : "Single Session";
    const treatmentName = `${sizeLabel} Tattoo - ${optionLabel}`;

    await env.DB.prepare(`
      UPDATE appointments
      SET
        treatment_category = 'tattoo',
        treatment_name = ?,
        tattoo_size = ?,
        package_type = ?,
        sessions_total = ?,
        sessions_used = 0,
        full_price = ?,
        remaining_balance = ?,
        price_before_discount = ?,
        payment_status = 'deposit_paid',
        package_status = 'pending_payment'
      WHERE id = ?
    `).bind(
      treatmentName,
      tattooSize,
      requestedPackageType,
      selected.sessions,
      selected.full,
      selected.balance,
      selected.full,
      booking.id
    ).run();

    return new Response(JSON.stringify({
      success: true,
      booking_id: booking.id,
      treatment_name: treatmentName,
      tattoo_size: tattooSize,
      package_type: requestedPackageType,
      sessions_total: selected.sessions,
      full_price: selected.full,
      consultation_deduction: 30,
      remaining_balance: selected.balance
    }), { headers: jsonHeaders });
  } catch (error) {
    await sendErrorAlert(env, "Prepare Tattoo treatment error", error.stack || error.message || error);
    return new Response(error.message || "The Tattoo treatment option could not be prepared.", { status: 500 });
  }
}

if (
  request.method === "POST" &&
  url.searchParams.get("admin") === "create-treatment-from-consultation"
) {
  try {
    const body = await request.json();
    const consultationId = Number(body.consultation_id);

    if (!Number.isInteger(consultationId) || consultationId <= 0) {
      return new Response("Invalid consultation ID.", { status: 400 });
    }

    const booking = await env.DB.prepare(`
      SELECT * FROM appointments WHERE id = ?
    `).bind(consultationId).first();

    if (!booking) return new Response("Consultation not found.", { status: 404 });

    const category = String(booking.treatment_category || "").toLowerCase();
    if (booking.booking_type !== "consultation" || !["tattoo", "carbon", "fungal"].includes(category)) {
      return new Response("Only Tattoo, Carbon or Fungal consultation records can be prepared for treatment.", { status: 409 });
    }
    if (booking.status === "cancelled") {
      return new Response("A cancelled consultation cannot be booked for treatment.", { status: 409 });
    }
    if (Number(booking.consultation_complete || 0) !== 1 || Number(booking.patch_test_complete || 0) !== 1) {
      return new Response("The consultation and patch test must be marked complete first.", { status: 409 });
    }
    if (booking.payment_status !== "paid" || Number(booking.remaining_balance || 0) > 0.005) {
      return new Response("The remaining treatment balance must be paid before booking treatment.", { status: 409 });
    }

    const sessionsTotal = Math.max(1, Number(booking.sessions_total || 1));
    const existing = await env.DB.prepare(`
      SELECT id FROM treatment_sessions WHERE appointment_id = ? LIMIT 1
    `).bind(booking.id).first();

    if (!existing) {
      for (let i = 1; i <= sessionsTotal; i++) {
        await env.DB.prepare(`
          INSERT INTO treatment_sessions
          (appointment_id, session_number, appointment_date, appointment_time, status, reschedule_token)
          VALUES (?, ?, NULL, NULL, 'pending', ?)
        `).bind(booking.id, i, crypto.randomUUID()).run();
      }
    }

    await env.DB.prepare(`
      UPDATE appointments
      SET package_status = 'active'
      WHERE id = ?
    `).bind(booking.id).run();

    const firstSession = await env.DB.prepare(`
      SELECT id, appointment_id, session_number, status, reschedule_token
      FROM treatment_sessions
      WHERE appointment_id = ?
      ORDER BY session_number ASC
      LIMIT 1
    `).bind(booking.id).first();

    return new Response(JSON.stringify({
      success: true,
      booking_id: booking.id,
      client_name: booking.client_name,
      treatment_name: booking.treatment_name,
      session: firstSession
    }), { headers: jsonHeaders });
  } catch (error) {
    await sendErrorAlert(env, "Prepare treatment booking error", error.stack || error.message || error);
    return new Response(error.message || "Treatment booking could not be prepared.", { status: 500 });
  }
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
  const id = Number(body.id);
  const amountPaid = Number(body.amount_paid || 0);

  if (!Number.isInteger(id) || id <= 0) {
    return new Response("Missing or invalid booking ID", { status: 400 });
  }

  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    return new Response("Invalid payment amount", { status: 400 });
  }

  const booking = await env.DB.prepare(`
    SELECT
      id,
      booking_type,
      treatment_category,
      full_price,
      amount_paid,
      remaining_balance,
      discount_amount
    FROM appointments
    WHERE id = ?
  `).bind(id).first();

  if (!booking) {
    return new Response("Booking not found", { status: 404 });
  }

  const category = String(
    booking.treatment_category || ""
  ).toLowerCase();

  if (
    !["consultation", "treatment"].includes(booking.booking_type) ||
    !["tattoo", "carbon", "fungal"].includes(category)
  ) {
    return new Response(
      "Manual balance payment is only available for treatment packages.",
      { status: 409 }
    );
  }

  const currentPaid = Number(booking.amount_paid || 0);
  const fullPrice = Number(booking.full_price || 0);
  const discountAmount = Number(booking.discount_amount || 0);
  const calculatedOutstanding = Math.max(
    0,
    fullPrice - currentPaid - discountAmount
  );
  const storedOutstanding = Number(booking.remaining_balance || 0);
  const outstanding =
    Number.isFinite(storedOutstanding) && storedOutstanding >= 0
      ? Math.min(calculatedOutstanding, storedOutstanding)
      : calculatedOutstanding;

  const paymentToAdd =
    amountPaid > 0
      ? Math.min(amountPaid, outstanding)
      : outstanding;

  const newAmountPaid =
    currentPaid + Math.max(0, paymentToAdd);

  const newRemainingBalance = Math.max(
    0,
    fullPrice - newAmountPaid - discountAmount
  );

  const newPaymentStatus =
    newRemainingBalance <= 0.005
      ? "paid"
      : newAmountPaid > 0
        ? "deposit_paid"
        : "unpaid";

  await env.DB.prepare(`
    UPDATE appointments
    SET
      payment_status = ?,
      amount_paid = ?,
      remaining_balance = ?
    WHERE id = ?
      AND booking_type IN ('consultation', 'treatment')
  `).bind(
    newPaymentStatus,
    newAmountPaid,
    newRemainingBalance,
    id
  ).run();

  return new Response(JSON.stringify({
    success: true,
    amount_paid: newAmountPaid,
    discount_amount: discountAmount,
    remaining_balance: newRemainingBalance,
    payment_status: newPaymentStatus
  }), {
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
      `SELECT id, client_name, email, phone, appointment_date, appointment_time, status, booking_type, treatment_category, treatment_name, sessions_total
   FROM appointments
   WHERE id = ? AND reschedule_token = ?`
    ).bind(id, token).first();

    if (!booking) {
      return new Response("Booking not found", { status: 404 });
    }

    // Always return linked treatment sessions for rescheduling too.
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

    const clash = await isClinicSlotOccupied(
      appointment_date,
      appointment_time,
      bookingType,
      env,
      Number(id)
    );

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

  const clash = await isClinicSlotOccupied(
  appointment_date,
  appointment_time,
  "treatment",
  env,
  Number(session.appointment_id)
);

if (clash) {
  return new Response(
    "That slot is already taken",
    { status: 409 }
  );
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

  const clash = await isClinicSlotOccupied(
  appointment_date,
  appointment_time,
  "treatment",
  env,
  Number(session.appointment_id)
);

if (clash) {
  return new Response(
    "That slot is already taken",
    { status: 409 }
  );
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

    const occupiedClinicTimes = await getOccupiedClinicTimes(
      date,
      env
    );

    const availableSlots = allSlots.filter(slot => {
      const overlapsExistingBooking = occupiedClinicTimes.some(item =>
        appointmentTimesOverlap(
          slot,
          bookingType,
          item.time,
          item.type
        )
      );

      return (
        !overlapsExistingBooking &&
        !isPastSlot(date, slot)
      );
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
    let treatmentName = body.treatment_name || null;

let amountPaid = Number(body.amount_paid || 0);
const paymentReference = body.payment_reference || null;

const depositOnly = body.deposit_only === true;
let fullPrice = Number(body.full_price || 0);

const consultationPackages = {
  carbon: {
    single_session: { fullPrice: 85, sessionsTotal: 1, treatmentName: "Single Carbon Facial" },
    three_sessions: { fullPrice: 225, sessionsTotal: 3, treatmentName: "Course of 3 Carbon Facials" },
    "3_sessions": { fullPrice: 225, sessionsTotal: 3, treatmentName: "Course of 3 Carbon Facials" }
  },
  fungal: {
    single_nail: { fullPrice: 45, sessionsTotal: 1, treatmentName: "Single Nail" },
    one_foot: { fullPrice: 85, sessionsTotal: 1, treatmentName: "One Foot (Up to 5 Nails)" },
    both_feet: { fullPrice: 120, sessionsTotal: 1, treatmentName: "Both Feet" },
    course4_one_foot: { fullPrice: 300, sessionsTotal: 4, treatmentName: "Course of 4 Sessions (One Foot)" },
    course4_both_feet: { fullPrice: 420, sessionsTotal: 4, treatmentName: "Course of 4 Sessions (Both Feet)" }
  }
};

const selectedConsultationPackage = consultationPackages[
  String(treatmentCategory || "").toLowerCase()
]?.[String(packageType || "").toLowerCase()];

if (bookingType === "consultation" && selectedConsultationPackage) {
  fullPrice = selectedConsultationPackage.fullPrice;
  treatmentName = treatmentName || selectedConsultationPackage.treatmentName;
}

let couponCode = null;
let discountAmount = 0;
let priceBeforeDiscount = amountPaid;

if (paymentReference?.startsWith("cs_")) {
  try {
    const existingPayment = await env.DB.prepare(`
      SELECT id
      FROM appointments
      WHERE payment_reference = ?
      LIMIT 1
    `).bind(paymentReference).first();

    if (existingPayment) {
      return new Response(
        "This payment has already been used for a booking.",
        { status: 409 }
      );
    }

    const stripe = await getStripeCheckout(paymentReference, env);

    if (!stripe) {
      return new Response("Stripe payment could not be verified.", {
        status: 400
      });
    }

    if (
      stripe.payment_status !== "paid" ||
      stripe.status !== "complete"
    ) {
      return new Response("Stripe payment is not complete.", {
        status: 400
      });
    }

    if (stripe.currency && stripe.currency !== "gbp") {
      return new Response("Unexpected payment currency.", {
        status: 400
      });
    }

    amountPaid = Number(stripe.amount_total || 0) / 100;

    priceBeforeDiscount =
      Number(
        stripe.amount_subtotal ||
        stripe.amount_total ||
        0
      ) / 100;

    const stripeDiscount = await getStripeDiscountDetails(
  stripe,
  env
);

discountAmount = stripeDiscount.discountAmount;
couponCode = stripeDiscount.couponCode;

  } catch (stripeError) {
    await sendErrorAlert(
      env,
      "Stripe payment verification error",
      stripeError.stack || stripeError.message || stripeError
    );

    return new Response(
      "Payment could not be verified. Please contact BARE by Marlese.",
      { status: 400 }
    );
  }
}

const totalPaymentCredit =
  Number(amountPaid || 0) +
  Number(discountAmount || 0);

const remainingBalance = Number(
  body.remaining_balance !== undefined
    ? body.remaining_balance
    : Math.max(0, fullPrice - totalPaymentCredit)
);

    let paymentStatus = "unpaid";
    let paymentType = null;
    let sessionsTotal = 0;
    let sessionsUsed = 0;
    let packageStatus = "none";

    if (bookingType === "consultation") {
      const consultationCredit =
        Number(amountPaid || 0) +
        Number(discountAmount || 0);

      if (consultationCredit > 0) {
        paymentStatus = "deposit_paid";
        paymentType = "consultation_deposit";
      }

      if (selectedConsultationPackage) {
        sessionsTotal = selectedConsultationPackage.sessionsTotal;
        sessionsUsed = 0;
        packageStatus = "active";
      }
    }

if (bookingType === "treatment") {
  paymentType = depositOnly
    ? "treatment_deposit"
    : "treatment_payment";

  const sessionTotalsByPackage = {
    single_session: 1,

    three_sessions: 3,
    "3_sessions": 3,

    "4_sessions": 4,

    six_sessions: 6,
    "6_sessions": 6,

    single_nail: 1,
    one_foot: 1,
    both_feet: 1,

    course4_one_foot: 4,
    course4_both_feet: 4
  };

  sessionsTotal =
    sessionTotalsByPackage[packageType] || 0;

  if (sessionsTotal > 0) {
    packageStatus = "active";
  }

  if (depositOnly) {
    paymentStatus =
      amountPaid >= 30
        ? "deposit_paid"
        : "unpaid";
  } else {
    paymentStatus =
      amountPaid > 0
        ? "paid"
        : "unpaid";
  }
}

    const packageDisplay = packageType
  ? packageType.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase())
  : null;

const displayAmount = Number(amountPaid).toFixed(2);

const priceDisplay = amountPaid
  ? `£${displayAmount}`
  : null;

const fullPriceDisplay = fullPrice > 0
  ? `£${Number(fullPrice).toFixed(2)}`
  : null;

const remainingBalanceDisplay = depositOnly
  ? `£${Math.max(0, remainingBalance).toFixed(2)}`
  : null;

const isDepositTreatment =
  bookingType === "treatment" &&
  depositOnly &&
  (
    treatmentCategory === "carbon" ||
    treatmentCategory === "fungal"
  );

    if (bookingType === "treatment") {
      const normalisedEmail = String(email || "").trim().toLowerCase();
      const normalisedCategory = String(treatmentCategory || "tattoo").trim().toLowerCase();

      if (!normalisedEmail) {
        return new Response("An email address is required to verify your consultation and patch test.", { status: 400 });
      }

      const approvedConsultation = await env.DB.prepare(`
        SELECT id
        FROM appointments
        WHERE booking_type = 'consultation'
          AND LOWER(TRIM(email)) = ?
          AND status = 'confirmed'
          AND COALESCE(consultation_complete, 0) = 1
          AND COALESCE(patch_test_complete, 0) = 1
          AND (
            LOWER(COALESCE(treatment_category, 'tattoo')) = ?
            OR treatment_category IS NULL
          )
        ORDER BY appointment_date DESC, appointment_time DESC
        LIMIT 1
      `).bind(normalisedEmail, normalisedCategory).first();

      if (!approvedConsultation) {
        return new Response(
          "Treatment booking is locked until your consultation and patch test have been completed and approved. Please use the same email address used for your consultation.",
          { status: 403 }
        );
      }
    }

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

    const slotOccupied = await isClinicSlotOccupied(
      appointmentDate,
      appointmentTime,
      bookingType,
      env
    );

    if (slotOccupied) {
      return new Response("Slot already taken", { status: 409 });
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
    treatment_name,
    full_price,
    remaining_balance,
    coupon_code,
    discount_amount,
    price_before_discount,
    consultation_complete,
    patch_test_complete
  )
  VALUES (
    ?, ?, ?, ?, ?,
    'confirmed',
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, 0, 0
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
  treatmentName,
  fullPrice,
  remainingBalance,
  couponCode,
  discountAmount,
  priceBeforeDiscount
)
.run();

      const bookingId = insertResult.meta.last_row_id;

let firstSessionId = null;
let firstSessionToken = null;

if (bookingType === "treatment" && sessionsTotal >= 1) {
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
        subject: isDepositTreatment
  ? `New ${treatmentName || "consultation and treatment"} booking`
  : bookingType === "treatment"
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
      ${fullPriceDisplay
  ? `<p><strong>Full Price:</strong> ${escapeHtml(fullPriceDisplay)}</p>`
  : ""
}

${priceDisplay
  ? `<p><strong>Amount Paid:</strong> ${escapeHtml(priceDisplay)}</p>`
  : ""
}

${remainingBalanceDisplay
  ? `<p><strong>Remaining on the day:</strong> ${escapeHtml(remainingBalanceDisplay)}</p>`
  : ""
}

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
          subject: isDepositTreatment
  ? `${treatmentName || "Consultation & Treatment"} Confirmed – BARE by Marlese`
  : bookingType === "treatment"
    ? "Treatment Booking Confirmed – BARE by Marlese"
    : "Consultation & Patch Test Confirmed – BARE by Marlese",
          html: `
<div style="background:#cacdc6;padding:30px 15px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;color:#24221a;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
    <div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:.12em;color:#5e6959;">
      BARE | <span style="font-weight:400;color:#878274;">by Marlese</span>
    </div>
    <div style="text-align:center;margin-top:6px;margin-bottom:18px;font-size:11px;letter-spacing:.18em;color:#878274;">
      ${isDepositTreatment
  ? "CONSULTATION & TREATMENT CONFIRMED"
  : bookingType === "treatment"
    ? "TREATMENT BOOKING CONFIRMED"
    : "CONSULTATION & PATCH TEST CONFIRMED"
}
    </div>
    <p>Hi ${safeName},</p>
    ${isDepositTreatment
  ? `
    <p>
      Thank you for booking with
      <strong>BARE by Marlese</strong>.
      Your one-hour consultation and treatment appointment
      has been confirmed.
    </p>

    <p>
      Your suitability will be assessed at the start of the
      appointment. If treatment is suitable, it will follow
      during the same booking.
    </p>
  `
  : bookingType === "treatment"
    ? `
      <p>
        Thank you for booking with
        <strong>BARE by Marlese</strong>.
        Your treatment appointment has been confirmed.
      </p>
    `
    : `
      <p>
        Thank you for completing your consultation form and
        booking your consultation & patch test with
        <strong>BARE by Marlese</strong>.
      </p>

      <p>
        Your consultation and patch test is confirmed for
        <strong>${safeDate}</strong> at
        <strong>${safeTime}</strong>.
      </p>

      <p>
        Your details have been received and will be reviewed
        thoroughly before your appointment.
      </p>
    `
}
    <div style="background:#f4f5f3;border-radius:10px;padding:16px;margin:18px 0;">
      <p style="margin:0 0 8px;"><strong>Appointment summary</strong></p>
      ${treatmentName
  ? `<p><strong>Treatment:</strong> ${escapeHtml(treatmentName)}</p>`
  : packageDisplay
    ? `<p><strong>Package:</strong> ${escapeHtml(packageDisplay)} Tattoo Removal</p>`
    : ""
}
      ${fullPriceDisplay
  ? `<p><strong>Full Price:</strong> ${escapeHtml(fullPriceDisplay)}</p>`
  : ""
}

${priceDisplay
  ? `<p><strong>Deposit Paid:</strong> ${escapeHtml(priceDisplay)}</p>`
  : ""
}

${remainingBalanceDisplay
  ? `<p><strong>Remaining on the day:</strong> ${escapeHtml(remainingBalanceDisplay)}</p>`
  : ""
}

${bookingType === "treatment"
  ? `<p><strong>Sessions:</strong> ${safeSessions}</p>`
  : ""
}
      <p><strong>Date:</strong> ${safeDate}</p>
      <p><strong>Time:</strong> ${safeTime}</p>
      <p><strong>Phone:</strong> ${safePhone}</p>
    </div>
    ${isDepositTreatment
  ? `
    <p>
      Your £30 deposit has been deducted from the selected
      treatment or package. The remaining balance of
      <strong>${escapeHtml(remainingBalanceDisplay || "£0.00")}</strong>
      is payable on the day.
    </p>

    ${sessionsTotal > 1
      ? `
        <p>
          This booking is for session 1 of ${sessionsTotal}.
          Your remaining sessions can be arranged after your
          first appointment.
        </p>
      `
      : ""
    }
  `
  : bookingType === "treatment"
    ? `
      <p>
        Your first treatment session has been booked.
        If you purchased a treatment package, your remaining
        sessions can be arranged after your first appointment.
      </p>
    `
    : `
      <p>
        Your £30 deposit will be deducted from your treatment cost.
      </p>
    `
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
        sessions_used: sessionsUsed,
        deposit_only: depositOnly,
        full_price: fullPrice,
        remaining_balance: remainingBalance,
        amount_paid: amountPaid,
        coupon_code: couponCode,
        discount_amount: discountAmount,
        price_before_discount: priceBeforeDiscount
      }), {
        status: 200,
        headers: jsonHeaders
      });

    } catch (e) {
      await sendErrorAlert(
        env,
        "New booking error",
        e.stack || e.message || e
      );

      const errorMessage = String(
        e?.message || e || ""
      ).toLowerCase();

      const isSlotConflict =
        errorMessage.includes("unique constraint failed") ||
        errorMessage.includes("constraint failed") ||
        errorMessage.includes("slot already taken");

      return new Response(
        isSlotConflict
          ? "Slot already taken"
          : "The booking could not be completed. Please try again.",
        { status: isSlotConflict ? 409 : 500 }
      );
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
