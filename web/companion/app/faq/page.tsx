import { SiteHeader } from "@/components/SiteHeader";
import { FaqList } from "@/components/FaqList";

export const metadata = {
  title: "도움말",
  description:
    "OSW 설치, 멜로밍 노래책 연동, 곡 정보·동기화에 대한 자주 묻는 질문",
};

export default function FaqPage() {
  return (
    <>
      <SiteHeader currentPath="/faq" />
      <main>
        <section className="hero">
          <span className="badge">도움말</span>
          <h1>자주 묻는 질문</h1>
          <p>
            앱 사용법과 멜로밍 노래책 연동에 대해 자주 받는 질문입니다.
          </p>
        </section>
        <FaqList />
      </main>
    </>
  );
}
