import { useState, useRef, useCallback } from 'preact/hooks';
import styles from './PdfUploadOnboarding.module.css';
import { LinkedInInput } from './LinkedInInput.jsx';

/**
 * 업로드 상태 열거형
 * @typedef {'idle'|'dragover'|'selected'|'uploading'|'processing'|'success'|'error'} UploadStatus
 */

/**
 * 파일 크기를 읽기 쉬운 문자열로 포맷
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * PdfUploadOnboarding
 *
 * /resume 첫 접근 시 표시되는 PDF 업로드 온보딩 컴포넌트.
 * - PDF 파일 선택 (드래그 앤 드롭 + 버튼 클릭)
 * - LinkedIn URL 입력 (선택) — 이전 단계에서 이미 처리된 경우 건너뜀
 * - 업로드 버튼
 * - 업로드/처리 진행 상태 표시
 *
 * @param {{
 *   onComplete: (resumeData: object) => void,
 *   linkedinProfile?: object|null,  // step 1에서 수집된 LinkedIn 데이터 (있으면 LinkedIn 섹션 숨김)
 *   onBack?: () => void,            // step 1로 돌아가는 콜백 (optional)
 * }} props
 */
export function PdfUploadOnboarding({ onComplete, linkedinProfile = null, onBack }) {
  /** @type {[UploadStatus, Function]} */
  const [status, setStatus] = useState('idle');
  const [file, setFile] = useState(/** @type {File|null} */ (null));
  /**
   * LinkedIn 입력 결과.
   * null         → 건너뜀 또는 아직 미입력
   * { source: 'fetch', url, data } → URL 가져오기 성공
   * { source: 'paste', text }      → 수동 붙여넣기
   */
  /**
   * LinkedIn 입력 결과.
   * null         → 건너뜀 또는 아직 미입력
   * { source: 'fetch', url, data } → URL 가져오기 성공
   * { source: 'paste', text }      → 수동 붙여넣기
   * linkedinProfile prop가 제공된 경우 초기값으로 사용한다.
   */
  const [linkedinResult, setLinkedinResult] = useState(linkedinProfile ?? null);
  /**
   * LinkedIn 단계 완료 여부 (skip 포함).
   * linkedinProfile prop가 제공된 경우 이미 완료된 것으로 간주한다.
   */
  const [linkedinDone, setLinkedinDone] = useState(linkedinProfile !== null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const fileInputRef = useRef(null);
  const xhrRef = useRef(/** @type {XMLHttpRequest|null} */ (null));

  // ─── 파일 선택 처리 ──────────────────────────────────────────────────────────

  /**
   * File 객체 검증 후 상태 업데이트
   * @param {File} f
   */
  const selectFile = useCallback((f) => {
    if (!f) return;
    if (f.type !== 'application/pdf') {
      setErrorMsg('PDF 파일만 업로드할 수 있습니다.');
      setStatus('error');
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      setErrorMsg('파일 크기는 20MB 이하여야 합니다.');
      setStatus('error');
      return;
    }
    setFile(f);
    setErrorMsg('');
    setStatus('selected');
  }, []);

  /** 파일 input <change> 이벤트 */
  const handleFileInputChange = useCallback((e) => {
    const f = e.currentTarget.files?.[0];
    if (f) selectFile(f);
  }, [selectFile]);

  /** 드롭존 클릭 */
  const handleDropzoneClick = useCallback(() => {
    if (status === 'uploading' || status === 'processing' || status === 'success') return;
    fileInputRef.current?.click();
  }, [status]);

  /** 드래그 이벤트 */
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    if (status === 'uploading' || status === 'processing' || status === 'success') return;
    setStatus('dragover');
  }, [status]);

  const handleDragLeave = useCallback(() => {
    if (status === 'dragover') {
      setStatus(file ? 'selected' : 'idle');
    }
  }, [status, file]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    if (status === 'uploading' || status === 'processing' || status === 'success') return;
    const f = e.dataTransfer?.files?.[0];
    if (f) selectFile(f);
    else setStatus(file ? 'selected' : 'idle');
  }, [status, file, selectFile]);

  // ─── 업로드 처리 ──────────────────────────────────────────────────────────────

  const handleUpload = useCallback(() => {
    if (!file || status === 'uploading' || status === 'processing') return;

    setStatus('uploading');
    setUploadProgress(0);
    setErrorMsg('');

    const formData = new FormData();
    formData.append('pdf', file);
    // LinkedIn 결과 전달.
    // source === 'linkedin'     : LinkedInStep URL 가져오기 성공
    // source === 'fetch'        : LinkedInInput URL 가져오기 성공  (standalone 사용 시)
    // source === 'manual_paste' : LinkedInStep 수동 붙여넣기
    // source === 'paste'        : LinkedInInput 수동 붙여넣기 (standalone 사용 시)
    const lr = linkedinResult;
    if (lr?.source === 'linkedin' || lr?.source === 'fetch') {
      if (lr.url) formData.append('linkedinUrl', lr.url);
      if (lr.data) formData.append('linkedinData', JSON.stringify(lr.data));
    } else if (lr?.source === 'manual_paste' || lr?.source === 'paste') {
      formData.append('linkedinText', lr.text ?? '');
    }

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    // 업로드 진행률 (파일 전송 단계)
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setUploadProgress(pct);
      }
    });

    // 파일 전송 완료 → 서버 처리 단계
    xhr.upload.addEventListener('load', () => {
      setStatus('processing');
    });

    // 응답 수신
    xhr.addEventListener('load', () => {
      xhrRef.current = null;
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const data = JSON.parse(xhr.responseText);
          setStatus('success');
          // 잠시 후 완료 콜백 호출
          setTimeout(() => onComplete?.(data), 800);
        } catch {
          setErrorMsg('서버 응답을 파싱할 수 없습니다. 다시 시도해 주세요.');
          setStatus('error');
        }
      } else {
        let msg = '업로드에 실패했습니다. 다시 시도해 주세요.';
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.error) msg = data.error;
        } catch { /* ignore */ }
        setErrorMsg(msg);
        setStatus('error');
      }
    });

    xhr.addEventListener('error', () => {
      xhrRef.current = null;
      setErrorMsg('네트워크 오류가 발생했습니다. 연결을 확인해 주세요.');
      setStatus('error');
    });

    xhr.addEventListener('abort', () => {
      xhrRef.current = null;
      setStatus(file ? 'selected' : 'idle');
    });

    xhr.open('POST', '/api/resume/bootstrap');
    xhr.withCredentials = true;
    xhr.send(formData);
  }, [file, linkedinResult, status, onComplete]);

  /** 업로드 취소 */
  const handleCancel = useCallback(() => {
    xhrRef.current?.abort();
  }, []);

  /** 다시 시도 */
  const handleRetry = useCallback(() => {
    setStatus(file ? 'selected' : 'idle');
    setErrorMsg('');
    setUploadProgress(0);
  }, [file]);

  /** 파일 제거 (LinkedIn 상태도 함께 초기화, 단 prop으로 제공된 경우 제외) */
  const handleRemoveFile = useCallback(() => {
    setFile(null);
    setStatus('idle');
    setErrorMsg('');
    setUploadProgress(0);
    // linkedinProfile prop가 없을 때만 LinkedIn 상태 초기화
    if (!linkedinProfile) {
      setLinkedinResult(null);
      setLinkedinDone(false);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [linkedinProfile]);

  // ─── 렌더링 ───────────────────────────────────────────────────────────────────

  const isActive = status === 'uploading' || status === 'processing';
  const isDragOver = status === 'dragover';

  return (
    <div class={styles.page}>
      <div class={styles.card}>
        {/* 헤더 */}
        <div class={styles.header}>
          {onBack && (
            <button
              type="button"
              class={styles.backBtn}
              onClick={onBack}
              disabled={isActive}
              aria-label="이전 단계로"
            >
              ← 이전
            </button>
          )}
          <div class={styles.logo}>WL</div>
          <h1 class={styles.title}>이력서 불러오기</h1>
          <p class={styles.subtitle}>
            기존 이력서 PDF를 업로드하면 Living Resume 시스템이 초기화됩니다.
          </p>
        </div>

        {/* LinkedIn 연결 확인 배지 (이전 단계에서 가져온 경우) */}
        {linkedinProfile !== null && (
          <div class={styles.linkedinConnectedBadge} role="status">
            <span class={styles.linkedinConnectedIcon} aria-hidden="true">✓</span>
            <p class={styles.linkedinConnectedText}>
              LinkedIn 연결됨
              {linkedinProfile.data?.name
                ? ` — ${linkedinProfile.data.name}`
                : ''}
            </p>
          </div>
        )}

        {/* 드롭존 */}
        <div
          class={[
            styles.dropzone,
            isDragOver && styles.dropzoneActive,
            status === 'selected' && styles.dropzoneSelected,
            status === 'success' && styles.dropzoneSuccess,
            (status === 'error' && !file) && styles.dropzoneError,
            isActive && styles.dropzoneDisabled,
          ].filter(Boolean).join(' ')}
          role="button"
          tabIndex={isActive || status === 'success' ? -1 : 0}
          aria-label="PDF 파일을 여기에 드래그하거나 클릭해서 선택하세요"
          onClick={handleDropzoneClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleDropzoneClick(); }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            class={styles.fileInput}
            onChange={handleFileInputChange}
            aria-hidden="true"
            tabIndex={-1}
          />

          {/* 상태별 내용 */}
          {status === 'success' ? (
            <DropzoneSuccess />
          ) : file ? (
            <DropzoneFileInfo
              file={file}
              onRemove={isActive ? undefined : handleRemoveFile}
            />
          ) : (
            <DropzoneEmpty isDragOver={isDragOver} />
          )}
        </div>

        {/* 에러 메시지 */}
        {status === 'error' && errorMsg && (
          <p class={styles.errorMsg} role="alert">
            {errorMsg}
          </p>
        )}

        {/* 업로드 진행률 */}
        {(status === 'uploading' || status === 'processing') && (
          <UploadProgress
            status={status}
            progress={uploadProgress}
            onCancel={handleCancel}
          />
        )}

        {/* LinkedIn 입력 (파일 선택 완료 후 표시, 이전 단계에서 이미 처리된 경우 제외) */}
        {!linkedinProfile && (status === 'selected' || status === 'error') && file && (
          <div class={styles.linkedinSection}>
            {linkedinDone ? (
              /* 완료 상태: 요약 + 변경 버튼 */
              <div class={styles.linkedinDoneBadge}>
                <span class={styles.linkedinDoneText}>
                  LinkedIn:{' '}
                  {(linkedinResult?.source === 'fetch' || linkedinResult?.source === 'linkedin')
                    ? `가져오기 완료${linkedinResult.data?.name ? ` — ${linkedinResult.data.name}` : ''}`
                    : (linkedinResult?.source === 'paste' || linkedinResult?.source === 'manual_paste')
                    ? '붙여넣기 완료'
                    : '건너뜀'}
                </span>
                <button
                  type="button"
                  class={styles.linkedinChangeBtn}
                  onClick={() => {
                    setLinkedinDone(false);
                    setLinkedinResult(null);
                  }}
                  disabled={isActive}
                >
                  변경
                </button>
              </div>
            ) : (
              /* 미완료 상태: LinkedIn 입력 컴포넌트 */
              <LinkedInInput
                onData={(result) => {
                  setLinkedinResult(result);
                  setLinkedinDone(true);
                }}
                onSkip={() => {
                  setLinkedinResult(null);
                  setLinkedinDone(true);
                }}
                disabled={isActive}
              />
            )}
          </div>
        )}

        {/* 액션 버튼 */}
        <div class={styles.actions}>
          {status === 'error' && (
            <button
              type="button"
              class={styles.btnSecondary}
              onClick={handleRetry}
            >
              다시 시도
            </button>
          )}
          <button
            type="button"
            class={styles.btnPrimary}
            disabled={!file || isActive || status === 'success'}
            onClick={handleUpload}
          >
            {isActive ? (
              <>
                <span class={styles.spinnerInline} aria-hidden="true" />
                {status === 'uploading' ? `업로드 중… ${uploadProgress}%` : '분석 중…'}
              </>
            ) : status === 'success' ? (
              '완료'
            ) : (
              '이력서 업로드'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 서브 컴포넌트 ─────────────────────────────────────────────────────────────

/** 드롭존 — 파일 미선택 상태 */
function DropzoneEmpty({ isDragOver }) {
  return (
    <div class={styles.dropzoneContent}>
      <div class={styles.pdfIcon} aria-hidden="true">
        <PdfSvgIcon />
      </div>
      <p class={styles.dropzoneMain}>
        {isDragOver ? '여기에 놓으세요' : 'PDF를 드래그하거나 클릭해서 선택'}
      </p>
      <p class={styles.dropzoneSub}>최대 20MB · PDF 형식</p>
    </div>
  );
}

/** 드롭존 — 파일 선택 완료 상태 */
function DropzoneFileInfo({ file, onRemove }) {
  return (
    <div class={styles.fileInfo}>
      <div class={styles.fileIconWrapper} aria-hidden="true">
        <PdfSvgIcon small />
      </div>
      <div class={styles.fileMeta}>
        <span class={styles.fileName}>{file.name}</span>
        <span class={styles.fileSize}>{formatFileSize(file.size)}</span>
      </div>
      {onRemove && (
        <button
          type="button"
          class={styles.removeBtn}
          aria-label="파일 제거"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          <RemoveSvgIcon />
        </button>
      )}
    </div>
  );
}

/** 드롭존 — 업로드 성공 상태 */
function DropzoneSuccess() {
  return (
    <div class={styles.dropzoneContent}>
      <div class={styles.successIcon} aria-hidden="true">
        <CheckSvgIcon />
      </div>
      <p class={styles.dropzoneMain}>업로드 완료</p>
      <p class={styles.dropzoneSub}>이력서를 분석했습니다</p>
    </div>
  );
}

/** 진행률 표시 영역 */
function UploadProgress({ status, progress, onCancel }) {
  const isProcessing = status === 'processing';

  return (
    <div class={styles.progressWrapper} role="status" aria-live="polite">
      <div class={styles.progressHeader}>
        <span class={styles.progressLabel}>
          {isProcessing ? 'PDF 분석 중…' : `업로드 중 ${progress}%`}
        </span>
        {!isProcessing && (
          <button
            type="button"
            class={styles.cancelBtn}
            onClick={onCancel}
            aria-label="업로드 취소"
          >
            취소
          </button>
        )}
      </div>
      <div class={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={isProcessing ? undefined : progress}>
        <div
          class={[styles.progressBar, isProcessing && styles.progressBarIndeterminate].filter(Boolean).join(' ')}
          style={isProcessing ? undefined : { width: `${progress}%` }}
        />
      </div>
      {isProcessing && (
        <p class={styles.processingNote}>
          LLM이 이력서 구조를 분석하고 있습니다. 잠시 기다려 주세요.
        </p>
      )}
    </div>
  );
}

// ─── SVG 아이콘 ────────────────────────────────────────────────────────────────

function PdfSvgIcon({ small = false }) {
  const size = small ? 24 : 40;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 13h1.5a1.5 1.5 0 0 1 0 3H9v-3zm0 3v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 13v5m0 0h1.5a1.5 1.5 0 0 0 0-3H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RemoveSvgIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckSvgIcon() {
  return (
    <svg width={32} height={32} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 12l3 3 6-6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
