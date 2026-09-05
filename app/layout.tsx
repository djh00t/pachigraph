import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pachigraph',
  description:
    'Pachigraph. The elephant that never forgets. Find useful knowledge in your Codex history.',
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
