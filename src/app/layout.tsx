import type { ReactNode } from "react";

export const metadata = {
  title: "MCC Messaging",
  description: "Military Creator Con messaging service",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
