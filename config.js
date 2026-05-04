window.SITE_CONFIG = window.SITE_CONFIG || {};

Object.assign(window.SITE_CONFIG, {
  businessName: "BARE by Marlese",
  ownerName: "Marlese",
  currency: "£",

  domain: "https://barebymarlese.com",
  
  consultationWorkerUrl: "https://bare-consultation-worker.barebymarlese.workers.dev",

  brandMain: "BARE",
  brandSub: "by Marlese",

  homepage: {
    brandTop: "VTCT Level 5 Certified",
    brandMainFull: "Laser Tattoo Removal Specialist",
    brandLocation: "South Oxfordshire<br>Henley • Wallingford • Didcot",
    footerText: "Specialist Laser Tattoo Removal Clinic | Henley-on-Thames • Wallingford • Didcot • Oxfordshire"
  },

  logo: "/logov4.png",
  favicon: "/faviconv4.png",
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

 pages: {
  bookingTitle: "Book Consultation & Patch Test",
  adminTitle: "Bookings Admin",
  cancelTitle: "Cancel Appointment",
  depositTitle: "Consultation Deposit",
  consultationTitle: "Consultation Form"
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

  packages: [
    { key:"tiny", name:"Tiny Tattoo", bundlePrice:"£360", fullPrice:"£390", singlePrice:"£70", bundleAmount:36000, fullAmount:39000, singleAmount:7000 },
    { key:"small", name:"Small Tattoo", bundlePrice:"£495", fullPrice:"£525", singlePrice:"£95", bundleAmount:49500, fullAmount:52500, singleAmount:9500 },
    { key:"medium", name:"Medium Tattoo", bundlePrice:"£620", fullPrice:"£650", singlePrice:"£120", bundleAmount:62000, fullAmount:65000, singleAmount:12000 },
    { key:"large", name:"Large Tattoo", bundlePrice:"£820", fullPrice:"£850", singlePrice:"£160", bundleAmount:82000, fullAmount:85000, singleAmount:16000 },
    { key:"xl", name:"XL Tattoo", bundlePrice:"£1050", fullPrice:"£1080", singlePrice:"£200", bundleAmount:105000, fullAmount:108000, singleAmount:20000 }
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
