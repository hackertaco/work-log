import { useState, useEffect } from 'preact/hooks';
import { LoginPage } from './pages/Login.jsx';
import { ResumePage } from './pages/ResumePage.jsx';

/**
 * Minimal client-side router.
 * Reads window.location.pathname and renders the matching page.
 */
function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return pathname;
}

export function navigate(to) {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const pathname = usePathname();

  if (pathname === '/login') {
    return <LoginPage />;
  }

  if (pathname === '/resume') {
    return <ResumePage />;
  }

  // Placeholder — other routes (/, /projects) will be added in later sub-tasks
  return (
    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)' }}>
      <p>Work Log — loading…</p>
    </div>
  );
}
