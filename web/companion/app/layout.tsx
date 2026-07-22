import type { Metadata } from "next";
import "./globals.css";
import { SiteFooter } from "@/components/SiteFooter";
import { SITE_ICON, SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} — 멜로밍 노래책 연동 안내`,
    template: `%s · ${SITE_NAME}`,
  },
  description:
    "OSW 설치, 멜로밍 노래책 연동, 곡 정보 관리 도움말.",
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
