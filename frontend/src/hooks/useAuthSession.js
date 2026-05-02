import { useEffect, useState } from 'preact/hooks';

export function useAuthSession() {
  const [session, setSession] = useState({ loading: true, authenticated: false, userId: null });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/auth/me', { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) {
            setSession({ loading: false, authenticated: false, userId: null });
          }
          return;
        }
        const body = await res.json();
        if (!cancelled) {
          setSession({
            loading: false,
            authenticated: Boolean(body?.authenticated),
            userId: body?.userId ?? null,
          });
        }
      } catch {
        if (!cancelled) {
          setSession({ loading: false, authenticated: false, userId: null });
        }
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  async function logout(nextPath = '/login') {
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      window.location.href = nextPath;
    }
  }

  return { ...session, logout };
}
