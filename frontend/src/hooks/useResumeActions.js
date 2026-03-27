/**
 * useResumeActions
 *
 * bullet 단위 편집·삭제·추가 API 액션을 캡슐화하는 커스텀 훅.
 *
 * 각 액션은 서버 응답의 resume 객체를 onResumePatch 콜백으로 전달하여
 * 별도의 GET 재조회 없이 로컬 상태를 즉시 갱신한다.
 * resume이 응답에 없는 경우 onFallbackRefresh를 호출한다.
 *
 * 커버하는 API (Sub-AC 8-1):
 *   POST   /api/resume/section-bullet                              — bullet 추가
 *   PATCH  /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — bullet 편집
 *   DELETE /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — bullet 삭제
 *
 * 사용 예:
 *   const { addBullet, editBullet, deleteBullet } = useResumeActions({
 *     onResumePatch: setResume,       // ResumePage의 setResume
 *     onFallbackRefresh: fetchResume, // 응답에 resume 없을 때 full re-fetch
 *   });
 *
 * @param {Object} opts
 * @param {(resume: object) => void} [opts.onResumePatch]
 *   API 응답 resume 객체를 받아 로컬 이력서 상태를 즉시 갱신하는 콜백.
 * @param {() => void} [opts.onFallbackRefresh]
 *   응답에 resume이 없을 때 full re-fetch를 트리거하는 콜백 (방어 fallback).
 *
 * @returns {{
 *   addBullet: (section: string, itemIndex: number, bullet: string) => Promise<void>,
 *   editBullet: (section: string, itemIndex: number, bulletIndex: number, text: string) => Promise<void>,
 *   deleteBullet: (section: string, itemIndex: number, bulletIndex: number) => Promise<void>,
 * }}
 */
export function useResumeActions({ onResumePatch, onFallbackRefresh } = {}) {
  /**
   * Shared response handler.
   * Calls onResumePatch(resume) if the server returned one,
   * otherwise falls back to onFallbackRefresh().
   *
   * @param {object} data — parsed JSON response body
   */
  function applyResponse(data) {
    if (data && data.resume) {
      onResumePatch?.(data.resume);
    } else {
      onFallbackRefresh?.();
    }
  }

  // ── Add bullet ─────────────────────────────────────────────────────────────

  /**
   * Append a new bullet to an experience or projects item.
   *
   * Calls POST /api/resume/section-bullet
   * On success, the full updated resume from the server response is passed to
   * onResumePatch, immediately reflecting the new bullet in the UI.
   *
   * @param {'experience'|'projects'} section  — target section
   * @param {number} itemIndex                 — 0-based index within section array
   * @param {string} bullet                    — new bullet text (max 500 chars)
   * @throws {Error} on HTTP error or network failure
   */
  async function addBullet(section, itemIndex, bullet) {
    const res = await fetch('/api/resume/section-bullet', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section, itemIndex, bullet }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    applyResponse(data);
    return data;
  }

  // ── Edit bullet ────────────────────────────────────────────────────────────

  /**
   * Edit the text of a single bullet (direct user edit, source='user').
   *
   * Calls PATCH /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex
   * On success, the full updated resume from the server is passed to onResumePatch.
   *
   * @param {'experience'|'projects'} section
   * @param {number} itemIndex    — 0-based index within section array
   * @param {number} bulletIndex  — 0-based index within item.bullets array
   * @param {string} text         — new bullet text
   * @throws {Error} on HTTP error or network failure
   */
  async function editBullet(section, itemIndex, bulletIndex, text) {
    const url =
      `/api/resume/sections/${encodeURIComponent(section)}` +
      `/${itemIndex}/bullets/${bulletIndex}`;

    const res = await fetch(url, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    applyResponse(data);
    return data;
  }

  // ── Delete bullet ──────────────────────────────────────────────────────────

  /**
   * Delete a single bullet from an experience or projects item.
   *
   * Calls DELETE /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex
   * On success, the full updated resume from the server is passed to onResumePatch.
   *
   * @param {'experience'|'projects'} section
   * @param {number} itemIndex    — 0-based index within section array
   * @param {number} bulletIndex  — 0-based index within item.bullets array
   * @throws {Error} on HTTP error or network failure
   */
  async function deleteBullet(section, itemIndex, bulletIndex) {
    const url =
      `/api/resume/sections/${encodeURIComponent(section)}` +
      `/${itemIndex}/bullets/${bulletIndex}`;

    const res = await fetch(url, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    applyResponse(data);
    return data;
  }

  return { addBullet, editBullet, deleteBullet };
}
