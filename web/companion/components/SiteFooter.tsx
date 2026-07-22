import Link from "next/link";
import { DISCORD_INVITE_URL, QA_URL } from "@/lib/site";

const MELOMING_URL = "https://meloming.com";

export function SiteFooter() {
  const discordHref = DISCORD_INVITE_URL || QA_URL;

  return (
    <footer className="site-footer">
      <p>
        OSW — 방송·연습용 MR 관리 앱. 음원은 내 PC에서만 처리됩니다.
      </p>
      <p>
        <Link href="/faq">도움말</Link>
        {" · "}
        <Link href="/qa">문의</Link>
        {" · "}
        <a href={discordHref} target="_blank" rel="noopener noreferrer">
          Discord
        </a>
        {" · "}
        <Link href="/download">다운로드</Link>
        {" · "}
        <Link href="/privacy">개인정보 처리방침</Link>
        {" · "}
        <Link href="/terms">이용약관</Link>
        {" · "}
        <a href={MELOMING_URL} target="_blank" rel="noopener noreferrer">
          멜로밍
        </a>
      </p>
    </footer>
  );
}
