"use client";

import { useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import readXlsxFile from "read-excel-file";

const MAX_CONTACTS = 500;
const BATCH_SIZE = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Status = "pending" | "sent" | "failed";
type Contact = {
  email: string;
  name: string;
  phone: string;
  status: Status;
  error?: string;
};

const isValid = (email: string) => EMAIL_RE.test(email);

// Zoho Forms exports vary ("Email", "Name (First Name)", "Phone"...), so match headers loosely.
function pick(row: Record<string, string>, test: (h: string) => boolean) {
  const keys = Object.keys(row).filter((k) => test(k.toLowerCase()));
  return keys
    .map((k) => (row[k] ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export default function Page() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [notice, setNotice] = useState("");
  const [manual, setManual] = useState({ name: "", email: "", phone: "" });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const validContacts = contacts.filter((c) => isValid(c.email));
  const invalidCount = contacts.length - validContacts.length;
  const toSend = validContacts.filter((c) => c.status !== "sent");
  const sentCount = contacts.filter((c) => c.status === "sent").length;
  const failedCount = contacts.filter((c) => c.status === "failed").length;
  const attempted = sentCount + failedCount;
  const hasFailures = failedCount > 0;

  const progress = useMemo(
    () => (validContacts.length ? Math.round((attempted / validContacts.length) * 100) : 0),
    [attempted, validContacts.length]
  );

  function merge(incoming: Omit<Contact, "status">[]) {
    const seen = new Set(contacts.map((c) => c.email.toLowerCase()));
    const added: Contact[] = [];
    let dupes = 0;
    let overflow = 0;
    for (const c of incoming) {
      const key = c.email.toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        dupes++;
        continue;
      }
      if (contacts.length + added.length >= MAX_CONTACTS) {
        overflow++;
        continue;
      }
      seen.add(key);
      added.push({ ...c, status: "pending" });
    }
    setContacts((prev) => [...prev, ...added]);
    const parts = [`Added ${added.length}`];
    if (dupes) parts.push(`${dupes} duplicate${dupes > 1 ? "s" : ""} skipped`);
    if (overflow) parts.push(`${overflow} skipped (limit is ${MAX_CONTACTS})`);
    setNotice(parts.join(" · "));
  }

  function importRows(data: Record<string, string>[]) {
    const rows = data.map((row) => ({
      email: pick(row, (h) => h.includes("email") || h.includes("e-mail")),
      name: pick(row, (h) => h.includes("name")),
      phone: pick(row, (h) => h.includes("phone") || h.includes("mobile")),
    }));
    if (!rows.some((r) => r.email)) {
      setNotice("No email column found. Make sure the first row has a header like “Email”.");
    } else {
      merge(rows);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const done = () => {
      if (fileRef.current) fileRef.current.value = "";
    };

    if (/\.xlsx$/i.test(file.name)) {
      try {
        const sheet = await readXlsxFile(file); // first sheet
        const [header, ...rest] = sheet;
        const keys = (header ?? []).map((h) => String(h ?? "").trim());
        const data = rest.map((cells) => {
          const obj: Record<string, string> = {};
          keys.forEach((k, i) => {
            if (k) obj[k] = cells[i] == null ? "" : String(cells[i]);
          });
          return obj;
        });
        importRows(data);
      } catch {
        setNotice("Could not read that Excel file. Save it as .xlsx (or export as CSV) and try again.");
      }
      return done();
    }

    if (/\.xls$/i.test(file.name)) {
      setNotice("Old .xls files are not supported. In Excel choose Save As → .xlsx or CSV.");
      return done();
    }

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        importRows(res.data);
        done();
      },
      error: () => setNotice("Could not read that file."),
    });
  }

  function addManual(e: React.FormEvent) {
    e.preventDefault();
    const email = manual.email.trim();
    if (!email) return;
    merge([{ email, name: manual.name.trim(), phone: manual.phone.trim() }]);
    setManual({ name: "", email: "", phone: "" });
  }

  const remove = (email: string) => setContacts((prev) => prev.filter((c) => c.email !== email));
  const removeInvalid = () => setContacts((prev) => prev.filter((c) => isValid(c.email)));
  const clearAll = () => {
    if (window.confirm("Remove all contacts?")) {
      setContacts([]);
      setNotice("");
    }
  };

  async function send() {
    setSendError("");
    if (!subject.trim() || !body.trim()) return setSendError("Please write a subject and a message.");
    if (!accessKey) return setSendError("Enter the access key.");
    if (toSend.length === 0) return setSendError("No valid recipients left to send to.");
    if (!window.confirm(`Send this email to ${toSend.length} recipient${toSend.length > 1 ? "s" : ""}?`)) return;

    setSending(true);
    for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
      const batch = toSend.slice(i, i + BATCH_SIZE);
      let results: { email: string; ok: boolean; error?: string }[];
      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-access-key": accessKey },
          body: JSON.stringify({
            subject,
            body,
            recipients: batch.map((c) => ({ email: c.email, name: c.name })),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setSendError(data.error || "Sending failed.");
          if (res.status === 401 || res.status === 500) break; // no point continuing
          results = batch.map((c) => ({ email: c.email, ok: false, error: data.error }));
        } else {
          results = data.results;
        }
      } catch {
        results = batch.map((c) => ({ email: c.email, ok: false, error: "Network error" }));
      }
      const map = new Map(results.map((r) => [r.email.toLowerCase(), r]));
      setContacts((prev) =>
        prev.map((c) => {
          const r = map.get(c.email.toLowerCase());
          if (!r) return c;
          return r.ok
            ? { ...c, status: "sent", error: undefined }
            : { ...c, status: "failed", error: r.error };
        })
      );
    }
    setSending(false);
  }

  const input =
    "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
  const btn =
    "rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">Bulk Email Sender</h1>
        <p className="text-sm text-slate-600">
          Import a CSV, add people, write your message, send. Up to {MAX_CONTACTS} contacts.
        </p>
      </header>

      {/* 1. Contacts */}
      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="font-medium">1. Contacts</h2>

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-indigo-700"
          />
          <span className="text-xs text-slate-500">CSV or Excel (.xlsx) with columns for name, email, phone</span>
        </div>

        <form onSubmit={addManual} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <input
            className={input}
            placeholder="Name"
            value={manual.name}
            onChange={(e) => setManual({ ...manual, name: e.target.value })}
          />
          <input
            className={input}
            placeholder="Email"
            type="email"
            required
            value={manual.email}
            onChange={(e) => setManual({ ...manual, email: e.target.value })}
          />
          <input
            className={input}
            placeholder="Phone"
            value={manual.phone}
            onChange={(e) => setManual({ ...manual, phone: e.target.value })}
          />
          <button className={`${btn} bg-slate-800 text-white hover:bg-slate-900`}>Add person</button>
        </form>

        {notice && <p className="text-sm text-slate-600">{notice}</p>}

        {contacts.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {contacts.length} contact{contacts.length > 1 ? "s" : ""} · {validContacts.length} valid
                {invalidCount > 0 && <span className="text-red-600"> · {invalidCount} invalid</span>}
              </span>
              <span className="flex gap-3">
                {invalidCount > 0 && (
                  <button onClick={removeInvalid} className="text-red-600 hover:underline">
                    Remove invalid
                  </button>
                )}
                <button onClick={clearAll} className="text-slate-500 hover:underline">
                  Clear all
                </button>
              </span>
            </div>

            <div className="max-h-72 overflow-auto rounded-md border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="hidden px-3 py-2 sm:table-cell">Phone</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => {
                    const ok = isValid(c.email);
                    return (
                      <tr key={c.email} className="border-t border-slate-100">
                        <td className="px-3 py-2">{c.name || <span className="text-slate-400">—</span>}</td>
                        <td className={`px-3 py-2 ${ok ? "" : "text-red-600"}`}>{c.email}</td>
                        <td className="hidden px-3 py-2 sm:table-cell">{c.phone}</td>
                        <td className="px-3 py-2">
                          {!ok ? (
                            <span className="text-red-600">Invalid</span>
                          ) : c.status === "sent" ? (
                            <span className="text-green-600">Sent</span>
                          ) : c.status === "failed" ? (
                            <span className="text-red-600" title={c.error}>
                              Failed
                              {c.error && <span className="block max-w-[220px] text-xs">{c.error}</span>}
                            </span>
                          ) : (
                            <span className="text-slate-400">Pending</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => remove(c.email)}
                            className="text-slate-400 hover:text-red-600"
                            aria-label={`Delete ${c.email}`}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* 2. Message */}
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="font-medium">2. Message</h2>
        <input
          className={input}
          placeholder="Subject"
          maxLength={200}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <textarea
          className={`${input} min-h-[180px]`}
          placeholder="Write your message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <p className="text-xs text-slate-500">
          Tip: use <code className="rounded bg-slate-100 px-1">{"{{name}}"}</code> to insert each person’s name. An
          unsubscribe note is added to the bottom of every email automatically.
        </p>
      </section>

      {/* 3. Send */}
      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="font-medium">3. Review &amp; send</h2>

        <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          <Stat label="Recipients" value={validContacts.length} />
          <Stat label="Attempted" value={`${attempted}/${validContacts.length}`} />
          <Stat label="Sent" value={sentCount} color="text-green-600" />
          <Stat label="Failed" value={failedCount} color={failedCount ? "text-red-600" : ""} />
        </div>

        {(sending || attempted > 0) && (
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <input
            className={`${input} sm:max-w-xs`}
            type="password"
            placeholder="Access key"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
          />
          <button
            onClick={send}
            disabled={sending || toSend.length === 0}
            className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}
          >
            {sending
              ? "Sending…"
              : hasFailures
              ? `Retry ${toSend.length} unsent`
              : `Send to ${validContacts.length || 0}`}
          </button>
        </div>

        {sendError && <p className="text-sm text-red-600">{sendError}</p>}
        {!sending && attempted > 0 && failedCount === 0 && sentCount === validContacts.length && (
          <p className="text-sm text-green-700">All emails sent.</p>
        )}
        {!sending && hasFailures && (
          <p className="text-sm text-slate-600">
            Some emails failed. Hover “Failed” in the table to see why, then retry.
          </p>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, color = "" }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}