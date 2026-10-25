import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PER_REQUEST = 100; // Resend batch limit

type Recipient = { email: string; name?: string };

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

export async function POST(req: NextRequest) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const accessKey = process.env.ACCESS_KEY;

  if (!apiKey || !from || !accessKey) {
    return NextResponse.json(
      { error: "Server is not configured. Set RESEND_API_KEY, EMAIL_FROM and ACCESS_KEY." },
      { status: 500 }
    );
  }

  if (!safeEqual(req.headers.get("x-access-key") ?? "", accessKey)) {
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
    (unsubscribe ? `To unsubscribe, reply with "unsubscribe" or write to ${unsubscribe}.` : 'To unsubscribe, reply with "unsubscribe".') +
    (address ? `\n${address}` : "");

  const headers: Record<string, string> = {};
  if (unsubscribe) {
    headers["List-Unsubscribe"] = `<mailto:${unsubscribe}?subject=unsubscribe>`;
  }

  const payload = valid.map((r) => {
    const personalBody = personalize(message, r.name);
    const personalSubject = personalize(subject, r.name);
    const text = `${personalBody}\n\n--\n${footerText}`;
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">` +
      `${escapeHtml(personalBody).replace(/\n/g, "<br>")}` +
      `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">` +
      `<p style="font-size:12px;color:#777">${escapeHtml(footerText).replace(/\n/g, "<br>")}</p>` +
      `</div>`;
    return {
      from,
      to: [r.email.trim()],
      subject: personalSubject,
      html,
      text,
      ...(process.env.REPLY_TO ? { replyTo: process.env.REPLY_TO } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  });

  const results: { email: string; ok: boolean; error?: string }[] = invalid.map((email) => ({
    email,
    ok: false,
    error: "Invalid email address",
  }));

  if (payload.length > 0) {
    try {
      const resend = new Resend(apiKey);
      const { error } = await resend.batch.send(payload);
      if (error) {
        for (const r of valid) results.push({ email: r.email, ok: false, error: error.message });
      } else {
        for (const r of valid) results.push({ email: r.email, ok: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unexpected error";
      for (const r of valid) results.push({ email: r.email, ok: false, error: msg });
    }
  }

  return NextResponse.json({ results });
}
