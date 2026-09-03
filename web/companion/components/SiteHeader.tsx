import Image from "next/image";
import Link from "next/link";
import { SITE_LOGO, SITE_NAME } from "@/lib/site";

const LINKS = [
  { href: "/", label: "홈" },
  { href: "/faq", label: "도움말" },
  { href: "/qa", label: "문의" },
  { href: "/download", label: "다운로드" },
];

type Props = {
  currentPath?: string;
};

export function SiteHeader({ currentPath = "/" }: Props) {
  return (
    <header className="site-header">
      <Link href="/" className="brand">
        <Image
          src={SITE_LOGO}
          alt={SITE_NAME}
          width={154}
          height={40}
          className="brand-logo"
          priority
        />
      </Link>
      <div className="header-right">
        <nav className="nav" aria-label="주요 메뉴">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={currentPath === link.href ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
