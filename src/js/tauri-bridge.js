/**
 * tauri-bridge.js
 * 
 * Provides a safe abstraction layer between the frontend and Tauri APIs.
 * When running in a standard browser environment, it provides Mocks to prevent crashes.
 */

const isTauri = !!window.__TAURI__;

if (!isTauri) {
  console.warn("[Tauri-Bridge] window.__TAURI__ is not defined. Running in Browser/Mock mode.");
}

/**
 * Safe invoke wrapper
 */
export async function invoke(command, args = {}) {
  if (isTauri) {
    return await window.__TAURI__.core.invoke(command, args);
  }
  
  console.log(`[Mock-Invoke] ${command}`, args);

  // Provide mock responses for common initialization calls
  switch (command) {
    case 'load_library':
      return [];
    case 'check_model_ready':
      return false;
    case 'get_gpu_recommendation':
      return { recommendation: "Browser Mock", gpu: "None" };
    case 'get_gpu_pack_status':
      return { installed: false, dir: 'C:\\Users\\<user>\\AppData\\Local\\LiveMRManager\\tools\\gpu', missing: ['nvinfer_10.dll', 'cudnn64_9.dll'], installing: false };
    case 'open_gpu_pack_dir':
      return;
    case 'install_gpu_pack':
      return;
    case 'cancel_gpu_pack_install':
      return;
    case 'list_model_presets':
      return [
        { key: 'mdx_vocal', label: 'MDX-Net (보컬 추출)', description: 'Kim Vocal 2 계열.' },
        { key: 'melband_roformer', label: 'Mel-Band RoFormer (파형 직접 입출력, GPU 권장)', description: 'STFT 내장 ONNX.' },
      ];
    case 'list_custom_models':
      return [];
    case 'add_custom_model':
      return { id: 'custom_mock', name: args.name, filename: 'custom_mock.onnx', url: args.source || '', presetKey: args.presetKey };
    case 'remove_custom_model':
      return;
    case 'list_all_models':
      return [
        { id: 'kim', name: 'Kim Vocal 2', isCustom: false, presetKey: null },
        { id: 'inst_hq_3', name: 'Inst HQ 3', isCustom: false, presetKey: null },
      ];
    case 'list_output_devices':
      return [
        { name: 'Speakers (Realtek High Definition Audio)', config: '48000Hz, 2ch', isActive: true },
        { name: 'VoiceMeeter Input (VB-Audio)', config: '44100Hz, 2ch', isActive: false },
        { name: 'OBS Virtual Audio Device', config: '48000Hz, 2ch', isActive: false },
      ];
    case 'get_output_device':
      return 'Speakers (Realtek High Definition Audio)';
    case 'set_output_device':
      return args.name || '시스템 기본 장치';
    case 'get_mix_state':
      return {
        vocalFader: 100, instFader: 100, vocalMuted: false, instMuted: false, vocalSolo: false, instSolo: false,
        monRouteVocal: true, monRouteInst: true, monRouteMetro: false,
        mrRouteVocal: false, mrRouteInst: true, mrRouteMetro: false,
        metroEnabled: false, metroBpm: 0, metroGain: 80, mrDevice: '',
        monDelayMs: 0, monEstLatencyMs: 50, mrDelayMs: 0, mrEstLatencyMs: 0,
        limiterEnabled: true,
      };
    case 'set_track_fader':
    case 'set_track_mute':
    case 'set_track_solo':
    case 'set_channel_route':
    case 'set_metronome':
    case 'set_bus_delay':
    case 'set_limiter':
      return;
    case 'get_dereverb_status':
      return { installed: false, enabled: true, dir: 'C:\\Users\\<user>\\AppData\\Local\\LiveMRManager\\tools\\dereverb', gpuPackInstalled: false };
    case 'set_dereverb_enabled':
    case 'open_dereverb_dir':
      return;
    case 'get_mr_output_device':
      return '';
    case 'set_mr_output_device':
      return args.name || '';
    case 'set_master_volume':
    case 'set_volume':
      return;
    case 'analyze_key_bpm':
      return { key: 'C', bpm: 120 };
    case 'get_audio_metadata':
      return { path: args.path, title: '샘플 곡', artist: '샘플 아티스트', duration: '4:47', thumbnail: '', source: 'youtube' };
    // 통합 검색 — 브라우저(정적 프리뷰)에서 UI를 시험할 수 있게 샘플 응답
    case 'search_youtube':
      return [
        { id: 'aaa11122233', url: 'https://youtu.be/aaa11122233', title: `${args.query} (Official Audio)`,
          channel: '샘플 아티스트', duration: 287, thumbnail: 'https://i.ytimg.com/vi/aaa11122233/mqdefault.jpg', official: true },
        { id: 'bbb44455566', url: 'https://youtu.be/bbb44455566', title: `[LIVE] ${args.query} 무대 영상`,
          channel: '샘플 방송', duration: 258, thumbnail: 'https://i.ytimg.com/vi/bbb44455566/mqdefault.jpg', official: false },
      ];
    case 'search_lyrics_sites':
      return [
        { title: `${args.query} 가사`, url: 'https://music.bugs.co.kr/track/1804107',
          snippet: '가사 미리보기 샘플 텍스트입니다.', domain: 'music.bugs.co.kr' },
        { title: `${args.query} - 노래 가사`, url: 'https://www.lyrics.co.kr/?p=270496',
          snippet: '두 번째 결과 샘플.', domain: 'lyrics.co.kr' },
      ];
    default:
      return null;
  }
}

/**
 * Safe event listener wrapper
 */
export async function listen(event, handler) {
  if (isTauri) {
    return await window.__TAURI__.event.listen(event, handler);
  }
  
  console.log(`[Mock-Listen] Subscribed to: ${event}`);
  return () => console.log(`[Mock-Unlisten] ${event}`);
}

/**
 * Safe window object
 */
export const appWindow = isTauri ? window.__TAURI__.window.getCurrentWindow() : {
  minimize: async () => console.log("[Mock-Window] Minimize"),
  maximize: async () => console.log("[Mock-Window] Maximize"),
  unmaximize: async () => console.log("[Mock-Window] Unmaximize"),
  isMaximized: async () => false,
  toggleMaximize: async () => console.log("[Mock-Window] Toggle Maximize"),
  close: async () => console.log("[Mock-Window] Close"),
  startDragging: async () => console.log("[Mock-Window] Start Dragging"),
  isVisible: async () => false,
  hide: async () => {},
  show: async () => {},
  setFocus: async () => {}
};

export async function toggleWindowMaximize() {
  if (!isTauri) {
    console.log("[Mock-Window] Toggle Maximize");
    return;
  }

  try {
    const maximized = await appWindow.isMaximized();
    if (maximized) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  } catch (error) {
    console.warn("[Window] maximize/unmaximize failed, falling back to toggleMaximize:", error);
    await appWindow.toggleMaximize();
  }
}

/**
 * Safe emit wrapper
 */
export async function emit(event, payload) {
  if (isTauri) {
    return await window.__TAURI__.event.emit(event, payload);
  }
  console.log(`[Mock-Emit] ${event}`, payload);
}

export class WebviewWindow {
  constructor(label, options) {
    if (isTauri) {
      return new window.__TAURI__.webviewWindow.WebviewWindow(label, options);
    }
    console.log(`[Mock-WebviewWindow] Created: ${label}`, options);
  }
}

export async function getAllWindows() {
  if (isTauri) return await window.__TAURI__.window.getAllWindows();
  return [appWindow];
}

/**
 * Safe convertFileSrc wrapper
 */
export function convertFileSrc(path, protocol = 'asset') {
  if (isTauri) {
    return window.__TAURI__.core.convertFileSrc(path, protocol);
  }
  return path; // Fallback to raw path in browser
}
