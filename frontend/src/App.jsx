import { useState, useEffect } from 'preact/hooks';
import { LoginPage } from './pages/Login.jsx';
import { ProjectsPage } from './pages/ProjectsPage.jsx';
import { ResumeChatPage } from './pages/ResumeChatPage.jsx';
import { ResumePage } from './pages/ResumePage.jsx';
import { WorkLogPage } from './pages/WorkLogPage.jsx';

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

  if (pathname === '/') {
    return <WorkLogPage />;
  }

  if (pathname === '/login') {
    return <LoginPage />;
  }

  if (pathname === '/resume') {
    return <ResumePage />;
  }

  if (pathname === '/resume/analysis') {
    // redirect to chat — analysis tab removed
    return <ResumeChatPage />;
  }

  if (pathname === '/resume/chat') {
    return <ResumeChatPage />;
  }

  if (pathname === '/projects' || pathname === '/projects.html') {
    return <ProjectsPage />;
  }

  return (
    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)' }}>
      <p>경로를 찾을 수 없습니다.</p>
    </div>
  );
}
