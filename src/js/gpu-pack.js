/**
 * GPU 가속 팩 다운로드/설치 컨트롤 (AI 프로세싱 설정).
 * 백엔드: install_gpu_pack / cancel_gpu_pack_install / get_gpu_pack_status.
 * 진행률 이벤트: 'gpu-pack-install-progress'.
 */
import { invoke, listen } from './tauri-bridge.js';
import { elements } from './ui/elements.js';
import { refreshGpuPackStatus } from './ui/components.js';

async function notify(message, type) {
  try {
    const { showNotification } = await import('./utils.js');
    showNotification(message, type);
  } catch (_) {}
}

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** 다운로드 중 UI(진행 바 표시, 버튼 상태) 토글. */
function setInstalling(on) {
  if (elements.gpuPackProgress) elements.gpuPackProgress.hidden = !on;
  if (elements.btnInstallGpuPack) elements.btnInstallGpuPack.hidden = on;
  if (elements.btnCancelGpuPack) elements.btnCancelGpuPack.hidden = !on;
  if (elements.btnOpenGpuPack) elements.btnOpenGpuPack.disabled = on;
}

function renderProgress(p) {
  const bar = elements.gpuPackProgressBar;
  const text = elements.gpuPackProgressText;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, p.percent || 0)).toFixed(1)}%`;
  if (!text) return;

  const partInfo = p.partCount > 1 ? ` · 파트 ${(p.partIndex || 0) + 1}/${p.partCount}` : '';
  switch (p.phase) {
    case 'download':
      text.textContent = `다운로드 중 ${Math.floor(p.percent || 0)}% (${fmtBytes(p.receivedBytes)} / ${fmtBytes(p.totalBytes)})${partInfo}`;
      break;
    case 'extract':
      text.textContent = `압축 푸는 중…${partInfo}`;
      break;
    case 'verify':
      text.textContent = '설치 확인 중…';
      break;
    default:
      break;
  }
}

export function initGpuPackControls() {
  const btnInstall = elements.btnInstallGpuPack;
  const btnCancel = elements.btnCancelGpuPack;

  // 진행률 이벤트 구독(모듈 로드 시 1회).
  listen('gpu-pack-install-progress', async (event) => {
    const p = event?.payload || {};
    if (p.phase === 'done') {
      setInstalling(false);
      if (elements.gpuPackProgressText) elements.gpuPackProgressText.textContent = '';
      await refreshGpuPackStatus();
      await notify('GPU 가속 팩 설치 완료.', 'success');
      return;
    }
    if (p.phase === 'error' || p.phase === 'cancelled') {
      setInstalling(false);
      if (elements.gpuPackProgressText) elements.gpuPackProgressText.textContent = '';
      await refreshGpuPackStatus();
      if (p.phase === 'error') await notify('GPU 팩 설치 실패: ' + (p.message || '알 수 없는 오류'), 'error');
      else await notify('GPU 팩 설치를 취소했습니다.', 'info');
      return;
    }
    renderProgress(p);
  }).catch(() => {});

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      setInstalling(true);
      renderProgress({ phase: 'download', percent: 0, receivedBytes: 0, totalBytes: 0, partCount: 0 });
      try {
        // install_gpu_pack는 설치 끝까지 await된다. 진행률은 이벤트로 갱신.
        await invoke('install_gpu_pack');
      } catch (err) {
        // 에러/취소는 이벤트로도 오지만, invoke 자체 거부(이미 진행 중 등)도 처리.
        setInstalling(false);
        if (elements.gpuPackProgressText) elements.gpuPackProgressText.textContent = '';
        await notify('GPU 팩 설치 실패: ' + err, 'error');
        await refreshGpuPackStatus();
      }
    });
  }

  if (btnCancel) {
    btnCancel.addEventListener('click', async () => {
      btnCancel.disabled = true;
      try {
        await invoke('cancel_gpu_pack_install');
      } catch (_) {
      } finally {
        btnCancel.disabled = false;
      }
    });
  }
}
