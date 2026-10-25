import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Bulk Email Sender",
  description: "Import contacts and send an email to all of them.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
