import { SiteHeader } from "@/components/SiteHeader";
import { LegalDocument } from "@/components/LegalDocument";
import {
  TERMS_EFFECTIVE_DATE,
  TERMS_SECTIONS,
} from "@/lib/legal/terms-of-service";

export const metadata = {
  title: "이용약관",
  description:
    "OSW 및 Companion 웹 이용약관 — 베타 안내, 멜로밍 연동, 저작권·면책",
};

export default function TermsPage() {
  return (
    <>
      <SiteHeader currentPath="/terms" />
      <main>
        <section className="hero">
          <span className="badge">법적 고지</span>
          <h1>이용약관</h1>
          <p>
            OSW 데스크톱 앱과 Companion 웹(lmrm.vercel.app) 이용
            조건을 안내합니다. 시행일: {TERMS_EFFECTIVE_DATE}
          </p>
        </section>
        <LegalDocument sections={TERMS_SECTIONS} />
      </main>
    </>
  );
}
