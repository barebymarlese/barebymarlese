window.SITE_CONFIG = window.SITE_CONFIG || {};

Object.assign(window.SITE_CONFIG, {

  businessName: "BARE by Marlese",
  legalName: "BARE BY MARLESE LTD",
  companyNumber: "17311204",
  registeredIn: "Registered in England and Wales",
  ownerName: "Marlese",
  domain: "https://barebymarlese.com",
  apiBase: "https://barebymarlese.com",
  consultationWorkerUrl: "https://bare-consultation-worker.barebymarlese.workers.dev",
  currency: "£",

  analytics: {
  ga4MeasurementId: "G-CFX28N49FM"
},

  brandMain: "BARE",
  brandSub: "by Marlese",

  logo: "/logov4.png",
  favicon: "/favicon.png",
  qrCode: "/assets/qr_treatment.png",

  colours: {
    bg: "#cacdc6",
    ink: "#24221a",
    olive: "#5e6959",
    oliveDark: "#4f5a4b",
    stone: "#878274",
    card: "#f8f8f6"
  },

  brandStyle: {
    mainLetterSpacing: ".26em",
    subLetterSpacing: ".05em",
    mainFontSize: "24px",
    subFontSize: "15px",
    mainWeight: "600",
    subWeight: "500"
  },

  homepage: {
    brandTop: "VTCT Level 5 Certified",
    brandMainFull: "Laser Tattoo Removal Specialist",
    brandLocation: "South Oxfordshire<br>Henley • Wallingford • Didcot",
    footerText: "Specialist Laser Tattoo Removal Clinic | Henley-on-Thames • Wallingford • Didcot • Oxfordshire"
  },

  pages: {
    bookingTitle: "Book Consultation & Patch Test",
    adminTitle: "Bookings Admin",
    cancelTitle: "Cancel Appointment",
    depositTitle: "Consultation Deposit",
    consultationTitle: "Consultation Form",
    treatmentTitle: "Treatment Packages",
    treatmentBookingTitle: "Treatment Booking",
    rescheduleTitle: "Reschedule Appointment"
  },

  contact: {
    email: "marlese@barebymarlese.com",
    phone: "+447404127830",
    instagram: "https://www.instagram.com/barebymarlese"
  },

  deposit: {
    label: "Consultation Deposit",
    heading: "Secure Your Consultation",
    amount: "£30",
    amountPence: 3000,
    stripeLink: "https://book.stripe.com/5kQ00l5HY6L1frj9ie8g000"
  },

  stripeLinks: {
    bundle_full: {
      tiny: "https://buy.stripe.com/bJe00lb2i6L13IBdyu8g001",
      small: "https://buy.stripe.com/14A3cx7Q64CT5QJgKG8g002",
      medium: "https://buy.stripe.com/9B6aEZ9Yeedt3IB7a68g003",
      large: "https://buy.stripe.com/6oUfZjeeu6L1djb8ea8g004",
      xl: "https://buy.stripe.com/7sYbJ33zQ7P55QJ0LI8g005"
    },
    bundle_deducted: {
      tiny: "https://buy.stripe.com/28EfZj3zQc5l92Vami8g00a",
      small: "https://buy.stripe.com/9B6aEZ6M2d9penf6628g009",
      medium: "https://buy.stripe.com/bJe6oJeeu0mDcf72TQ8g008",
      large: "https://buy.stripe.com/fZu6oJ7Q69Xd92VgKG8g007",
      xl: "https://buy.stripe.com/cNi00lgmCedt7YR51Y8g006"
    },
    single: {
      tiny: "https://buy.stripe.com/cNi6oJ2vM3yP6UN0LI8g00f",
      small: "https://buy.stripe.com/9B64gBb2i6L16UN3XU8g00e",
      medium: "https://buy.stripe.com/dRm28t8Uad9pfrj8ea8g00d",
      large: "https://buy.stripe.com/8x23cx1rI8T9gvn2TQ8g00c",
      xl: "https://buy.stripe.com/eVq5kFeeuedtgvn8ea8g00b"
    }
  },

stripeLinksCarbon: {
  carbon_single: "https://buy.stripe.com/fZu9AVgmC3yP0wp0LI8g00v",
  carbon_course3: "https://buy.stripe.com/bJe7sN0nE5GX3IB9ie8g00w",
  fungal_single_nail: "https://buy.stripe.com/3cIdRbfiy0mD7YR3XU8g00x",
  fungal_one_foot: "https://buy.stripe.com/5kQdRb0nE5GX4MF0LI8g00y",
  fungal_both_feet: "https://buy.stripe.com/7sY00lfiy2uL2Exbqm8g00z",
  fungal_course4_one_foot: "https://buy.stripe.com/4gM9AVgmC1qH6UN0LI8g00A",
  fungal_course4_both_feet: "https://buy.stripe.com/dRmbJ39Ye7P54MF51Y8g00B"
},

  packages: [
  { key:"tiny", name:"Tiny Tattoo", bundlePrice:"\u00A3330", fullPrice:"\u00A3360", singlePrice:"\u00A370", bundleAmount:33000, fullAmount:36000, singleAmount:7000 },
  { key:"small", name:"Small Tattoo", bundlePrice:"\u00A3465", fullPrice:"\u00A3495", singlePrice:"\u00A395", bundleAmount:46500, fullAmount:49500, singleAmount:9500 },
  { key:"medium", name:"Medium Tattoo", bundlePrice:"\u00A3590", fullPrice:"\u00A3620", singlePrice:"\u00A3120", bundleAmount:59000, fullAmount:62000, singleAmount:12000 },
  { key:"large", name:"Large Tattoo", bundlePrice:"\u00A3790", fullPrice:"\u00A3820", singlePrice:"\u00A3160", bundleAmount:79000, fullAmount:82000, singleAmount:16000 },
  { key:"xl", name:"XL Tattoo", bundlePrice:"\u00A31020", fullPrice:"\u00A31050", singlePrice:"\u00A3200", bundleAmount:102000, fullAmount:105000, singleAmount:20000 }
],

carbonPackages: [
  { key:"carbon_single", name:"Single Carbon Facial", price:"\u00A385", amount:8500 },
  { key:"carbon_course3", name:"Course of 3 Treatments", price:"\u00A3225", amount:22500 },

  { key:"fungal_single_nail", name:"Single Nail", price:"\u00A345", amount:4500 },
  { key:"fungal_one_foot", name:"One Foot (Up to 5 Nails)", price:"\u00A385", amount:8500 },
  { key:"fungal_both_feet", name:"Both Feet", price:"\u00A3120", amount:12000 },
  { key:"fungal_course4_one_foot", name:"Course of 4 Sessions (One Foot)", price:"\u00A3300", amount:30000 },
  { key:"fungal_course4_both_feet", name:"Course of 4 Sessions (Both Feet)", price:"\u00A3420", amount:42000 }
],
  
  booking: {
    consultationSlots: {
      weekday: ["17:00","17:30","18:00","18:30","19:00"],
      saturday: ["09:00","09:30","10:00","10:30"]
    },
    treatmentSlots: {
      weekday: ["17:00","18:00","19:00"],
      saturday: ["09:00","10:00","11:00"]
    }
  }

});
