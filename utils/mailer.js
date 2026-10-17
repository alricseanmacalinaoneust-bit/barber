const nodemailer = require("nodemailer");

const smtpConfigured = Boolean(
  process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
);

const transporter = smtpConfigured
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  })
  : null;

async function send2FA(email, code) {
  if (!transporter) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP is not configured.");
    }

    // Local testing without SMTP: show the code in the server terminal.
    console.log(`[2FA] Verification code for ${email}: ${code}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: "Barbershop Admin Login Verification Code",
    text: `Your Barbershop verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<h2>Barbershop Login Verification</h2>
           <p>Your verification code is:</p>
           <h1 style="letter-spacing:6px">${code}</h1>
           <p>This code expires in 10 minutes.</p>`
  });
}

module.exports = { send2FA };
