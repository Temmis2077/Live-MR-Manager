import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <>
      <SiteHeader currentPath="/" />
      <main>
        <section className="hero">
          <span className="badge">퍼포머를 위한 MR 관리</span>
          <h1>연습·방송은 앱에서, 노래책은 멜로밍과 함께</h1>
          <p>
            OSW로 MR·가사·재생을 관리하고, 멜로밍 노래책과 곡 정보를
            맞춰 보세요. 음원은 내 PC에서만 다루고, 시청자에게 보이는 목록만
            깔끔하게 동기화할 수 있습니다.
          </p>
        </section>

        <section className="card-grid">
          <article className="card">
            <h2>앱 받기</h2>
            <p>
              Windows용 OSW를 설치하고 라이브러리에 곡을 담아 보세요.
            </p>
            <Link href="/download" className="btn btn-primary">
              다운로드
            </Link>
          </article>
          <article className="card">
            <h2>멜로밍 노래책 연동</h2>
            <p>
              치지직·SOOP(숲)·씨미 채널 주소로 노래책을 가져오고, KEY·숙련도·난이도 등을
              한곳에서 관리합니다.
            </p>
            <Link href="/faq#channel-id" className="btn btn-secondary">
              연동 방법 보기
            </Link>
          </article>
          <article className="card">
            <h2>도움이 필요하신가요?</h2>
            <p>설치, 로그인, 동기화 범위 등 자주 묻는 질문을 모았습니다.</p>
            <Link href="/faq" className="btn btn-secondary">
              FAQ 보기
            </Link>
          </article>
        </section>

        <section style={{ marginTop: "2.5rem" }}>
          <h2 style={{ margin: "0 0 1rem", fontSize: "1.15rem" }}>
            이렇게 사용해 보세요
          </h2>
          <ol className="steps">
            <li>
              <strong>1. 앱 설치</strong>
              <span>
                <Link href="/download">다운로드</Link> 페이지에서 최신 버전을
                설치합니다.
              </span>
            </li>
            <li>
              <strong>2. 곡 라이브러리 만들기</strong>
              <span>
                유튜브·로컬 파일을 추가하고, 필요하면 AI로 MR을 분리해 둡니다.
              </span>
            </li>
            <li>
              <strong>3. 멜로밍 채널 연결</strong>
              <span>
                앱 설정에 방송 채널 주소(치지직·SOOP·씨미 등)를 입력하고
                「가져오기」로 기존 목록을 불러옵니다.
              </span>
            </li>
            <li>
              <strong>4. 곡 정보 맞추기</strong>
              <span>
                제목·가수·KEY/BPM·숙련도·난이도·가사를 정리한 뒤, 멜로밍
                노래책과 동기화합니다.
              </span>
            </li>
            <li>
              <strong>5. 방송·연습</strong>
              <span>
                앱에서 재생·피치 조절·OBS 오버레이를 쓰고, 시청자용 노래책은
                멜로밍에 반영된 상태를 유지합니다.
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
            멜로밍 안에서 보이는 이 화면은 OSW 연동 안내입니다. 앱
            설치·노래책 맞추기 방법은 위 단계와{" "}
            <Link href="/faq">FAQ</Link>를 참고해 주세요. 멜로밍 로그인 직후에는
            잠시 연결 화면이 뜬 뒤 앱으로 돌아갑니다.
          </p>
        </section>
      </main>
    </>
  );
}
