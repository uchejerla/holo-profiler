import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Holo Profiler', description: 'Data quality profiling, rules, schedules and exceptions' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600&family=Barlow:wght@400;500;600&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
