const CHAT_EXAMPLES = [
  '최근에 한 경험의 의미를 더 깊게 해석해줘',
  '이 변화가 어떤 project arc에 쌓이는지 정리해줘',
  '이 작업에서 드러난 사람 신호를 근거와 함께 설명해줘',
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
        label: '프로젝션 설정',
        detail: '선택적인 projection 레이어가 준비되어 있어 나중에 다른 산출물로 이어갈 수 있습니다.',
      }
    : {
        status: 'missing',
        label: '프로젝션 설정',
        detail: 'V1 핵심 가치는 work log 의미 추출이며, projection 설정은 나중 단계로 남겨둡니다.',
      };

  const batch = batchSummary
    ? {
        status: 'ready',
        label: 'Work meaning',
        detail: batchSummary?.candidateGeneration?.message || '최근 배치 결과를 확인할 수 있습니다.',
      }
    : {
        status: 'missing',
        label: 'Work meaning',
        detail: '아직 오늘 기록을 생성하지 않았습니다.',
      };

  const draft = {
    status: draftStatus,
    label: 'Meaning chat',
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
  if (!batchSummary) return '오늘 기록을 한 번 생성하면 일의 의미와 패턴이 바로 보이기 시작합니다.';
  if (!resumeExists && draftStatus === 'ready') return '최근 기록과 의미 구조는 준비됐고, 추가 projection은 나중에 이어도 됩니다.';
  if (draftStatus === 'ready') return '최근 기록의 의미 구조가 준비되어 있어 더 깊은 해석이나 채팅으로 이어갈 수 있습니다.';
  if (draftStatus === 'pending') return '핵심 기록은 보이기 시작했고, 더 깊은 초안은 백그라운드에서 준비 중입니다.';
  if (draftStatus === 'failed') return '의미 추출은 계속 볼 수 있고, 초안 생성은 나중에 다시 시도할 수 있습니다.';
  return '최근 기록은 준비됐고, 다음은 의미 패턴을 더 깊게 읽어보는 단계입니다.';
}

function bodyFor({ resumeExists, batchSummary, draftStatus }) {
  if (!batchSummary) {
    return 'Work Log에서 오늘 기록을 생성하면 커밋·슬랙·세션을 모아 무엇이 의미 있었는지, 어떤 프로젝트 축과 사람 신호가 생기는지 볼 수 있습니다.';
  }

  if (!resumeExists) {
    return 'V1에서는 먼저 일의 의미와 패턴을 읽는 것이 핵심입니다. projection 설정은 선택적인 다음 단계로 남겨둡니다.';
  }

  if (draftStatus === 'ready') {
    return '채팅에서는 “이 경험의 의미가 뭐지?”처럼 해석을 더 깊게 하거나, 나중에 원한다면 나중에 다른 산출물 방향으로도 이어갈 수 있습니다.';
  }

  if (draftStatus === 'pending') {
    return '초안이 준비되면 근거와 함께 더 깊은 해석을 시작할 수 있습니다. 그 전에는 home에서 의미 요약을 먼저 읽어도 됩니다.';
  }

  if (draftStatus === 'failed') {
    return '초안 생성이 실패해도 core 의미 요약은 계속 볼 수 있습니다. 필요하면 나중에 다시 시도하면 됩니다.';
  }

  return '채팅으로 이동하면 최근 경험의 의미를 더 깊게 묻거나, 원한다면 나중에 다른 산출물 방향으로도 이어갈 수 있습니다.';
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
  if (!batchSummary) {
    return action('generate_record', '오늘 기록 생성하기', '/');
  }

  if (!resumeExists) {
    return action('open_worklog', '최근 의미 요약 보기', '/');
  }

  if (draftStatus === 'ready') {
    return action('open_chat', '의미 더 깊게 보기', '/resume/chat');
  }

  if (draftStatus === 'pending') {
    return action('open_worklog', '최근 기록 먼저 보기', '/');
  }

  if (draftStatus === 'failed') {
    return action('open_worklog', '의미 요약 계속 보기', '/');
  }

  return action('open_worklog', '오늘 의미 요약 보기', '/');
}

function buildSecondaryActions({ resumeExists, draftStatus, primaryKind }) {
  const actions = [];

  const push = (kind, label, href) => {
    if (kind !== primaryKind) actions.push(action(kind, label, href));
  };

  push('open_worklog', '업무 로그 보기', '/');
  push('open_resume', resumeExists ? '나중에 이어보기' : '추가 설정 열기', '/resume');
  if (resumeExists || draftStatus !== 'missing') {
    push('open_chat', draftStatus === 'ready' ? '의미 더 깊게 보기' : '채팅 열기', '/resume/chat');
  }

  return actions.slice(0, 2);
}

function action(kind, label, href) {
  return { kind, label, href };
}
