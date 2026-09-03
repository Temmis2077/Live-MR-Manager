import type { Metadata } from "next";
import "./globals.css";
import { SiteFooter } from "@/components/SiteFooter";
import { SITE_ICON, SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} — 베타 준비 안내`,
    template: `%s · ${SITE_NAME}`,
  },
  description:
    "OSW 독립 베타 준비 상태, 사용 도움말과 문제 제보 안내.",
  icons: {
    icon: SITE_ICON,
    apple: SITE_ICON,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
