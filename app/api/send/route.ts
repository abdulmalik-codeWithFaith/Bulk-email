import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PER_REQUEST = 50;
const CONCURRENCY = 3;

type Recipient = { email: string; name?: string };
type Result = { email: string; ok: boolean; error?: string };

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeEqual(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

function personalize(text: string, name?: string) {
  return text.replace(/\{\{\s*name\s*\}\}/gi, name?.trim() || "there");
}

// Reuse one pooled SMTP connection set across requests.
let transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE
        ? process.env.SMTP_SECURE === "true"
        : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,
      maxConnections: CONCURRENCY,
      maxMessages: 100,
    });
  }
  return transporter;
}

export async function POST(req: NextRequest) {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM, ACCESS_KEY } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !ACCESS_KEY) {
    return NextResponse.json(
      { error: "Server is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM and ACCESS_KEY." },
      { status: 500 }
    );
  }

  if (!safeEqual(req.headers.get("x-access-key") ?? "", ACCESS_KEY)) {
    return NextResponse.json({ error: "Wrong access key." }, { status: 401 });
  }

  let body: { subject?: string; body?: string; recipients?: Recipient[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const subject = (body.subject ?? "").trim();
  const message = (body.body ?? "").trim();
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];

  if (!subject || subject.length > 200) {
    return NextResponse.json({ error: "Subject is required (max 200 characters)." }, { status: 400 });
  }
  if (!message || message.length > 20000) {
    return NextResponse.json({ error: "Message is required (max 20,000 characters)." }, { status: 400 });
  }
  if (recipients.length === 0 || recipients.length > MAX_PER_REQUEST) {
    return NextResponse.json(
      { error: `Send between 1 and ${MAX_PER_REQUEST} recipients per request.` },
      { status: 400 }
    );
  }

  const valid = recipients.filter((r) => typeof r?.email === "string" && EMAIL_RE.test(r.email.trim()));
  const invalid = recipients.filter((r) => !valid.includes(r)).map((r) => String(r?.email ?? ""));

  const unsubscribe = process.env.UNSUBSCRIBE_EMAIL;
  const address = process.env.FOOTER_ADDRESS;
  const footerText =
    "You are receiving this because you are on our contact list. " +
    (unsubscribe
      ? `To unsubscribe, reply with "unsubscribe" or write to ${unsubscribe}.`
      : 'To unsubscribe, reply with "unsubscribe".') +
    (address ? `\n${address}` : "");

  const results: Result[] = invalid.map((email) => ({
    email,
    ok: false,
    error: "Invalid email address",
  }));

  const t = getTransporter();

  async function sendOne(r: Recipient): Promise<Result> {
    const to = r.email.trim();
    const personalBody = personalize(message, r.name);
    const text = `${personalBody}\n\n--\n${footerText}`;
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">` +
      `${escapeHtml(personalBody).replace(/\n/g, "<br>")}` +
      `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">` +
      `<p style="font-size:12px;color:#777">${escapeHtml(footerText).replace(/\n/g, "<br>")}</p>` +
      `</div>`;
    try {
      await t.sendMail({
        from: EMAIL_FROM,
        to,
        subject: personalize(subject, r.name),
        text,
        html,
        replyTo: process.env.REPLY_TO || undefined,
        headers: unsubscribe
          ? { "List-Unsubscribe": `<mailto:${unsubscribe}?subject=unsubscribe>` }
          : undefined,
      });
      return { email: to, ok: true };
    } catch (e) {
      return { email: to, ok: false, error: e instanceof Error ? e.message : "Send failed" };
    }
  }

  // Send a few at a time through the pooled connection.
  for (let i = 0; i < valid.length; i += CONCURRENCY) {
    const chunk = valid.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(sendOne))));
  }

  return NextResponse.json({ results });
}