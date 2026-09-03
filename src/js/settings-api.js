/**
 * settings-api.js - Settings, backup, and system command wrappers
 */

import { invoke } from './tauri-bridge.js';
import { collectBackupSettings, restoreBackupSettings } from './backup-settings.js';

/**
 * 라이브러리 + 앱 설정을 한 파일로 내보낸다.
 * 설정의 의미는 프런트만 알고 백엔드는 문자열 맵을 통과시키기만 한다.
 */
export async function exportBackup() {
  return invoke('export_backup', { appSettings: collectBackupSettings() });
}

/**
 * 백업을 되돌린다. 곡은 백엔드가 병합하고, 설정은 여기서 localStorage에 쓴다.
 * 옛 백업(곡 배열만 있는 v1)이면 설정이 비어 있으므로 곡만 복원된다.
 *
 * @returns {{added:number, settingsRestored:number}} 사용자에게 보여줄 요약
 */
export async function importBackup() {
  const result = await invoke('import_backup');
  // 옛 백엔드/모의 백엔드가 아무것도 안 돌려주는 경우까지 감안한다.
  const added = result?.added ?? 0;
  const { restored } = restoreBackupSettings(result?.appSettings);
  return { added, settingsRestored: restored };
}

export async function exportLibrarySpreadsheet(templateOnly = false) {
  return invoke('export_library_spreadsheet', { templateOnly });
}

export async function importLibrarySpreadsheet() {
  return invoke('import_library_spreadsheet');
}

export async function runCacheRescue() {
  return invoke('run_cache_rescue');
}

export async function setBroadcastMode(enabled) {
  return invoke('set_broadcast_mode', { enabled: !!enabled });
}

export async function getMrCacheFormat() {
  return invoke('get_mr_cache_format');
}

export async function setMrCacheFormat(format) {
  return invoke('set_mr_cache_format', { format });
}

export async function openCacheFolder() {
  return invoke('open_cache_folder');
}

/** 로그 폴더 열기 — 버그 신고에 app.log를 첨부할 수 있게. */
export async function openLogFolder() {
  return invoke('open_log_folder');
}

export async function openAppPage(url) {
  return invoke('open_app_update_page', { url });
}

export async function checkForAppUpdate() {
  return invoke('check_for_app_update');
}
