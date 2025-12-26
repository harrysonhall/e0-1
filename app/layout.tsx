import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "E01 Parser",
  description: "E01 forensic image parser and viewer",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
