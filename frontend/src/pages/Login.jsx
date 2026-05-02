import { useState } from 'preact/hooks';
import styles from './Login.module.css';

/**
 * 미인증 리다이렉트에서 전달된 ?next= 파라미터를 안전하게 읽는다.
 *
 * 오픈 리다이렉트 방지를 위해 같은 오리진의 pathname(/로 시작)만 허용한다.
 * 파라미터가 없거나 외부 URL이면 기본값 /resume를 반환한다.
 *
 * @returns {string} 로그인 성공 후 이동할 경로
 */
function getNextPath() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  // 같은 오리진 내부 경로만 허용 (외부 URL, // 시작 등 차단)
  if (next && next.startsWith('/') && !next.startsWith('//')) {
    return next;
  }
  return '/resume';
}

/**
 * LoginPage
 *
 * /login 페이지 — 환경변수로 설정된 고정 토큰을 입력해
 * /auth/login 엔드포인트로 POST 요청을 보내고,
 * 성공 시 사용자 세션 쿠키가 설정된다.
 *
 * 인증 후 이동 경로:
 *   - URL에 ?next=<path> 파라미터가 있으면 해당 경로로 이동
 *     (백엔드 cookieAuth 미들웨어가 /login?next=<path> 형태로 리다이렉트함)
 *   - 파라미터가 없으면 기본값 /resume로 이동
 *
 * 오픈 리다이렉트 방지: next 값은 /로 시작하는 같은 오리진 경로만 허용
 */
export function LoginPage() {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!token.trim()) {
      setError('토큰을 입력해 주세요.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
        credentials: 'include',
      });

      if (res.ok) {
        // 인증 성공 → next 파라미터 경로(또는 기본값 /resume)로 이동
        window.location.href = getNextPath();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? '토큰이 올바르지 않습니다.');
      }
    } catch {
      setError('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class={styles.page}>
      <div class={styles.card}>
        {/* Logo / Title */}
        <div class={styles.header}>
          <div class={styles.logo}>WL</div>
          <h1 class={styles.title}>Work Log</h1>
          <p class={styles.subtitle}>초대받은 사용자 토큰으로 로그인합니다</p>
        </div>

        {/* Form */}
        <form class={styles.form} onSubmit={handleSubmit} noValidate>
          <div class={styles.field}>
            <label class={styles.label} htmlFor="token-input">
              액세스 토큰
            </label>
            <input
              id="token-input"
              class={`${styles.input} ${error ? styles.inputError : ''}`}
              type="password"
              placeholder="토큰을 입력하세요"
              value={token}
              onInput={(e) => {
                setToken(e.currentTarget.value);
                if (error) setError('');
              }}
              autocomplete="current-password"
              disabled={loading}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autofocus
            />
            {error && (
              <p class={styles.errorMsg} role="alert">
                {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            class={styles.btn}
            disabled={loading || !token.trim()}
          >
            {loading ? (
              <span class={styles.spinner} aria-hidden="true" />
            ) : null}
            {loading ? '확인 중…' : '로그인'}
          </button>
        </form>

        {/* Hint */}
        <p class={styles.hint}>
          관리자가 발급한 사용자 토큰으로 로그인합니다
        </p>
      </div>
    </div>
  );
}
