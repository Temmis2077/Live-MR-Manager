import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import {
  DISCORD_INVITE_URL,
  FAQ_URL,
  GITHUB_ISSUES_BUG_URL,
  GITHUB_ISSUES_FEATURE_URL,
  GITHUB_ISSUES_MELOMING_URL,
  QA_URL,
} from "@/lib/site";

export const metadata = {
  title: "문의하기",
  description:
    "OSW 설치·멜로밍 연동 문의 — Discord, FAQ, GitHub Issues",
};

export default function QaPage() {
  const discordUrl = DISCORD_INVITE_URL || QA_URL;
  const discordIsDirect = Boolean(DISCORD_INVITE_URL);

  return (
    <>
      <SiteHeader currentPath="/qa" />
      <main>
        <section className="hero">
          <span className="badge">문의</span>
          <h1>도움이 필요하신가요?</h1>
          <p>
            설치·멜로밍 연동·사용법은 FAQ와 Discord에서 안내합니다. 재현 가능한
            버그는 GitHub Issues로 등록해 주세요.
          </p>
        </section>

        <section className="card-grid support-hub">
          <article className="card support-card-primary">
            <h2>Discord</h2>
            <p>
              스트리머·퍼포머 커뮤니티에서 빠르게 질문하고 답변을 받을 수
              있습니다. 토큰·비밀번호는 올리지 마세요.
            </p>
            <a
              href={discordUrl}
              className="btn btn-primary"
              {...(discordIsDirect
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              {discordIsDirect ? "Discord 참여" : "Discord 안내 (준비 중)"}
            </a>
          </article>

          <article className="card">
            <h2>도움말 (FAQ)</h2>
            <p>
              채널 주소 입력, 가져오기·보내기, OAuth, 문의 시 주의사항 등을
              모아 두었습니다.
            </p>
            <Link href="/faq" className="btn btn-secondary">
              FAQ 보기
            </Link>
          </article>
        </section>

        <section className="card" style={{ marginTop: "1rem" }}>
          <h2>GitHub Issues — 공식 신고</h2>
          <p>
            재현 가능한 버그·멜로밍 연동 오류·기능 제안은 아래 템플릿을 사용해
            주세요. 개인정보·공식 문의도 Issues로 접수합니다.
          </p>
          <div className="support-issue-links">
            <a
              href={GITHUB_ISSUES_BUG_URL}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              버그 신고
            </a>
            <a
              href={GITHUB_ISSUES_MELOMING_URL}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              멜로밍 연동 문의
            </a>
            <a
              href={GITHUB_ISSUES_FEATURE_URL}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              기능 제안
            </a>
          </div>
          <p className="support-note">
            FAQ를 먼저 확인해 주세요:{" "}
            <a href={FAQ_URL}>{FAQ_URL.replace(/^https?:\/\//, "")}</a>
          </p>
        </section>
      </main>
    </>
  );
}
