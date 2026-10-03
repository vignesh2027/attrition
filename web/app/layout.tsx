import type {Metadata} from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Attrition: find retired OpenTelemetry names',
  metadataBase: new URL('https://attrition-otel.vercel.app'),
  description:
    'Paste OpenTelemetry instrumentation code. Get every attribute, metric, event and enum value the semantic conventions have renamed, split, moved, dropped or removed, with the spec line that says so.',
}

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
