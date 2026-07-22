import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { GITHUB_RELEASES_URL } from "@/lib/site";

export const metadata = {
  title: "다운로드",
  description: "OSW Windows 앱 다운로드",
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
            PC에 설치한 뒤 MR 라이브러리를 만들고, 멜로밍 노래책과 곡 정보를
            맞출 수 있습니다.
          </p>
        </section>
        <article className="card">
          <h2>최신 버전 설치</h2>
          <p>
            아래 버튼에서 설치 파일을 받을 수 있습니다. 설치 후 앱 설정에서
            멜로밍 채널을 연결해 보세요.
          </p>
          <a
            href={GITHUB_RELEASES_URL}
            className="btn btn-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            설치 파일 다운로드
          </a>
        </article>
        <article className="card" style={{ marginTop: "1rem" }}>
          <h2>설치 후</h2>
          <p>
            유튜브·로컬 음원을 추가하고, 설정 → 멜로밍 노래책에서 방송 채널 주소를
            입력해 노래 목록을 가져올 수 있습니다.
          </p>
          <Link href="/faq" className="btn btn-secondary">
            연동 방법 보기
          </Link>
        </article>
      </main>
    </>
  );
}
