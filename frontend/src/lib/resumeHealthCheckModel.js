const CHAT_EXAMPLES = [
  '최근에 한 경험을 이력서에는 어떻게 반영하면 좋을까?',
  '이 bullet을 더 강한 성과 중심 문장으로 바꿔줘',
  '이 강점을 보여주는 근거를 찾아줘',
];

export function buildResumeHealthCheckModel({
  resumeExists,
  batchSummary,
  draftState,
  draftExists,
}) {
  const draftStatus = resolveDraftStatus({ draftState, draftExists });

  const resume = resumeExists
    ? {
        status: 'ready',
        label: '기본 이력서',
        detail: '기본 이력서가 준비되어 있어 바로 편집할 수 있습니다.',
      }
    : {
        status: 'missing',
        label: '기본 이력서',
        detail: '먼저 LinkedIn 또는 PDF 업로드로 기본 이력서를 만들어야 합니다.',
      };

  const batch = batchSummary
    ? {
        status: 'ready',
        label: '최근 기록',
        detail: batchSummary?.candidateGeneration?.message || '최근 배치 결과를 확인할 수 있습니다.',
      }
    : {
        status: 'missing',
        label: '최근 기록',
        detail: '아직 오늘 기록을 생성하지 않았습니다.',
      };

  const draft = {
    status: draftStatus,
    label: '채팅 초안',
    detail: draftDetailFor(draftStatus, draftState),
  };

  const primaryAction = pickPrimaryAction({ resumeExists, batchSummary, draftStatus });
  const secondaryActions = buildSecondaryActions({ resumeExists, draftStatus, primaryKind: primaryAction.kind });

  return {
    headline: headlineFor({ resumeExists, batchSummary, draftStatus }),
    body: bodyFor({ resumeExists, batchSummary, draftStatus }),
    resume,
    batch,
    draft,
    batchSummary: batchSummary ?? null,
    primaryAction,
    secondaryActions,
    chatExamples: CHAT_EXAMPLES,
  };
}

function resolveDraftStatus({ draftState, draftExists }) {
  if (draftExists) return 'ready';
  if (draftState?.status === 'pending') return 'pending';
  if (draftState?.status === 'failed') return 'failed';
  return 'missing';
}

function headlineFor({ resumeExists, batchSummary, draftStatus }) {
  if (!resumeExists) return '기본 이력서를 먼저 준비하면 이후 흐름이 열립니다.';
  if (!batchSummary) return '오늘 기록을 한 번 생성하면 후보와 다음 액션이 바로 보입니다.';
  if (draftStatus === 'ready') return '채팅으로 경험을 더 설득력 있게 다듬을 준비가 됐습니다.';
  if (draftStatus === 'pending') return '초안을 만드는 중입니다. 준비되는 동안 최근 기록과 제안을 먼저 볼 수 있습니다.';
  if (draftStatus === 'failed') return '초안 생성이 실패했지만 채팅에서 다시 시도할 수 있습니다.';
  return '최근 기록은 준비됐고, 다음은 채팅으로 의미를 다듬는 단계입니다.';
}

function bodyFor({ resumeExists, batchSummary, draftStatus }) {
  if (!resumeExists) {
    return 'LinkedIn 프로필과 PDF 이력서를 연결하면 기본 구조를 만들고 이후 제안/채팅이 쉬워집니다.';
  }

  if (!batchSummary) {
    return 'Work Log에서 오늘 기록을 생성하면 커밋·슬랙·세션을 모아 후보를 만들고, 그 결과를 바로 검토할 수 있습니다.';
  }

  if (draftStatus === 'ready') {
    return '채팅에서는 “이 경험을 어떻게 반영할까?”처럼 직접 경험의 의미를 묻고, 불릿을 더 강하게 다듬을 수 있습니다.';
  }

  if (draftStatus === 'pending') {
    return '초안이 준비되면 근거와 함께 채팅을 시작할 수 있습니다. 그 전에는 배치 결과를 먼저 검토해도 됩니다.';
  }

  if (draftStatus === 'failed') {
    return '채팅으로 이동해 초안 생성을 다시 시도하거나, 이력서 편집에서 직접 수정부터 시작할 수 있습니다.';
  }

  return '채팅으로 이동하면 초안 생성을 시작하거나, 최근 경험을 이력서 문장으로 어떻게 바꿀지 바로 물어볼 수 있습니다.';
}

function draftDetailFor(status, draftState) {
  switch (status) {
    case 'ready':
      return '초안이 준비되어 있어 경험/강점/불릿을 바로 질문할 수 있습니다.';
    case 'pending':
      return '초안을 생성하는 중입니다. 잠시 후 채팅에서 근거 기반 초안을 볼 수 있습니다.';
    case 'failed':
      return draftState?.error || '초안 생성이 실패했습니다. 채팅에서 다시 시도할 수 있습니다.';
    default:
      return '아직 채팅용 초안이 없습니다. 채팅 진입 시 생성 또는 재시도를 시작할 수 있습니다.';
  }
}

function pickPrimaryAction({ resumeExists, batchSummary, draftStatus }) {
  if (!resumeExists) {
    return action('open_resume', '기본 이력서 만들기', '/resume');
  }

  if (!batchSummary) {
    return action('generate_record', '오늘 기록 생성하기', '/');
  }

  if (draftStatus === 'ready') {
    return action('open_chat', '이력서 채팅 열기', '/resume/chat');
  }

  if (draftStatus === 'pending') {
    return action('open_worklog', '최근 기록 먼저 보기', '/');
  }

  if (draftStatus === 'failed') {
    return action('open_chat', '채팅에서 다시 시도하기', '/resume/chat');
  }

  return action('open_chat', '채팅으로 경험 다듬기', '/resume/chat');
}

function buildSecondaryActions({ resumeExists, draftStatus, primaryKind }) {
  const actions = [];

  const push = (kind, label, href) => {
    if (kind !== primaryKind) actions.push(action(kind, label, href));
  };

  push('open_worklog', '업무 로그 보기', '/');
  if (resumeExists) push('open_resume', '이력서 편집 열기', '/resume');
  if (resumeExists) push('open_chat', draftStatus === 'ready' ? '채팅으로 다듬기' : '채팅 열기', '/resume/chat');

  return actions.slice(0, 2);
}

function action(kind, label, href) {
  return { kind, label, href };
}
