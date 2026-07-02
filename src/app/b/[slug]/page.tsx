"use client";

import { use } from "react";
import { QuizApp } from "@/components/quiz-app";

export default function BankPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return <QuizApp slug={slug} />;
}
