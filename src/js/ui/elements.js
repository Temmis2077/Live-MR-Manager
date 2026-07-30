/**
 * js/ui/elements.js - DOM Cache and References
 */

export const elements = {
  songGrid: null,
  libSearchInput: null,
  libGenreFilter: null,
  libCategoryFilter: null,
  libSortSelect: null,
  viewTitle: null,
  viewSubtitle: null,
  youtubeSection: null,
  localSection: null,
  libraryControls: null,
  dockTitle: null,
  dockArtist: null,
  dockThumb: null,
  dockThumbImg: null,
  thumbOverlay: null,
  togglePlayBtn: null,
  playbackBar: null,
  progressFill: null,
  timeCurrent: null,
  timeTotal: null,
  pitchSlider: null,
  tempoSlider: null,
  pitchVal: null,
  tempoVal: null,
  contextMenu: null,
  metadataModal: null,
  confirmModal: null,

  // Additional Controls
  volSlider: null,
  volSliderVal: null,
  vocalBalance: null,
  toggleVocal: null,
  toggleLyric: null,
  btnResetAudio: null,
  ytFetchBtn: null,
  ytUrlInput: null,
  btnPrev: null,
  btnNext: null,
  aiModelStatus: null,
  aiEngineProvider: null,
  gpuPackStatus: null,
  gpuPackDetail: null,
  btnOpenGpuPack: null,
  btnInstallGpuPack: null,
  btnCancelGpuPack: null,
  gpuPackProgress: null,
  gpuPackProgressBar: null,
  gpuPackProgressText: null,
  btnDownloadModel: null,
  btnDeleteModel: null,
  btnStartTrack: null,
  statusMsg: null,
  cudaRecommendBanner: null,
  viewControls: null,

  mgrFilterCategory: null,
  mgrFilterGenre: null,
  mgrFilterSync: null,
  toggleBroadcastMode: null,
  toggleBroadcastModeActive: null,
  broadcastTasksControl: null,
  btnMetadataSearch: null,
  metadataSearchResultsModal: null,
  searchResultsList: null,
  searchResultsClose: null,
  editVolume: null,
  editVolumeVal: null,
  viewport: null,
  scrollArea: null,

  // Curation
  curationOriginal: null,
  curationCategory: null,
  curationTranslated: null,
  editCurationOriginal: null,
  editCurationCategory: null,
  editCurationTranslated: null,
  unclassifiedTagsList: null,
  
  // Settings & Tasks
  settingsPage: null,
  livePage: null,
  tasksPage: null,
  overlayPage: null,
  activeTasksList: null,
  alignmentTasksList: null,
  taskBadge: null,
  btnExportBackup: null,
  btnImportBackup: null,
  btnRunRescue: null,
  btnExportSpreadsheet: null,
  btnExportSpreadsheetTemplate: null,
  btnImportSpreadsheet: null,
  themeModeSelect: null,
  mrCacheFormatSelect: null,
  searchSuggestions: null,
  lyricDrawer: null,
  lyricDrawerTrigger: null,
};

export function initDomReferences() {
  elements.songGrid = document.getElementById("song-grid");
  elements.viewTitle = document.getElementById("view-title");
  elements.viewSubtitle = document.getElementById("view-subtitle");
  elements.libSearchInput = document.getElementById("lib-search-input");
  elements.libGenreFilter = document.getElementById("lib-genre-filter");
  elements.libCategoryFilter = document.getElementById("lib-category-filter");
  elements.libSortSelect = document.getElementById("lib-sort-select");
  elements.libraryControls = document.getElementById("library-controls");
  elements.youtubeSection = document.getElementById("youtube-search");
  elements.localSection = document.getElementById("local-drop-section");

  elements.dockTitle = document.getElementById("dock-title");
  elements.dockArtist = document.getElementById("dock-artist");
  elements.dockThumb = document.getElementById("dock-thumb");
  elements.dockThumbImg = document.querySelector("#dock-thumb img");
  elements.thumbOverlay = document.getElementById("thumb-overlay");
  elements.togglePlayBtn = document.getElementById("btn-toggle-play");

  elements.playbackBar = document.getElementById("playback-bar");
  elements.progressFill = document.getElementById("progress-fill");
  elements.timeCurrent = document.getElementById("time-current");
  elements.timeTotal = document.getElementById("time-total");

  elements.pitchSlider = document.getElementById("pitch-slider");
  elements.tempoSlider = document.getElementById("tempo-slider");
  elements.pitchVal = document.getElementById("pitch-val");
  elements.tempoVal = document.getElementById("tempo-val");
  elements.btnResetAudio = document.getElementById("btn-reset-audio");

  elements.contextMenu = document.getElementById("context-menu");
  elements.metadataModal = document.getElementById("metadata-modal");
  elements.confirmModal = document.getElementById("confirm-modal");

  elements.volSlider = document.getElementById("master-volume-slider");
  elements.volSliderVal = document.getElementById("master-volume-val");
  elements.vocalBalance = document.getElementById("vocal-balance");
  elements.ytFetchBtn = document.getElementById("yt-fetch-btn");
  elements.ytUrlInput = document.getElementById("yt-url-input");
  elements.btnPrev = document.getElementById("btn-prev");
  elements.btnNext = document.getElementById("btn-next");
  elements.aiModelStatus = document.getElementById("ai-model-status");
  elements.aiEngineProvider = document.getElementById("ai-engine-provider");
  elements.gpuPackStatus = document.getElementById("gpu-pack-status");
  elements.gpuPackDetail = document.getElementById("gpu-pack-detail");
  elements.btnOpenGpuPack = document.getElementById("btn-open-gpu-pack");
  elements.btnInstallGpuPack = document.getElementById("btn-install-gpu-pack");
  elements.btnCancelGpuPack = document.getElementById("btn-cancel-gpu-pack");
  elements.gpuPackProgress = document.getElementById("gpu-pack-progress");
  elements.gpuPackProgressBar = document.getElementById("gpu-pack-progress-bar");
  elements.gpuPackProgressText = document.getElementById("gpu-pack-progress-text");
  elements.btnDownloadModel = document.getElementById("btn-download-model");
  elements.btnDeleteModel = document.getElementById("btn-delete-model");
  elements.btnStartTrack = document.getElementById("btn-start-track");
  elements.statusMsg = document.getElementById("system-status-msg");
  elements.toggleVocal = document.getElementById("toggle-vocal");
  elements.toggleLyric = document.getElementById("toggle-lyric");
  elements.cudaRecommendBanner = document.getElementById("cuda-recommend-banner");

  elements.mgrFilterCategory = document.getElementById("mgr-filter-category");
  elements.mgrFilterGenre = document.getElementById("mgr-filter-genre");
  elements.mgrFilterSync = document.getElementById("mgr-filter-sync");
  elements.viewControls = document.getElementById("view-controls");
  elements.toggleBroadcastMode = document.getElementById("toggle-broadcast-mode");
  elements.toggleBroadcastModeActive = document.getElementById("toggle-broadcast-mode-tasks");
  elements.broadcastTasksControl = document.getElementById("broadcast-tasks-control");
  elements.btnMetadataSearch = document.getElementById("btn-metadata-search");
  elements.metadataSearchResultsModal = document.getElementById("metadata-search-results-modal");
  elements.searchResultsList = document.getElementById("search-results-list");
  elements.searchResultsClose = document.getElementById("search-results-close");
  elements.editVolume = document.getElementById("edit-volume");
  elements.editVolumeVal = document.getElementById("edit-volume-val");

  elements.curationOriginal = document.getElementById("curation-original");
  elements.curationCategory = document.getElementById("curation-category");
  elements.curationTranslated = document.getElementById("curation-translated");
  elements.unclassifiedTagsList = document.getElementById("unclassified-tags-list");
  elements.scrollArea = document.querySelector(".scroll-area");
  elements.viewport = document.querySelector(".viewport");

  // Settings & Tasks
  elements.settingsPage = document.getElementById("settings-page");
  elements.livePage = document.getElementById("live-page");
  elements.tasksPage = document.getElementById("tasks-page");
  elements.overlayPage = document.getElementById("overlay-tab");
  elements.activeTasksList = document.getElementById("separation-tasks-list");
  elements.alignmentTasksList = document.getElementById("alignment-tasks-list");
  elements.taskBadge = document.getElementById("task-badge");
  elements.btnExportBackup = document.getElementById("btn-export-backup");
  elements.btnImportBackup = document.getElementById("btn-import-backup");
  elements.btnRunRescue = document.getElementById("btn-run-rescue");
  elements.btnExportSpreadsheet = document.getElementById("btn-export-spreadsheet");
  elements.btnExportSpreadsheetTemplate = document.getElementById("btn-export-spreadsheet-template");
  elements.btnImportSpreadsheet = document.getElementById("btn-import-spreadsheet");
  elements.themeModeSelect = document.getElementById("theme-mode-select");
  elements.mrCacheFormatSelect = document.getElementById("mr-cache-format-select");
  elements.searchSuggestions = document.getElementById("search-suggestions");
  elements.lyricDrawer = document.getElementById("lyric-drawer");
  elements.lyricDrawerTrigger = document.getElementById("lyric-drawer-trigger");
}
