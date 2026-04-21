import { useCallback, useEffect, useState } from 'preact/hooks';
import { navigate } from '../App.jsx';
import { buildResumeHealthCheckModel } from '../lib/resumeHealthCheckModel.js';

export function useResumeHealthCheck({ autoLoad = true, redirectOnAuthError = false } = {}) {
  const [healthCheck, setHealthCheck] = useState(null);
  const [loading, setLoading] = useState(autoLoad);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [resumeRes, batchRes, draftRes, draftStatusRes] = await Promise.all([
        fetch('/api/resume/status', { credentials: 'include' }),
        fetch('/api/resume/batch-summary/latest', { credentials: 'include' }),
        fetch('/api/resume/chat/generate-draft', { credentials: 'include' }),
        fetch('/api/resume/chat/generate-draft/status', { credentials: 'include' }),
      ]);

      const authBlocked = [resumeRes, batchRes, draftRes, draftStatusRes].some(
        (res) => res.status === 401 || res.status === 403
      );
      if (authBlocked) {
        if (redirectOnAuthError) {
          navigate('/login');
        }
        return;
      }

      const resumeStatus = resumeRes.ok ? await resumeRes.json() : { exists: false };
      const batchPayload = batchRes.ok ? await batchRes.json() : null;
      const draftPayload = draftRes.ok ? await draftRes.json() : null;
      const draftStatusPayload = draftStatusRes.ok ? await draftStatusRes.json() : { status: 'idle' };

      setHealthCheck(buildResumeHealthCheckModel({
        resumeExists: resumeStatus?.exists === true,
        batchSummary: batchPayload?.summary ?? null,
        draftState: draftStatusPayload ?? null,
        draftExists: !!draftPayload?.draft,
      }));
    } catch (err) {
      setError(err.message || '상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [redirectOnAuthError]);

  useEffect(() => {
    if (autoLoad) {
      void refresh();
    }
  }, [autoLoad, refresh]);

  return {
    healthCheck,
    loading,
    error,
    refresh,
  };
}
