import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clusterResumeCandidateStrings } from "./resumeSuggestionClustering.mjs";

describe("clusterResumeCandidateStrings", () => {
  test("merges related mobile stability items into one resume theme", () => {
    const clusters = clusterResumeCandidateStrings([
      "Android 15 대응으로 하단 SafeArea를 적용해 edge-to-edge 충돌을 보완했습니다.",
      "Flutter WebView Dart 타입 에러를 Sentry 필터에 추가해 집계 노이즈를 줄였습니다.",
      "모바일 화면 안정성을 위해 WebView 동작과 오류 추적 흐름을 점검했습니다.",
    ]);

    assert.equal(clusters.length, 1);
    assert.match(clusters[0].prompt, /Resume theme:/);
    assert.match(clusters[0].prompt, /mobile stability/i);
    assert.ok(clusters[0].candidates.length >= 3);
  });

  test("drops isolated low-signal version bumps", () => {
    const clusters = clusterResumeCandidateStrings([
      "버전 1.15.21+180으로 릴리스 준비를 마무리했습니다."
    ]);

    assert.deepEqual(clusters, []);
  });

  test("keeps unrelated high-signal themes separate", () => {
    const clusters = clusterResumeCandidateStrings([
      "OAuth 2.0 기반 로그인 흐름을 재설계해 보안성과 운영성을 높였습니다.",
      "배치 자동화를 구축해 주간 리포트 작성 시간을 7일에서 1시간으로 줄였습니다.",
    ]);

    assert.equal(clusters.length, 2);
    assert.ok(clusters.every((cluster) => cluster.prompt.length > 0));
  });
});
