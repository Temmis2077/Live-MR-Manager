import { SiteHeader } from "@/components/SiteHeader";
import { LegalDocument } from "@/components/LegalDocument";
import {
  PRIVACY_EFFECTIVE_DATE,
  PRIVACY_SECTIONS,
} from "@/lib/legal/privacy-policy";

export const metadata = {
  title: "개인정보 처리방침",
  description:
    "OSW 및 Companion 웹의 개인정보 처리 항목, 멜로밍 OAuth 범위, 쿠키, 제3자 연동 안내",
};

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader currentPath="/privacy" />
      <main>
        <section className="hero">
          <span className="badge">법적 고지</span>
          <h1>개인정보 처리방침</h1>
          <p>
            OSW 데스크톱 앱과 Companion 웹(lmrm.vercel.app)에서
            처리하는 정보의 범위와 목적을 안내합니다. 시행일:{" "}
            {PRIVACY_EFFECTIVE_DATE}
          </p>
        </section>
        <LegalDocument sections={PRIVACY_SECTIONS} />
      </main>
    </>
  );
}
