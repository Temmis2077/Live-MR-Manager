"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { FAQ_CATEGORIES, FAQ_ITEMS } from "@/lib/faq-data";

/**
 * 답변 안의 강조와 링크를 실제로 그린다.
 *
 * 예전에는 `<p>{answer}</p>`로 평문 출력이라 `**설정 → 라이브러리**`가 별표째
 * 화면에 보였고, 안내한 주소도 클릭할 수 없었다. 답변 데이터에 쓰는 표기는
 * lib/faq-data.ts의 FaqItem 주석에 정리해 두었다 — 여기서 해석하는 것만 쓸 수 있다.
 */

/** `**굵게**` · 외부 URL · `/내부경로` 를 조각으로 나눈다. */
const TOKEN = /(\*\*[^*]+\*\*|https?:\/\/[^\s)]+|(?<![\w/])\/(?:privacy|terms|qa|faq|download)\b)/g;

function renderInline(text: string, keyPrefix: string) {
  return text.split(TOKEN).map((part, i) => {
    if (!part) return null;
    const key = `${keyPrefix}-${i}`;

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("http://") || part.startsWith("https://")) {
      // 뒤에 붙은 문장부호는 링크에서 뺀다 (".", "," 로 끝나는 경우).
      const trimmed = part.replace(/[.,]+$/, "");
      const tail = part.slice(trimmed.length);
      return (
        <Fragment key={key}>
          <a href={trimmed} target="_blank" rel="noreferrer noopener">
            {trimmed}
          </a>
          {tail}
        </Fragment>
      );
    }
    if (part.startsWith("/")) {
      return (
        <Link key={key} href={part}>
          {part}
        </Link>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function FaqAnswer({ answer }: { answer: string }) {
  // 빈 줄로 문단을 나눈다. 답변이 길어져 한 덩어리로는 읽기 어렵다.
  const paragraphs = answer.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((para, pi) => (
        <p key={pi}>
          {/* 문단 안의 홑 줄바꿈은 줄만 바꾼다(항목 나열에 쓴다). */}
          {para.split("\n").map((line, li) => (
            <Fragment key={li}>
              {li > 0 && <br />}
              {renderInline(line, `${pi}-${li}`)}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  );
}

export function FaqList() {
  const [category, setCategory] = useState("전체");

  const items = useMemo(() => {
    if (category === "전체") return FAQ_ITEMS;
    return FAQ_ITEMS.filter((item) => item.category === category);
  }, [category]);

  return (
    <>
      <div className="filter-row" role="tablist" aria-label="FAQ 카테고리">
        {FAQ_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            role="tab"
            aria-selected={category === cat}
            className={`chip ${category === cat ? "chip-active" : ""}`}
            onClick={() => setCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>
      <div className="faq-list">
        {items.map((item) => (
          <article key={item.id} className="faq-item" id={item.id}>
            <div className="faq-meta">{item.category}</div>
            <h3>{item.question}</h3>
            <FaqAnswer answer={item.answer} />
          </article>
        ))}
      </div>
    </>
  );
}
