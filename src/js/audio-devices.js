/**
 * 출력 장치 실시간 전환 UI.
 *
 * 백엔드(list_output_devices / get_output_device / set_output_device)와 연결해
 * 설정 화면의 <select id="output-device-select">를 채우고, 선택 시 재생 중에도
 * 즉시 장치를 바꾼다. 빈 값("")은 시스템 기본 장치를 뜻한다.
 */
import { audioDeviceService } from '../ipc/services/audio.js';

async function notify(message, type) {
  try {
    const { showNotification } = await import('./utils.js');
    showNotification(message, type);
  } catch (_) {}
}

let busy = false;

export async function refreshOutputDevices() {
  const sel = document.getElementById('output-device-select');
  if (!sel) return;
  let devices = [];
  let active = '';
  try {
    [devices, active] = await Promise.all([
      audioDeviceService.listOutputDevices(),
      audioDeviceService.getOutputDevice(),
    ]);
  } catch (err) {
    console.error('출력 장치 목록 실패:', err);
    sel.innerHTML = '<option value="">기본 장치</option>';
    return;
  }
  // "기본 장치" 항목 + 각 장치. 현재 활성 장치를 선택 상태로.
  const opts = ['<option value="">시스템 기본 장치</option>'];
  for (const d of devices) {
    const label = d.config ? `${d.name} (${d.config})` : d.name;
    const selected = d.isActive ? ' selected' : '';
    // 값에 장치 이름을 그대로 담는다(HTML 이스케이프).
    const esc = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    opts.push(`<option value="${esc(d.name)}"${selected}>${esc(label)}</option>`);
  }
  sel.innerHTML = opts.join('');
  // 활성 장치가 목록에 없으면(기본 장치 사용 중) 첫 항목 유지.
  if (!devices.some((d) => d.isActive)) sel.value = '';
}

export function initOutputDeviceControls() {
  const sel = document.getElementById('output-device-select');
  const refreshBtn = document.getElementById('btn-refresh-output-devices');
  if (!sel) return;

  sel.addEventListener('change', async () => {
    if (busy) return;
    busy = true;
    const name = sel.value; // "" = 기본
    sel.disabled = true;
    try {
      const resolved = await audioDeviceService.setOutputDevice(name);
      await notify(`출력 장치 전환: ${resolved}`, 'success');
    } catch (err) {
      await notify('출력 장치 전환 실패: ' + err, 'error');
      await refreshOutputDevices(); // 실패 시 실제 상태로 되돌림
    } finally {
      sel.disabled = false;
      busy = false;
    }
  });

  if (refreshBtn) refreshBtn.addEventListener('click', () => refreshOutputDevices());
}
