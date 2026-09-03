import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { GITHUB_RELEASES_URL } from "@/lib/site";

export const metadata = {
  title: "다운로드",
  description: "OSW Windows 앱 베타 다운로드",
};

export default function DownloadPage() {
  return (
    <>
      <SiteHeader currentPath="/download" />
      <main>
        <section className="hero">
          <span className="badge">Windows</span>
          <h1>OSW 받기</h1>
          <p>
            Windows 10/11용 첫 독립 베타를 내려받을 수 있습니다.
          </p>
        </section>
        <article className="card">
          <h2>1.0.0-beta.1</h2>
          <p>
            GitHub Releases에서 NSIS 설치 파일을 내려받아 실행하세요. 앱 안의 업데이트
            알림도 새 공개 릴리즈의 다운로드 페이지로 연결됩니다.
          </p>
          <a
            href={GITHUB_RELEASES_URL}
            className="btn btn-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            Windows 베타 다운로드
          </a>
        </article>
        <article className="card" style={{ marginTop: "1rem" }}>
          <h2>베타에서 할 수 있는 일</h2>
          <p>
            유튜브·로컬 음원을 추가하고 MR 분리와 가사 싱크를 준비한 뒤 라이브 화면과
            OBS 오버레이를 사용할 수 있습니다. 멜로밍 연동은 현재 준비 중입니다.
          </p>
          <Link href="/faq" className="btn btn-secondary">
            FAQ 보기
          </Link>
        </article>
      </main>
    </>
  );
}
