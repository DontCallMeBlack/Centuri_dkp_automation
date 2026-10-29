// app/layout.tsx
import './globals.css';
import type { Metadata } from 'next';
import AppShell from '@/components/AppShell';
import { connection } from 'next/server';
import { Analytics } from '@vercel/analytics/next';

export const metadata: Metadata = {
  title: 'Centuri DKP — Celtic Heroes',
  description: 'Clan DKP Management System for Centuri',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Nonces must be generated per request, never baked into a static page.
  await connection();
  return (
    <html lang="en" className="dark">
      <body className="bg-[#090b12] text-slate-100 antialiased min-h-screen selection:bg-indigo-500 selection:text-white">
        <AppShell>{children}</AppShell>
        <Analytics />
      </body>
    </html>
  );
}
