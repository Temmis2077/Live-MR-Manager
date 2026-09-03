import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <>
      <SiteHeader currentPath="/" />
      <main>
        <section className="hero">
          <span className="badge">퍼포머를 위한 MR 관리</span>
          <h1>노래 방송과 연습을 한 흐름으로 준비하는 OSW</h1>
          <p>
            OSW는 MR 분리, 가사 싱크, 라이브 재생과 OBS 오버레이를 로컬 PC에서
            이어 주는 Windows 앱입니다. 현재 첫 독립 베타 설치본을 검증하고 있습니다.
          </p>
        </section>

        <section className="card-grid">
          <article className="card">
            <h2>앱 받기</h2>
            <p>
              첫 독립 베타는 아직 공개되지 않았습니다. 현재 상태와 알려진 제한을 확인하세요.
            </p>
            <Link href="/download" className="btn btn-primary">
              배포 준비 상태
            </Link>
          </article>
          <article className="card">
            <h2>멜로밍 연동</h2>
            <p>
              앱 UI에서는 현재 숨겨진 준비 중 기능입니다. OAuth와 Companion 계약을
              다시 검증한 뒤 별도로 공개합니다.
            </p>
            <Link href="/faq#channel-id" className="btn btn-secondary">
              현재 상태 보기
            </Link>
          </article>
          <article className="card">
            <h2>도움이 필요하신가요?</h2>
            <p>설치 준비 상태, 로컬 처리 범위와 문제 제보 방법을 모았습니다.</p>
            <Link href="/faq" className="btn btn-secondary">
              FAQ 보기
            </Link>
          </article>
        </section>

        <section style={{ marginTop: "2.5rem" }}>
          <h2 style={{ margin: "0 0 1rem", fontSize: "1.15rem" }}>
            베타가 공개되면 이렇게 사용합니다
          </h2>
          <ol className="steps">
            <li>
              <strong>1. 앱 설치</strong>
              <span>
                <Link href="/download">다운로드</Link> 페이지에서 검증 완료 여부를
                확인한 뒤 설치합니다.
              </span>
            </li>
            <li>
              <strong>2. 곡 라이브러리 만들기</strong>
              <span>
                유튜브·로컬 파일을 추가하고, 필요하면 AI로 MR을 분리해 둡니다.
              </span>
            </li>
            <li>
              <strong>3. 가사 싱크 확인</strong>
              <span>
                자동 정렬 결과를 오디오와 함께 듣고 직접 보정합니다.
              </span>
            </li>
            <li>
              <strong>4. 라이브 화면 준비</strong>
              <span>
                현재·다음 가사, 대기열과 빠른 조작이 잘 보이는지 확인합니다.
              </span>
            </li>
            <li>
              <strong>5. 방송·연습</strong>
              <span>
                앱에서 재생과 믹서를 조작하고 OBS 가사·곡 정보 표시를 확인합니다.
              </span>
            </li>
          </ol>
        </section>

        <section
          style={{
            marginTop: "2rem",
            padding: "1.25rem",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: "0.9rem",
            color: "var(--text-muted)",
          }}
        >
          <strong style={{ color: "var(--text)" }}>멜로밍에서 이 페이지를 여셨나요?</strong>
          <p style={{ margin: "0.5rem 0 0" }}>
            이 화면은 향후 OSW 연동 안내를 위해 준비 중입니다. 현재 배포 버전에서는
            멜로밍 UI를 사용할 수 없습니다. <Link href="/faq">FAQ</Link>에서
            공개 상태를 확인해 주세요.
          </p>
        </section>
      </main>
    </>
  );
}
