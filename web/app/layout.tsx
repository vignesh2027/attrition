import type {Metadata} from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Semconv Sentinel',
  description:
    'Paste OpenTelemetry instrumentation code. Get every attribute name the semantic conventions have renamed, split, moved or removed, with the spec line that says so.',
}

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
