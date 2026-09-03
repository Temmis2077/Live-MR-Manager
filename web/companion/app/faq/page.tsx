import { SiteHeader } from "@/components/SiteHeader";
import { FaqList } from "@/components/FaqList";

export const metadata = {
  title: "도움말",
  description:
    "OSW 설치와 사용법 — MR 분리 속도, GPU 가속 팩, 가사 싱크, 곡 목록 가져오기·백업에 대한 자주 묻는 질문",
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
            처음 쓰실 때 막히기 쉬운 것부터 순서대로 모았습니다. 앱 안에서는{" "}
            <strong>⚙ → 시작 가이드</strong>와 <strong>?</strong> 키(단축키 도움말)도
            함께 보실 수 있습니다.
          </p>
        </section>
        <FaqList />
      </main>
    </>
  );
}
