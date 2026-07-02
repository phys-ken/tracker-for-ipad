// Physics Tracker - app.js
// iPadおよび各種ブラウザ向け動画解析ウェブアプリコアロジック

// --- 状態管理を一元化 ---
const appState = {
    videoElement: null,
    canvas: null,
    ctx: null,
    isPlaying: false,
    videoDuration: 0,
    videoFps: 30,
    fpsMeasured: false,    // 実測FPSが確定したか
    fpsManual: false,      // ユーザーが手動でFPSを上書きしたか
    isScanning: false,     // 読込直後のフレーム走査中か
    currentFrame: 0,
    totalFrames: 0,
    frameTimes: [],        // 実測した各フレームの提示時刻(mediaTime)。空ならfps換算にフォールバック
    viewState: { scale: 1, offsetX: 0, offsetY: 0 },
    // 中央十字＋確定方式: 通常はトラッキング。原点/スケール設定中だけ pendingCapture が立つ
    pendingCapture: null, // null | 'origin' | 'scale'
    trackingData: [], // [{ id, frame, time, x, y, objectId }]
    activeObjectId: 1,
    trackingStepSize: 1,
    calibration: {
        origin: null,         // { x, y } (動画ピクセル座標)
        scaleRatio: null,     // cm/px
        scaleStart: null,     // { x, y }
        scaleEnd: null,       // { x, y }
        scaleActual: 0,       // cm
        scaleTempStart: null  // 一時始点
    },
    targetColor: null,        // { r, g, b } サンプリングされた色
    isAutoTracking: false,    // 自動追跡実行フラグ
    selectedPointId: null,    // 現在選択されているトラックポイントのID
    videoName: null,          // 現在読み込み中の動画のファイル名（復元判定の指紋用）
    videoSize: 0,             // 同・ファイルサイズ(bytes)
    rangeIn: 0,               // 解析範囲の開始コマ（イン点）
    rangeOut: 0               // 解析範囲の終了コマ（アウト点）
};

// グローバル（window）に公開してテストスイートからアクセス可能にする
window.appState = appState;

// カラーマップ (10色)
const COLOR_MAP = [
    '#ff4757', // 赤
    '#2ed573', // 緑
    '#1e90ff', // 青
    '#ffa502', // オレンジ
    '#eccc68', // 黄色
    '#ff6b81', // ピンク
    '#70a1ff', // 水色
    '#7bed9f', // 黄緑
    '#a29bfe', // 紫
    '#000000'  // 黒
];

// オートトラッカー用内部Canvas
let offscreenCanvas = null;
let offscreenCtx = null;

// ピンチズーム操作時の前フレーム状態保持用変数 (吸い付きズーム用)
let activePointers = []; // Pointer Events 用の配列
let lastPointerPos = null; // ドラッグパン用の一時座標
let lastPinchDist = 0;
let lastPinchCenter = null;
let isPanning = false;
let isDraggingPoint = false;
let draggedPointIndex = -1;

// デバッグ用ログ出力
function logDebug(message) {
    const logList = document.getElementById('debug-log-list');
    if (!logList) return;
    const item = document.createElement('div');
    item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logList.appendChild(item);
    logList.scrollTop = logList.scrollHeight;
    console.log(message);
}

// --- Undo 履歴 ＆ 自動保存 -------------------------------------------------
// （UndoボタンのUI配線・手順ガイド等の本格対応は Stage4。ここでは中核のみ）
const undoStack = [];
const UNDO_LIMIT = 50;
const STORAGE_KEY = 'tracker_for_ipad_state_v1';

// 変更直前の状態をスナップショットして履歴に積む
function pushHistory() {
    try {
        undoStack.push(JSON.stringify({
            trackingData: appState.trackingData,
            calibration: appState.calibration
        }));
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    } catch (e) { /* 容量超過などは無視 */ }
    updateUndoButton();
}

function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    try {
        const obj = JSON.parse(snap);
        appState.trackingData = obj.trackingData || [];
        appState.calibration = obj.calibration || appState.calibration;
        setSelectedPoint(null);
        refreshCalibrationLabels();
        persistState();
        updateDataTable();
        drawVideoFrame();
        updateGraph();
        logDebug('元に戻しました');
    } catch (e) { logDebug('Undo失敗'); }
    updateUndoButton();
}

function updateUndoButton() {
    const btn = document.getElementById('btn-undo');
    if (btn) btn.disabled = undoStack.length === 0;
}

// localStorage への自動保存（動画自体は保存せず、計測データと校正のみ）
// video フィンガープリント(名前・サイズ・長さ)も併せて保存し、次回同じ動画を
// 読み込んだ時だけ復元を提案できるようにする。
function persistState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            trackingData: appState.trackingData,
            calibration: appState.calibration,
            videoFps: appState.videoFps,
            trackingStepSize: appState.trackingStepSize,
            activeObjectId: appState.activeObjectId,
            video: {
                name: appState.videoName,
                size: appState.videoSize,
                duration: appState.videoDuration
            }
        }));
    } catch (e) { /* プライベートモード等では無視 */ }
}

// 新しい動画を読み込む直前に呼ぶ：前回の計測データ・校正・Undo履歴・選択状態を
// 全リセットする（「前回データの中途半端な干渉」対策）。表示も同期する。
function resetForNewVideo() {
    appState.trackingData = [];
    appState.calibration = {
        origin: null,
        scaleRatio: null,
        scaleStart: null,
        scaleEnd: null,
        scaleActual: 0,
        scaleTempStart: null
    };
    undoStack.length = 0;
    setSelectedPoint(null);
    updateDataTable();
    updateGraph();
    refreshCalibrationLabels();
    updateUndoButton();
}

// 保存データのフィンガープリント(名前・サイズ・長さ±0.1s)が現在の動画と一致するか判定
function persistedFingerprintMatches(obj) {
    const v = obj && obj.video;
    return !!v
        && v.name === appState.videoName
        && v.size === appState.videoSize
        && typeof v.duration === 'number'
        && Math.abs(v.duration - appState.videoDuration) <= 0.1
        && Array.isArray(obj.trackingData)
        && obj.trackingData.length > 0;
}

// 動画の指紋が前回保存データと一致する場合のみ「復元しますか？」を提案する。
// 一致しない場合は黙って古いデータを破棄する（中途半端な干渉を残さないため）。
function offerRestoreIfMatching() {
    let obj = null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        obj = JSON.parse(raw);
    } catch (e) { return; }
    if (!obj) return;

    if (!persistedFingerprintMatches(obj)) {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
        return;
    }

    showConfirmDialog(
        "前回の計測データを復元しますか？",
        `同じ動画（${appState.videoName}）の前回の計測データが見つかりました。復元しますか？`,
        () => {
            appState.trackingData = obj.trackingData;
            if (obj.calibration) appState.calibration = obj.calibration;
            if (obj.videoFps) appState.videoFps = obj.videoFps;
            if (obj.trackingStepSize) appState.trackingStepSize = obj.trackingStepSize;
            if (obj.activeObjectId) appState.activeObjectId = obj.activeObjectId;
            updateDataTable();
            updateGraph();
            refreshCalibrationLabels();
            updateUndoButton();
            logDebug("前回の計測データを復元しました。");
        },
        () => {
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
            logDebug("前回データの復元を見送り、破棄しました。");
        }
    );
}

// 校正ラベル（原点/スケール表示）を現在の状態に同期
function refreshCalibrationLabels() {
    const o = appState.calibration.origin;
    const infoO = document.getElementById('info-origin');
    if (infoO) infoO.textContent = o ? `(${o.x.toFixed(0)}, ${o.y.toFixed(0)})` : '未設定';
    const infoS = document.getElementById('info-scale');
    if (infoS) infoS.textContent = appState.calibration.scaleRatio ? `${appState.calibration.scaleRatio.toFixed(3)} cm/px` : '未設定';
}

// --- DOM初期化 ---
document.addEventListener('DOMContentLoaded', () => {
    logDebug("アプリケーション起動");
    
    appState.videoElement = document.getElementById('hidden-video');
    appState.canvas = document.getElementById('tracker-canvas');
    appState.ctx = appState.canvas.getContext('2d');
    
    // 各種初期化
    setupFileUpload();
    setupSampleLoad();
    setupPlaybackControls();
    setupRangeControls();
    setupDebugConsole();
    setupCanvasTouch();
    setupModeButtons();
    setupSettingsInputs();
    setupObjectButtons();
    setupExport();
    setupStrobe();
    setupAutoTrackerUI();
    setupGraphEvents();
    setupDeletionEvent();
    setupUndo();
    setupFpsInput();

    // ウィンドウリサイズ時の処理
    window.addEventListener('resize', handleResize);
    window.addEventListener('resize', updateGraph);

    // 起動時の無条件復帰は廃止。動画読込時にフィンガープリントが一致した場合のみ
    // offerRestoreIfMatching() が復元を提案する（setupFileUpload / setupSampleLoad 参照）。
    updateUndoButton();
    updateActionHint();
    updateStepGuide();
    updateObjectButtons();
    refreshFpsUI();

    // 空スタート: 動画はユーザーが「動画を選択」または「サンプルで試す」で読み込む
    logDebug("起動完了。動画を読み込んでください。");
});

// --- サンプル動画の読み込み（fetch経由のバックドア） ---
// 生徒の「お試し」用 兼 自動テスト用。アップロードダイアログを回避して
// サーバ上の sample.mp4 を直接 Blob 化して読み込む。
function setupSampleLoad() {
    const btn = document.getElementById('btn-load-sample');
    if (btn) btn.addEventListener('click', loadSampleVideo);
}

function loadSampleVideo() {
    logDebug("サンプル動画 (sample.mp4) を読み込みます...");
    fetch('sample.mp4')
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
        })
        .then(blob => {
            if (appState.videoElement.src && appState.videoElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(appState.videoElement.src);
            }
            // 新しい動画を読み込む前に、前回データの中途半端な干渉を防ぐため全リセット
            resetForNewVideo();
            appState.videoName = 'sample.mp4';
            appState.videoSize = blob.size;
            appState.videoBlob = blob; // コンテナ解析(mp4box)用に元データを保持

            const url = URL.createObjectURL(blob);
            const hintOverlay = document.getElementById('hint-overlay');
            if (hintOverlay) hintOverlay.style.opacity = '0';
            appState.fpsManual = false;
            appState.fpsMeasured = false;
            appState.frameTimes = [];
            appState.videoElement.src = url;
            appState.videoElement.load();
        })
        .catch(err => logDebug(`サンプル読み込み失敗: ${err.message}（ローカルサーバ経由で開いてください）`));
}

function setupUndo() {
    const btn = document.getElementById('btn-undo');
    if (btn) btn.addEventListener('click', undo);
}

// --- デバッグコンソールのトグル ---
function setupDebugConsole() {
    const btnToggle = document.getElementById('btn-toggle-debug');
    const consoleDiv = document.getElementById('debug-console');
    const btnClear = document.getElementById('btn-clear-debug');
    
    if (btnToggle && consoleDiv) {
        btnToggle.addEventListener('click', () => {
            consoleDiv.style.display = consoleDiv.style.display === 'none' ? 'flex' : 'none';
        });
    }
    
    if (btnClear) {
        btnClear.addEventListener('click', () => {
            const logList = document.getElementById('debug-log-list');
            if (logList) logList.innerHTML = '';
        });
    }
}

// --- 動画のアップロード・ロード ---
function setupFileUpload() {
    const uploadInput = document.getElementById('video-upload');
    const hintOverlay = document.getElementById('hint-overlay');
    
    if (uploadInput) {
        uploadInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            logDebug(`ファイル選択: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);

            if (appState.videoElement.src && appState.videoElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(appState.videoElement.src);
            }

            // 新しい動画を読み込む前に、前回データの中途半端な干渉を防ぐため全リセット
            resetForNewVideo();
            appState.videoName = file.name;
            appState.videoSize = file.size;
            appState.videoBlob = file; // コンテナ解析(mp4box)用に元データを保持

            const fileUrl = URL.createObjectURL(file);
            if (hintOverlay) hintOverlay.style.opacity = '0';

            // 新しい動画では実FPSを測り直す
            appState.fpsManual = false;
            appState.fpsMeasured = false;
            appState.frameTimes = [];
            appState.videoElement.src = fileUrl;
            appState.videoElement.load();
        });
    }
    
    appState.videoElement.addEventListener('loadedmetadata', () => {
        appState.videoDuration = appState.videoElement.duration;
        appState.totalFrames = Math.floor(appState.videoDuration * appState.videoFps);
        appState.currentFrame = 0;
        
        logDebug(`動画ロード完了: 長さ ${appState.videoDuration.toFixed(2)}s, 総フレーム数 ${appState.totalFrames} (FPS: ${appState.videoFps})`);
        
        const slider = document.getElementById('frame-slider');
        if (slider) {
            slider.disabled = false;
            slider.max = appState.totalFrames;
            slider.value = 0;
        }
        
        refreshFpsUI();
        updateTimeDisplay();
        handleResize();
        updateGraph();
        updateStepGuide();

        // 動画の指紋(名前・サイズ・長さ)が前回保存データと一致する場合のみ復元を提案
        offerRestoreIfMatching();

        // 読込直後に全フレームをシーク走査し、実フレーム時刻表＋重複除外を確定して先頭へ
        startFrameScan();
    });
    
    appState.videoElement.addEventListener('canplay', () => {
        updateOffscreenCanvas();
        drawVideoFrame();
    });
    
    appState.videoElement.addEventListener('seeked', () => {
        if (appState.isScanning) return; // 走査中の大量シークでは本描画をスキップ（高速化）
        updateOffscreenCanvas();
        drawVideoFrame();
        updateTimeDisplay();
        const lblFrame = document.getElementById('lbl-frame');
        if (lblFrame) lblFrame.textContent = appState.currentFrame;
    });
    
    appState.videoElement.addEventListener('error', () => {
        logDebug(`動画エラー発生: ${appState.videoElement.error ? appState.videoElement.error.message : 'Unknown'}`);
    });
}

// --- フレーム走査（fps非依存の実フレーム時刻表＋重複除外） -----------------
// 動画をシークして全フレームの実時刻(mediaTime)を取得し、重複フレームを除外する。
// 再生せずシークするので高fps(スロー)でもコマ脱落しない。rVFC非対応の古い端末
// （格安スマホ等）では (frame+0.5)/fps の換算へ優雅に劣化し、壊れない。
let rvfcSupported = typeof HTMLVideoElement !== 'undefined'
    && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
// テスト用：rVFC非対応端末（古い格安スマホ等）を擬似的に再現する
if (typeof window !== 'undefined') window.__setRvfc = (b) => { rvfcSupported = !!b; };

// 走査用の縮小キャンバス（重複判定の画素比較に使用）
let scanCanvas = null, scanCtx = null;
const SCAN_W = 160, SCAN_H = 90;
function frameSignature(v) {
    if (!scanCanvas) {
        scanCanvas = document.createElement('canvas');
        scanCanvas.width = SCAN_W; scanCanvas.height = SCAN_H;
        scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    }
    try { scanCtx.drawImage(v, 0, 0, SCAN_W, SCAN_H); }
    catch (e) { return null; }
    return scanCtx.getImageData(0, 0, SCAN_W, SCAN_H).data;
}
// 2フレーム間で「明確に変化した画素」の割合(0..1)。真の複製はほぼ0。
// 局所的な小さな動き（小さなボールが1px動く等）でも、その周辺の画素は変化するので拾える。
function changedFraction(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let changed = 0; const n = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (d > 24) changed++;
    }
    return changed / n;
}
const DUP_FRACTION = 0.0008;  // 変化画素 < 0.08% ＝ ほぼ画素一致 ＝ エンコード複製
const DUP_SAFETY_MAX = 0.20;  // 全体の20%超が複製判定なら誤検出とみなし、除外しない

// シークして「表示されたフレーム」の mediaTime と署名を返す
function getFrameAt(v, targetTime) {
    return new Promise(resolve => {
        let done = false;
        const finish = (mt) => { if (done) return; done = true; resolve({ mediaTime: mt, sig: frameSignature(v) }); };
        if (rvfcSupported) {
            v.requestVideoFrameCallback((now, meta) => finish(meta.mediaTime));
        } else {
            const onSeeked = () => { v.removeEventListener('seeked', onSeeked); finish(v.currentTime); };
            v.addEventListener('seeked', onSeeked);
        }
        v.currentTime = Math.max(0, Math.min((v.duration || 0) - 1e-4, targetTime));
        setTimeout(() => finish(v.currentTime), 2500); // 安全網（応答が無い端末向け）
    });
}

// 進捗表示（ダイアログではなくヒントオーバーレイをインライン流用）
function showScanProgress(ratio) {
    const o = document.getElementById('hint-overlay');
    if (!o) return;
    o.style.opacity = '1';
    const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    const p = o.querySelector('p');
    if (p) p.textContent = `解析準備中… ${pct}%`;
    const icon = o.querySelector('.material-icons-round');
    if (icon) icon.textContent = 'hourglass_top';
}
function hideScanProgress() {
    const o = document.getElementById('hint-overlay');
    if (o) o.style.opacity = '0';
}

// --- コンテナ解析（mp4box.js）: デコードもシークもせず実サンプル時刻を瞬時に取得 ---
// iPad撮影の .mov/.mp4（H.264/HEVC・スロモVFR含む）はここで数百msで時刻表が完成する。
// パース不能な形式や検証NG時のみ、従来のシーク走査へフォールバックする。
async function buildTimesFromContainer(blob) {
    if (typeof MP4Box === 'undefined' || !blob) return null;
    try {
        const buf = await blob.arrayBuffer();
        return await new Promise((resolve) => {
            const mp4 = MP4Box.createFile();
            let nbSamples = 0;
            const times = [];
            const to = setTimeout(() => resolve(null), 8000); // 安全網
            const done = (r) => { clearTimeout(to); resolve(r); };
            mp4.onError = () => done(null);
            mp4.onReady = (info) => {
                const track = (info.videoTracks && info.videoTracks[0]) || null;
                if (!track || !track.nb_samples) { done(null); return; }
                nbSamples = track.nb_samples;
                mp4.setExtractionOptions(track.id, null, { nbSamples: nbSamples });
                mp4.start();
            };
            mp4.onSamples = (id, user, samples) => {
                for (const s of samples) times.push(s.cts / s.timescale);
                if (nbSamples && times.length >= nbSamples) done(times);
            };
            buf.fileStart = 0;
            mp4.appendBuffer(buf);
            mp4.flush();
        });
    } catch (e) { return null; }
}

// コンテナ由来の時刻表が <video> の再生時間軸と一致しているか、実シークで数点だけ検証。
// （MP4のedit listでcts軸と再生軸がずれる動画があるため。ずれていたら走査へ切替）
async function verifyTimesAgainstVideo(v, times) {
    if (!rvfcSupported) return true; // rVFC無し端末は検証不能→信じる（換算より高精度）
    const picks = [0, Math.floor((times.length - 1) / 2)];
    for (const i of picks) {
        const lo = times[i];
        const hi = (i < times.length - 1) ? times[i + 1] : lo + (times[i] - times[i - 1] || 1 / 30);
        const fr = await getFrameAt(v, (lo + hi) / 2);
        // 表示フレームの実時刻が期待区間(±半コマ)に入っていればOK
        const tol = (hi - lo) * 0.75;
        if (Math.abs(fr.mediaTime - lo) > tol) return false;
    }
    return true;
}

// 指定の時刻表に対し、実フレームを1枚ずつ表示してピクセル署名で複製コマを除外する。
// コマ数が少ない（＝短い動画 or 解析範囲確定後）ときだけ呼ぶこと。
async function dedupTimesByPixel(v, times) {
    const kept = [];
    let lastSig = null, skipped = 0;
    for (let i = 0; i < times.length; i++) {
        const lo = times[i];
        const hi = (i < times.length - 1) ? times[i + 1] : lo + (lo - (times[i - 1] || lo - 1 / 30));
        const fr = await getFrameAt(v, (lo + hi) / 2);
        const isDup = lastSig && changedFraction(fr.sig, lastSig) < DUP_FRACTION;
        if (isDup) { skipped++; } else { kept.push(times[i]); lastSig = fr.sig; }
        showScanProgress((i + 1) / times.length);
    }
    // 誤検出セーフティ（2割超が複製判定なら除外しない）
    if (skipped > 0 && skipped <= times.length * DUP_SAFETY_MAX) return { times: kept, skipped };
    return { times: times.slice(), skipped: 0 };
}

// 読込時にその場で複製除外まで済ませてよいコマ数の上限（超える場合は範囲確定後に実施）
const DEDUP_AT_LOAD_MAX = 64;

// 読込直後に呼ばれる。コンテナ解析→（短尺なら）複製除外。不能時のみシーク走査。
async function startFrameScan() {
    const v = appState.videoElement;
    if (!v || v.readyState < 1) return;
    if (appState.fpsManual) { // 手動fps指定時は走査せず換算
        appState.frameTimes = [];
        appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * appState.videoFps));
        resetAnalysisRange();
        seekToFrame(0); return;
    }
    appState.isScanning = true;
    appState.dedupDone = false;
    showScanProgress(0);
    let result = null;

    // 1) コンテナ解析（瞬時・シーク不要）
    try {
        let times = await buildTimesFromContainer(appState.videoBlob);
        if (times && times.length >= 2) {
            const tMin = times.reduce((a, b) => (b < a ? b : a), Infinity);
            times = buildFrameTimeTable(times.map(t => t - tMin));
            if (await verifyTimesAgainstVideo(v, times)) {
                if (times.length <= DEDUP_AT_LOAD_MAX) {
                    const d = await dedupTimesByPixel(v, times);
                    result = { times: d.times, skipped: d.skipped, seeks: 0 };
                    appState.dedupDone = true;
                } else {
                    result = { times, skipped: 0, seeks: 0 };
                }
                logDebug('コンテナ解析で時刻表を取得（シーク走査なし）');
            } else {
                logDebug('コンテナ時刻表が再生軸と不一致。シーク走査に切替えます。');
            }
        }
    } catch (e) { logDebug('コンテナ解析に失敗: ' + (e && e.message)); }

    // 2) フォールバック: 従来のシーク走査
    if (!result) {
        try { result = rvfcSupported ? await scanAllFrames(v) : await scanGridFallback(v); }
        catch (e) { logDebug('フレーム走査に失敗: ' + (e && e.message)); }
        if (result) appState.dedupDone = true; // 走査は複製除外込み
    }
    appState.isScanning = false;
    hideScanProgress();

    if (result && result.times.length >= 2) {
        appState.frameTimes = result.times;
        appState.totalFrames = result.times.length - 1;
        appState.fpsMeasured = true;
        appState.videoFps = friendlyFpsFromTimes(result.times);
        logDebug(`フレーム走査完了: ${result.times.length}コマ（実時刻表）`
            + (result.skipped ? `／重複 ${result.skipped} コマを自動除外` : '')
            + (result.seeks ? `／seek ${result.seeks}回` : ''));
    } else {
        // 走査不能（古い端末等）→ fps 換算フォールバック
        appState.frameTimes = [];
        appState.videoFps = appState.videoFps || 30;
        appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * appState.videoFps));
        logDebug('フレーム走査不可。fps換算にフォールバックします（精度はやや低下）。');
    }
    refreshFpsUI();
    const slider = document.getElementById('frame-slider');
    if (slider) slider.max = appState.totalFrames;
    resetAnalysisRange();
    seekToFrame(0);
    updateTimeDisplay();
    persistState();
    updateGraph();
    updateStepGuide();
}

// 全フレームをシークで列挙し、{実時刻, 複製フラグ} を作る。
async function scanAllFrames(v) {
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return null;
    const MAX_SEEKS = 5000;
    let seeks = 0;
    const frames = []; // { t, sig, dup }

    // フレーム0
    let f0 = await getFrameAt(v, 0); seeks++;
    frames.push({ t: f0.mediaTime, sig: f0.sig, dup: false });
    let lastT = f0.mediaTime, lastSig = f0.sig;

    // 最初の間隔を測る（次フレームに当たるまでステップを倍々で広げる）
    let step = 1 / 240;
    let probe = await getFrameAt(v, lastT + step); seeks++;
    let guard = 0;
    while (probe.mediaTime <= lastT + 1e-4 && guard < 40 && seeks < MAX_SEEKS) {
        step *= 1.6; probe = await getFrameAt(v, lastT + step); seeks++; guard++;
    }
    let interval = Math.max(1e-4, probe.mediaTime - lastT);
    let pending = probe;       // 取得済みの「次フレーム」
    let curT = lastT;

    while (seeks < MAX_SEEKS) {
        let fr = pending; pending = null;
        if (!fr) {
            // 控えめ(半間隔)から始め、当たるまで少しずつ広げる。1フレームを飛び越えないため
            // 常に「次フレーム境界の手前」から漸増する → スキップ無しで必ず隣のコマに当たる。
            const grow = Math.max(interval * 0.34, 1 / 1000);
            let st = interval * 0.5;
            let target = curT + st;
            if (target >= dur - 1e-4) break;
            fr = await getFrameAt(v, target); seeks++;
            let g2 = 0;
            while (fr.mediaTime <= lastT + 1e-4 && g2 < 30 && seeks < MAX_SEEKS) {
                st += grow;
                target = curT + st;
                if (target >= dur - 1e-4) { fr = null; break; }
                fr = await getFrameAt(v, target); seeks++; g2++;
            }
            if (!fr || fr.mediaTime <= lastT + 1e-4) break; // 末尾に到達
        }
        const gap = fr.mediaTime - lastT;
        // 直近間隔へ追従（VFR対応）。ただし飛び越え(>1.4倍)時は更新せず基準を保つ。
        if (gap > 0 && gap < interval * 1.4) interval = gap;
        const isDup = changedFraction(fr.sig, lastSig) < DUP_FRACTION;
        frames.push({ t: fr.mediaTime, sig: fr.sig, dup: isDup });
        if (!isDup) lastSig = fr.sig;           // 複製でない時だけ基準署名を更新
        lastT = fr.mediaTime; curT = fr.mediaTime;
        showScanProgress(curT / dur);
    }

    // 複製除外（誤検出セーフティ：多すぎるなら除外しない）
    const dupCount = frames.filter(f => f.dup).length;
    let times, skipped = 0;
    if (dupCount > 0 && dupCount <= frames.length * DUP_SAFETY_MAX) {
        times = frames.filter(f => !f.dup).map(f => f.t);
        skipped = dupCount;
    } else {
        times = frames.map(f => f.t);
    }
    times = buildFrameTimeTable(times); // 昇順保証＋近接(1ms)重複除去
    return { times, skipped, seeks };
}

// rVFC非対応の古い端末向けフォールバック：細かいグリッドでシークし、画素変化で
// 「新しい実フレーム」を検出してその初出時刻を記録する。VFRも近似でき、複製は自然に除外。
async function scanGridFallback(v) {
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return null;
    const step = 1 / (240 * 2);   // 最大240fps想定の細かさ
    const MAX_SEEKS = 6000;
    let seeks = 0;
    const times = [];
    let f0 = await getFrameAt(v, 0); seeks++;
    times.push(0); let lastSig = f0.sig;
    for (let t = step; t < dur - 1e-4 && seeks < MAX_SEEKS; t += step) {
        const fr = await getFrameAt(v, t); seeks++;
        if (changedFraction(fr.sig, lastSig) >= DUP_FRACTION) { // 画素が明確に変化＝次フレーム
            times.push(t); lastSig = fr.sig;
        }
        showScanProgress(t / dur);
    }
    let out = buildFrameTimeTable(times);
    // 初出時刻はグリッド分（±step）のジッタを含む。ほぼ等間隔(CFR)なら一様間隔へスナップして
    // 数値微分(加速度)のノイズを抑える。VFRはそのまま。
    if (out.length >= 3) {
        const dts = out.slice(1).map((t, i) => t - out[i]);
        const sorted = [...dts].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        if (med > 0 && dts.every(d => Math.abs(d - med) < med * 0.45)) {
            out = out.map((_, i) => out[0] + i * med); // CFRスナップ
        }
    }
    return { times: out, skipped: 0, seeks };
}

// 実フレーム時刻表から表示用の「親しみやすいfps」を求める（中央値間隔→常用値スナップ）
function friendlyFpsFromTimes(times) {
    if (times.length < 2) return appState.videoFps || 30;
    const dts = [];
    for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
    return fpsFromSamples(dts) || (appState.videoFps || 30);
}


// フレーム間隔サンプルの中央値からFPSを推定。近ければ常用値にスナップ。
function fpsFromSamples(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!median || median <= 0) return null;
    let fps = 1 / median;
    const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 120, 240];
    let best = null, bestErr = 0.03; // 3%以内で最も近い常用値にスナップ
    for (const c of common) {
        const err = Math.abs(fps - c) / c;
        if (err < bestErr) { bestErr = err; best = c; }
    }
    if (best !== null) return Math.round(best * 1000) / 1000;
    return Math.round(fps * 100) / 100;
}

// 観測した mediaTime 列 → 昇順・重複除去したフレーム時刻表
function buildFrameTimeTable(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const out = [];
    const eps = 1e-3; // 1ms 以内は同一フレームとみなす
    for (const t of sorted) {
        if (out.length === 0 || t - out[out.length - 1] > eps) out.push(t);
    }
    return out;
}

// コマ番号 → そのフレームの実時刻（s）。表が無ければ fps 換算にフォールバック。
function frameTimeOf(i) {
    const ft = appState.frameTimes;
    if (ft && ft.length) {
        const n = Math.max(0, Math.min(ft.length - 1, i));
        return ft[n];
    }
    return i / appState.videoFps;
}

// コマ番号 → シーク先の currentTime（s）。表があればフレーム表示区間の中央を狙い、
// デコード境界の丸めズレを避けて確実にそのフレームを表示させる。
function seekTimeOf(i) {
    const ft = appState.frameTimes;
    if (ft && ft.length) {
        const n = Math.max(0, Math.min(ft.length - 1, i));
        if (n < ft.length - 1) return (ft[n] + ft[n + 1]) / 2;
        if (ft.length >= 2)    return Math.min(appState.videoDuration - 0.001, ft[n] + (ft[n] - ft[n - 1]) / 2);
        return ft[n];
    }
    return (i + 0.5) / appState.videoFps;
}

// FPS表示（インジケータ＋入力欄）を現在値に同期
function refreshFpsUI() {
    const lbl = document.getElementById('lbl-fps');
    if (lbl) lbl.textContent = appState.videoFps + (appState.fpsMeasured && !appState.fpsManual ? '' : '*');
    const input = document.getElementById('fps-input');
    if (input && document.activeElement !== input) input.value = appState.videoFps;
}

// 手動FPS上書き
function setFpsManual(val) {
    const fps = parseFloat(val);
    if (isNaN(fps) || fps <= 0) { refreshFpsUI(); return; }
    appState.videoFps = Math.round(fps * 100) / 100;
    appState.fpsManual = true;
    appState.fpsMeasured = false;
    appState.frameTimes = []; // 手動fps指定時は実測時刻表を破棄し、一様fpsを採用
    if (appState.videoDuration) {
        appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * appState.videoFps));
        const slider = document.getElementById('frame-slider');
        if (slider) slider.max = appState.totalFrames;
    }
    // 既存点の時刻を新FPSで再計算
    appState.trackingData.forEach(p => { p.time = frameTimeOf(p.frame); });
    refreshFpsUI();
    persistState();
    updateDataTable();
    updateGraph();
    logDebug(`FPSを手動設定: ${appState.videoFps}`);
}

function setupFpsInput() {
    const input = document.getElementById('fps-input');
    if (input) {
        input.addEventListener('change', (e) => setFpsManual(e.target.value));
    }
}

// 再生/一時停止アイコンの切替（共通化）
function setPlayPauseIcon(playing) {
    const btnPlay = document.getElementById('btn-play-pause');
    if (btnPlay) {
        const span = btnPlay.querySelector('span');
        if (span) span.textContent = playing ? 'pause' : 'play_arrow';
    }
}

// --- オフスクリーン Canvas の更新 ---
function updateOffscreenCanvas() {
    if (!appState.videoElement || appState.videoElement.readyState < 2) return;
    if (!offscreenCanvas) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCtx = offscreenCanvas.getContext('2d');
    }
    if (offscreenCanvas.width !== appState.videoElement.videoWidth || offscreenCanvas.height !== appState.videoElement.videoHeight) {
        offscreenCanvas.width = appState.videoElement.videoWidth;
        offscreenCanvas.height = appState.videoElement.videoHeight;
    }
    offscreenCtx.drawImage(appState.videoElement, 0, 0);
}

// --- コマ送り・シークなどのコントロール ---
function setupPlaybackControls() {
    const btnPlay = document.getElementById('btn-play-pause');
    const btnPrev1 = document.getElementById('btn-prev-1');
    const btnNext1 = document.getElementById('btn-next-1');
    const btnPrev10 = document.getElementById('btn-prev-10');
    const btnNext10 = document.getElementById('btn-next-10');
    const slider = document.getElementById('frame-slider');
    
    if (btnPlay) {
        btnPlay.addEventListener('click', () => {
            if (!appState.videoElement.src) return;
            if (appState.isPlaying) {
                pauseVideo();
            } else {
                playVideo();
            }
        });
    }
    
    if (btnPrev1) btnPrev1.addEventListener('click', () => stepFrame(-1));
    if (btnNext1) btnNext1.addEventListener('click', () => stepFrame(1));
    if (btnPrev10) btnPrev10.addEventListener('click', () => stepFrame(-10));
    if (btnNext10) btnNext10.addEventListener('click', () => stepFrame(10));
    
    if (slider) {
        slider.addEventListener('input', (e) => {
            const targetFrame = parseInt(e.target.value);
            // 解析範囲内にクランプ（範囲外へはドラッグで出られない）
            seekToFrame(Math.max(appState.rangeIn, Math.min(appState.rangeOut, targetFrame)));
        });
    }
}

function stepFrame(delta) {
    if (!appState.videoElement.src) return;
    pauseVideo();
    // コマ送りは解析範囲内に収める（範囲外は表・グラフからも除外されるため）
    const targetFrame = Math.max(appState.rangeIn, Math.min(appState.rangeOut, appState.currentFrame + delta));
    seekToFrame(targetFrame);
}

// --- 解析範囲（イン/アウト点） ---------------------------------------
function inAnalysisRange(frame) {
    return frame >= appState.rangeIn && frame <= appState.rangeOut;
}

function resetAnalysisRange() {
    appState.rangeIn = 0;
    appState.rangeOut = appState.totalFrames;
    updateRangeUI();
}

// シークバー上に選択範囲をシアン（計器/校正の色）で示す
function updateRangeUI() {
    const slider = document.getElementById('frame-slider');
    const lbl = document.getElementById('lbl-range');
    const total = Math.max(1, appState.totalFrames);
    const full = appState.rangeIn === 0 && appState.rangeOut === appState.totalFrames;
    if (slider) {
        if (full) {
            slider.style.background = '';
        } else {
            const a = (appState.rangeIn / total) * 100;
            const b = (appState.rangeOut / total) * 100;
            slider.style.background =
                `linear-gradient(90deg, var(--line) 0%, var(--line) ${a}%, ` +
                `var(--cyan) ${a}%, var(--cyan) ${b}%, var(--line) ${b}%, var(--line) 100%)`;
        }
    }
    if (lbl) lbl.textContent = full ? '全体' : `${appState.rangeIn}–${appState.rangeOut}`;
}

// 範囲確定時にその範囲だけ複製コマを除外（読込時に持ち越した分。1動画につき1回）
const DEDUP_RANGE_MAX = 300;
async function maybeDedupRange() {
    if (appState.dedupDone || !appState.frameTimes.length) return;
    if (appState.trackingData.length > 0) {
        logDebug('計測データがあるためコマ番号を変えられません（重複除外スキップ）');
        return;
    }
    const len = appState.rangeOut - appState.rangeIn + 1;
    if (len < 2 || len > DEDUP_RANGE_MAX) return;
    appState.isScanning = true;
    showScanProgress(0);
    const seg = appState.frameTimes.slice(appState.rangeIn, appState.rangeOut + 1);
    let d = null;
    try { d = await dedupTimesByPixel(appState.videoElement, seg); }
    catch (e) { logDebug('範囲の重複確認に失敗: ' + (e && e.message)); }
    appState.isScanning = false;
    hideScanProgress();
    if (!d) return;
    if (d.skipped > 0) {
        const before = appState.frameTimes.slice(0, appState.rangeIn);
        const after = appState.frameTimes.slice(appState.rangeOut + 1);
        appState.frameTimes = buildFrameTimeTable([...before, ...d.times, ...after]);
        appState.totalFrames = appState.frameTimes.length - 1;
        appState.rangeOut = Math.max(appState.rangeIn, appState.rangeOut - d.skipped);
        appState.videoFps = friendlyFpsFromTimes(appState.frameTimes);
        const slider = document.getElementById('frame-slider');
        if (slider) slider.max = appState.totalFrames;
        refreshFpsUI();
        logDebug(`解析範囲の複製コマ ${d.skipped} 枚を除外しました`);
    }
    appState.dedupDone = true;
    updateRangeUI();
    updateTimeDisplay();
}

function setupRangeControls() {
    const btnIn = document.getElementById('btn-range-in');
    const btnOut = document.getElementById('btn-range-out');
    if (btnIn) btnIn.addEventListener('click', () => {
        if (!appState.videoElement.src) return;
        pauseVideo();
        // 既にイン点と同じコマでもう一度押すと解除（先頭へ戻す）
        appState.rangeIn = (appState.rangeIn === appState.currentFrame) ? 0
            : Math.min(appState.currentFrame, appState.rangeOut);
        updateRangeUI(); updateDataTable(); updateGraph();
        maybeDedupRange();
    });
    if (btnOut) btnOut.addEventListener('click', () => {
        if (!appState.videoElement.src) return;
        pauseVideo();
        appState.rangeOut = (appState.rangeOut === appState.currentFrame) ? appState.totalFrames
            : Math.max(appState.currentFrame, appState.rangeIn);
        updateRangeUI(); updateDataTable(); updateGraph();
        maybeDedupRange();
    });
}

// --- シーク直列化キュー ---------------------------------------------
// Safariは連続する currentTime 設定を間引く（コアレスする）ため、投げっぱなしの
// シークはボタン連打で「内部コマ番号」と「表示フレーム」がずれる。ここでは
// 常に1件だけ実行し、連打時は「最後の要求」だけを次に実行する（中間は捨てる）。
let seekBusy = false;
let seekPendingFrame = null;

function seekToFrame(frame) {
    appState.currentFrame = Math.max(0, Math.min(appState.totalFrames, frame));
    const slider = document.getElementById('frame-slider');
    if (slider) slider.value = appState.currentFrame;
    seekPendingFrame = appState.currentFrame;
    pumpSeekQueue();
}

function pumpSeekQueue() {
    if (seekBusy || seekPendingFrame === null) return;
    const frame = seekPendingFrame;
    seekPendingFrame = null;
    seekBusy = true;

    const v = appState.videoElement;
    // 実フレーム時刻表があればその区間中央へ、無ければ fps 換算でフレーム中央へ。
    // 境界でのデコードずれ（特にSafari/iPad）を避けやすい。
    const targetTime = Math.min(appState.videoDuration - 0.001, Math.max(0, seekTimeOf(frame)));

    let done = false;
    const finish = (mediaTime) => {
        if (done) return;
        done = true;
        // 後続の要求が無ければ、実際に表示されたフレームを真実として補正
        if (mediaTime !== null && seekPendingFrame === null && appState.frameTimes.length) {
            const shown = frameIndexOfTime(mediaTime);
            if (shown !== appState.currentFrame) {
                logDebug(`シーク補正: 要求コマ${appState.currentFrame} → 表示コマ${shown}`);
                appState.currentFrame = shown;
                const slider = document.getElementById('frame-slider');
                if (slider) slider.value = shown;
            }
        }
        seekBusy = false;
        pumpSeekQueue(); // 連打中に溜まった最後の要求を実行
    };

    if (rvfcSupported && !appState.isScanning) {
        v.requestVideoFrameCallback((now, meta) => finish(meta.mediaTime));
    } else {
        const onSeeked = () => { v.removeEventListener('seeked', onSeeked); finish(null); };
        v.addEventListener('seeked', onSeeked);
    }
    v.currentTime = targetTime;
    setTimeout(() => finish(null), 1500); // 同一フレームへのシーク等でrVFCが発火しない場合の安全網
}

// 再生時刻 t(s) → コマ番号（実時刻表を二分探索。表が無ければfps換算）
function frameIndexOfTime(t) {
    const ft = appState.frameTimes;
    if (!ft || !ft.length) return Math.floor(t * appState.videoFps);
    let lo = 0, hi = ft.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ft[mid] <= t + 1e-6) lo = mid; else hi = mid - 1;
    }
    return Math.min(lo, appState.totalFrames);
}

function playVideo() {
    appState.isPlaying = true;
    setPlayPauseIcon(true);
    appState.videoElement.play();
    logDebug("再生開始");
    requestAnimationFrame(renderLoop);
}

function pauseVideo() {
    appState.isPlaying = false;
    setPlayPauseIcon(false);
    appState.videoElement.pause();
    logDebug("一時停止");
}

function renderLoop() {
    if (!appState.isPlaying) return;
    
    // 再生中も実時刻表と同じ座標系でコマ番号を出す（floor(t*fps)だと停止後のコマ送りとずれる）
    appState.currentFrame = frameIndexOfTime(appState.videoElement.currentTime);
    const slider = document.getElementById('frame-slider');
    if (slider) slider.value = appState.currentFrame;
    
    const lblFrame = document.getElementById('lbl-frame');
    if (lblFrame) lblFrame.textContent = appState.currentFrame;
    
    updateOffscreenCanvas();
    drawVideoFrame();
    updateTimeDisplay();
    
    if (!appState.videoElement.paused && !appState.videoElement.ended) {
        requestAnimationFrame(renderLoop);
    } else if (appState.videoElement.ended) {
        pauseVideo();
    }
}

// タイム表示の更新
function updateTimeDisplay() {
    const timeDisplay = document.getElementById('time-display');
    if (!timeDisplay) return;
    
    // フレーム基準の時刻（実フレーム時刻表 or fps換算）
    const curSec = frameTimeOf(appState.currentFrame);
    const durSec = appState.videoDuration;
    
    const format = (sec) => {
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        const ms = Math.floor((sec % 1) * 100).toString().padStart(2, '0');
        return `${m}:${s}.${ms}`;
    };
    
    timeDisplay.textContent = `${format(curSec)} / ${format(durSec)}`;
}

// Canvasリサイズ処理
function handleResize() {
    const container = document.getElementById('canvas-container');
    if (!container || !appState.videoElement.src || appState.videoElement.videoWidth === 0) return;
    
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const vWidth = appState.videoElement.videoWidth;
    const vHeight = appState.videoElement.videoHeight;

    // Canvas はコンテナ全面。動画は getFitMetrics() でレターボックス配置するため、
    // 縦長動画でもズーム/パン時に左右いっぱいまで使える。
    appState.canvas.width = containerWidth;
    appState.canvas.height = containerHeight;

    const m = getFitMetrics();
    logDebug(`Canvasリサイズ: ${containerWidth}x${containerHeight} (Video: ${vWidth}x${vHeight}, fit: ${m.fit.toFixed(3)})`);

    drawVideoFrame();
}

// --- Canvasへの描画処理 ---
function drawVideoFrame() {
    if (!appState.videoElement.src || appState.videoElement.readyState < 2) return;
    
    appState.ctx.clearRect(0, 0, appState.canvas.width, appState.canvas.height);
    
    appState.ctx.save();
    // アフィン変換の適用（ユーザーのズーム・パン）
    appState.ctx.translate(appState.viewState.offsetX, appState.viewState.offsetY);
    appState.ctx.scale(appState.viewState.scale, appState.viewState.scale);

    // 動画フレームの描画（コンテナ内にレターボックス配置）
    const m = getFitMetrics();
    appState.ctx.drawImage(appState.videoElement, m.baseX, m.baseY, m.fitW, m.fitH);
    
    // キャリブレーションマーカーとトラックポイントの描画
    drawCalibrationMarkers();
    drawTrackingPoints();

    appState.ctx.restore();

    // 画面中央の固定十字（スクリーン座標・ズーム非依存）
    drawCrosshair();
}

// --- 中央十字（照準）の描画 ---
function drawCrosshair() {
    const ctx = appState.ctx;
    const cx = appState.canvas.width / 2;
    const cy = appState.canvas.height / 2;
    const isCalib = appState.pendingCapture !== null;
    // 照準 = シグナル・アンバー（ストロボ発光）。校正中は校正系のシアン。
    const color = isCalib ? '#5AA9E6' : '#FFB627';

    ctx.save();
    ctx.lineWidth = 1.5;

    // 外側の縁取り（白）で視認性確保
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    drawReticlePath(ctx, cx, cy);
    ctx.stroke();

    // 本体
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    drawReticlePath(ctx, cx, cy);
    ctx.stroke();

    // 中心の小さなドット
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

function drawReticlePath(ctx, cx, cy) {
    const gap = 6;   // 中心の空き
    const len = 16;  // 線の長さ
    const r = 14;    // 円の半径
    ctx.beginPath();
    // 上下左右の線（中心を空ける）
    ctx.moveTo(cx, cy - gap); ctx.lineTo(cx, cy - gap - len);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
    ctx.moveTo(cx - gap, cy); ctx.lineTo(cx - gap - len, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
    // 円
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
}

// --- 座標変換関数 ---
// Canvas はコンテナ全面サイズ。動画はその中にレターボックス配置（contain-fit・中央寄せ）。
// fit と base(余白) を毎回算出することで状態を持たず、テストでも純粋に検証できる。
function getFitMetrics() {
    const vW = (appState.videoElement && appState.videoElement.videoWidth) || 1;
    const vH = (appState.videoElement && appState.videoElement.videoHeight) || 1;
    const cW = (appState.canvas && appState.canvas.width) || 1;
    const cH = (appState.canvas && appState.canvas.height) || 1;
    const fit = Math.min(cW / vW, cH / vH) || 1;
    const fitW = vW * fit, fitH = vH * fit;
    return { fit, fitW, fitH, baseX: (cW - fitW) / 2, baseY: (cH - fitH) / 2, vW, vH, cW, cH };
}

function canvasToVideo(cx, cy) {
    const m = getFitMetrics();
    const lx = (cx - appState.viewState.offsetX) / appState.viewState.scale;
    const ly = (cy - appState.viewState.offsetY) / appState.viewState.scale;
    return { x: (lx - m.baseX) / m.fit, y: (ly - m.baseY) / m.fit };
}

function videoToCanvas(vx, vy) {
    const local = videoToLocalCanvas(vx, vy);

    const cx = local.x * appState.viewState.scale + appState.viewState.offsetX;
    const cy = local.y * appState.viewState.scale + appState.viewState.offsetY;
    return { x: cx, y: cy };
}

// 動画座標 → Canvasローカル座標（ユーザーズーム適用前。レターボックスの余白を含む）
function videoToLocalCanvas(vx, vy) {
    const m = getFitMetrics();
    return { x: m.baseX + vx * m.fit, y: m.baseY + vy * m.fit };
}

// --- Pointer Events によるズーム・パン、ドラッグ ---
function setupCanvasTouch() {
    appState.canvas.addEventListener('pointerdown', handlePointerDown);
    appState.canvas.addEventListener('pointermove', handlePointerMove);
    appState.canvas.addEventListener('pointerup', handlePointerUp);
    appState.canvas.addEventListener('pointercancel', handlePointerUp);
    appState.canvas.addEventListener('wheel', handleWheel, { passive: false });
}

function handlePointerDown(e) {
    e.preventDefault();
    appState.canvas.setPointerCapture(e.pointerId);
    
    activePointers.push({
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY
    });
    
    const rect = appState.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    
    if (activePointers.length === 1) {
        // 1本指は常に映像のパン（点打ちは「確定」ボタンに集約）
        lastPointerPos = { x: localX, y: localY };
        isPanning = false;
    } else if (activePointers.length === 2) {
        const p1 = activePointers[0];
        const p2 = activePointers[1];
        
        const p1Local = { x: p1.x - rect.left, y: p1.y - rect.top };
        const p2Local = { x: p2.x - rect.left, y: p2.y - rect.top };
        
        lastPinchDist = Math.hypot(p1Local.x - p2Local.x, p1Local.y - p2Local.y);
        lastPinchCenter = {
            x: (p1Local.x + p2Local.x) / 2,
            y: (p1Local.y + p2Local.y) / 2
        };
        isPanning = true;
        logDebug("ピンチ開始（吸い付きズーム有効）");
    }
}

function handlePointerMove(e) {
    e.preventDefault();
    const pointer = activePointers.find(p => p.id === e.pointerId);
    if (!pointer) return;
    
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    
    const rect = appState.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    
    if (activePointers.length === 1) {
        // 1本指ドラッグ = 映像のパン（十字に対象を合わせるための操作）
        if (lastPointerPos) {
            const dx = localX - lastPointerPos.x;
            const dy = localY - lastPointerPos.y;
            appState.viewState.offsetX += dx;
            appState.viewState.offsetY += dy;
            lastPointerPos = { x: localX, y: localY };
            drawVideoFrame();
        }
    } else if (activePointers.length === 2 && isPanning) {
        const p1 = activePointers[0];
        const p2 = activePointers[1];
        
        const p1Local = { x: p1.x - rect.left, y: p1.y - rect.top };
        const p2Local = { x: p2.x - rect.left, y: p2.y - rect.top };
        
        const currentDist = Math.hypot(p1Local.x - p2Local.x, p1Local.y - p2Local.y);
        const currentCenter = {
            x: (p1Local.x + p2Local.x) / 2,
            y: (p1Local.y + p2Local.y) / 2
        };
        
        if (lastPinchDist > 0 && lastPinchCenter) {
            const dScale = currentDist / lastPinchDist;
            let newScale = appState.viewState.scale * dScale;
            newScale = Math.max(0.5, Math.min(10, newScale));
            
            const actualRatio = newScale / appState.viewState.scale;
            const dx = currentCenter.x - lastPinchCenter.x;
            const dy = currentCenter.y - lastPinchCenter.y;
            
            appState.viewState.offsetX = currentCenter.x - (currentCenter.x - appState.viewState.offsetX) * actualRatio + dx;
            appState.viewState.offsetY = currentCenter.y - (currentCenter.y - appState.viewState.offsetY) * actualRatio + dy;
            appState.viewState.scale = newScale;
            
            drawVideoFrame();
        }
        
        lastPinchDist = currentDist;
        lastPinchCenter = currentCenter;
    }
}

function handlePointerUp(e) {
    appState.canvas.releasePointerCapture(e.pointerId);
    activePointers = activePointers.filter(p => p.id !== e.pointerId);
    
    if (activePointers.length < 2) {
        isPanning = false;
        lastPinchDist = 0;
        lastPinchCenter = null;
    }
    
    const rect = appState.canvas.getBoundingClientRect();
    if (activePointers.length === 1) {
        const p = activePointers[0];
        lastPointerPos = { x: p.x - rect.left, y: p.y - rect.top };
    } else if (activePointers.length === 0) {
        lastPointerPos = null;
        if (isDraggingPoint) {
            isDraggingPoint = false;
            draggedPointIndex = -1;
            logDebug("ドラッグ完了");
        }
    }
}

function handleWheel(e) {
    e.preventDefault();
    const zoomIntensity = 0.08;
    const rect = appState.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const wheel = e.deltaY < 0 ? 1 : -1;
    const zoomFactor = Math.exp(wheel * zoomIntensity);
    
    const oldScale = appState.viewState.scale;
    let newScale = oldScale * zoomFactor;
    newScale = Math.max(0.5, Math.min(10, newScale));
    
    const actualRatio = newScale / oldScale;
    
    appState.viewState.offsetX = mouseX - (mouseX - appState.viewState.offsetX) * actualRatio;
    appState.viewState.offsetY = mouseY - (mouseY - appState.viewState.offsetY) * actualRatio;
    appState.viewState.scale = newScale;
    
    drawVideoFrame();
}

function resetZoom() {
    appState.viewState = { scale: 1, offsetX: 0, offsetY: 0 };
    drawVideoFrame();
    logDebug("ズームリセット");
}

// --- 保留アクション（原点/スケール設定）の切替 ---
function setPendingCapture(mode) {
    appState.pendingCapture = mode;
    // スケール設定を抜けるときは一時始点をクリア
    if (mode !== 'scale') appState.calibration.scaleTempStart = null;

    const btnOrigin = document.getElementById('btn-set-origin');
    const btnScale = document.getElementById('btn-set-scale');
    if (btnOrigin) btnOrigin.classList.toggle('active', mode === 'origin');
    if (btnScale) btnScale.classList.toggle('active', mode === 'scale');

    updateActionHint();
    logDebug(`保留アクション: ${mode || 'なし（トラッキング）'}`);
}

// 確定ボタンのラベルと、今やるべき操作のヒントを更新
function updateActionHint() {
    const btnConfirm = document.getElementById('btn-confirm');
    const hint = document.getElementById('action-hint');
    let label = '確定（点を打つ）';
    let text = '十字を対象に合わせて「確定」';

    if (appState.pendingCapture === 'origin') {
        label = '原点をここに確定';
        text = '十字を原点に合わせて「確定」';
    } else if (appState.pendingCapture === 'scale') {
        if (appState.calibration.scaleTempStart) {
            label = 'スケール終点を確定';
            text = '十字を「既知の長さ」の終点に合わせて「確定」';
        } else {
            label = 'スケール始点を確定';
            text = '十字を「既知の長さ」の始点に合わせて「確定」';
        }
    }
    if (btnConfirm) {
        const span = btnConfirm.querySelector('.confirm-label');
        if (span) span.textContent = label;
    }
    if (hint) hint.textContent = text;
}

// 手順ガイド: 今やるべき最初の未完ステップを点灯する
function updateStepGuide() {
    const steps = document.querySelectorAll('.step-guide .step');
    if (!steps.length) return;
    const hasVideo = !!(appState.videoElement && appState.videoElement.src);
    const hasScale = !!appState.calibration.scaleRatio;
    const hasOrigin = !!appState.calibration.origin;
    const hasData = appState.trackingData.length > 0;

    let active = 0;                 // ① 動画
    if (hasVideo) active = 1;       // ② スケール
    if (hasVideo && hasScale) active = 2;            // ③ 原点
    if (hasVideo && hasScale && hasOrigin) active = 3; // ④ トラッキング
    if (hasVideo && hasData) active = Math.max(active, 3);
    if (hasVideo && hasData && hasScale && hasOrigin) active = 4; // ⑤ 出力（任意）

    steps.forEach((el, i) => el.classList.toggle('active', i === active));
}

function setupModeButtons() {
    const btnConfirm = document.getElementById('btn-confirm');
    const btnOrigin = document.getElementById('btn-set-origin');
    const btnScale = document.getElementById('btn-set-scale');
    const btnZoomReset = document.getElementById('btn-zoom-reset');

    if (btnConfirm) btnConfirm.addEventListener('click', confirmAtCrosshair);
    // 原点/スケールボタンはトグル: 押すと保留、もう一度押すとキャンセル
    if (btnOrigin) btnOrigin.addEventListener('click', () => {
        setPendingCapture(appState.pendingCapture === 'origin' ? null : 'origin');
    });
    if (btnScale) btnScale.addEventListener('click', () => {
        setPendingCapture(appState.pendingCapture === 'scale' ? null : 'scale');
    });
    if (btnZoomReset) btnZoomReset.addEventListener('click', resetZoom);
}

// 物体選択（色ボタン）
function setupObjectButtons() {
    const selector = document.getElementById('object-selector');
    if (!selector) return;
    // 各ボタンのスウォッチ色を COLOR_MAP に合わせる
    selector.querySelectorAll('.obj-btn').forEach(btn => {
        const oid = parseInt(btn.dataset.oid);
        const swatch = btn.querySelector('.obj-swatch');
        if (swatch) swatch.style.background = COLOR_MAP[(oid - 1) % COLOR_MAP.length];
        btn.addEventListener('click', () => setActiveObject(oid));
    });
    updateObjectButtons();
}

function setActiveObject(oid) {
    appState.activeObjectId = Math.max(1, oid);
    updateObjectButtons();
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();
    logDebug(`物体${appState.activeObjectId}を選択`);
}

function updateObjectButtons() {
    document.querySelectorAll('#object-selector .obj-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.oid) === appState.activeObjectId);
    });
}

// 設定入力欄のイベント設定
function setupSettingsInputs() {
    const stepInput = document.getElementById('step-size-select');

    if (stepInput) {
        stepInput.addEventListener('change', (e) => {
            appState.trackingStepSize = Math.max(1, parseInt(e.target.value) || 1);
            logDebug(`ステップ幅: ${appState.trackingStepSize}`);
        });
    }
}

// --- 十字（画面中央）が指す動画座標を取得 ---
function getCrosshairVideoCoord() {
    return canvasToVideo(appState.canvas.width / 2, appState.canvas.height / 2);
}

// --- 「確定」ボタン: 十字位置を現在の保留アクションに応じて確定する ---
function confirmAtCrosshair() {
    if (!appState.videoElement.src || appState.videoElement.readyState < 2) {
        logDebug("動画が読み込まれていません。");
        return;
    }
    const vPos = getCrosshairVideoCoord();

    if (appState.pendingCapture === 'origin') {
        captureOrigin(vPos);
    } else if (appState.pendingCapture === 'scale') {
        captureScalePoint(vPos);
    } else {
        captureTrackPoint(vPos);
    }
}

// 通常: トラックポイントを現フレームに登録/上書きし、ステップ幅ぶん自動コマ送り
function captureTrackPoint(vPos) {
    pushHistory();
    const existingIndex = appState.trackingData.findIndex(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
    const newPoint = {
        id: Date.now(),
        frame: appState.currentFrame,
        time: frameTimeOf(appState.currentFrame),
        x: vPos.x,
        y: vPos.y,
        objectId: appState.activeObjectId
    };

    if (existingIndex >= 0) {
        appState.trackingData[existingIndex] = newPoint;
    } else {
        appState.trackingData.push(newPoint);
    }

    appState.targetColor = sampleColor(vPos.x, vPos.y);
    if (appState.targetColor) {
        logDebug(`色をサンプリングしました: RGB(${appState.targetColor.r}, ${appState.targetColor.g}, ${appState.targetColor.b})`);
    }

    logDebug(`ポイント登録: Frame ${appState.currentFrame}, X: ${vPos.x.toFixed(1)}, Y: ${vPos.y.toFixed(1)}`);
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();

    stepFrame(appState.trackingStepSize);
}

function captureOrigin(vPos) {
    appState.calibration.origin = { x: vPos.x, y: vPos.y };
    logDebug(`原点を設定しました: X: ${vPos.x.toFixed(1)}, Y: ${vPos.y.toFixed(1)}`);
    document.getElementById('info-origin').textContent = `(${vPos.x.toFixed(0)}, ${vPos.y.toFixed(0)})`;
    setPendingCapture(null);
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();
}

function captureScalePoint(vPos) {
    const cal = appState.calibration;
    if (!cal.scaleTempStart) {
        cal.scaleTempStart = { x: vPos.x, y: vPos.y };
        logDebug("スケール始点を設定。十字を終点に合わせて、もう一度「確定」してください。");
        updateActionHint();
        drawVideoFrame();
        return;
    }
    const start = cal.scaleTempStart;
    const end = { x: vPos.x, y: vPos.y };
    const pixelDistance = Math.hypot(end.x - start.x, end.y - start.y);

    showInputDialog("スケール設定", `2点間の距離は ${pixelDistance.toFixed(1)} px です。実際の物理的距離を入力してください (cm):`, "100", (val) => {
        const actualDist = parseFloat(val);
        if (!isNaN(actualDist) && actualDist > 0) {
            cal.scaleRatio = actualDist / pixelDistance;
            cal.scaleStart = start;
            cal.scaleEnd = end;
            cal.scaleActual = actualDist;
            logDebug(`スケール設定完了: ${cal.scaleRatio.toFixed(4)} cm/px (実寸: ${actualDist} cm)`);
            document.getElementById('info-scale').textContent = `${cal.scaleRatio.toFixed(3)} cm/px`;
            persistState();
            updateDataTable();
            updateGraph();
        } else {
            logDebug("無効な距離が入力されました。");
        }
        cal.scaleTempStart = null;
        setPendingCapture(null);
        drawVideoFrame();
    });
}

// 選択ポイント状態の切り替え
function setSelectedPoint(id) {
    appState.selectedPointId = id;
    const btnDel = document.getElementById('btn-delete-selected');
    if (btnDel) {
        if (id !== null) {
            btnDel.disabled = false;
            btnDel.style.opacity = '1';
        } else {
            btnDel.disabled = true;
            btnDel.style.opacity = '0.5';
        }
    }
}

// 選択ポイント削除ボタンイベント設定
function setupDeletionEvent() {
    const btnDel = document.getElementById('btn-delete-selected');
    if (btnDel) {
        btnDel.addEventListener('click', () => {
            if (appState.selectedPointId !== null) {
                pushHistory();
                appState.trackingData = appState.trackingData.filter(p => p.id !== appState.selectedPointId);
                logDebug(`選択ポイント削除: ID ${appState.selectedPointId}`);
                setSelectedPoint(null);
                persistState();
                updateDataTable();
                drawVideoFrame();
                updateGraph();
            }
        });
    }
}

// --- 色サンプリングと色自動追跡 ---
function sampleColor(vx, vy) {
    if (!offscreenCtx) return null;
    
    const x = Math.round(vx);
    const y = Math.round(vy);
    const w = offscreenCanvas.width;
    const h = offscreenCanvas.height;
    
    if (x < 0 || x >= w || y < 0 || y >= h) return null;
    
    const radius = 2;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    
    const startX = Math.max(0, x - radius);
    const endX = Math.min(w - 1, x + radius);
    const startY = Math.max(0, y - radius);
    const endY = Math.min(h - 1, y + radius);
    
    const imgData = offscreenCtx.getImageData(startX, startY, (endX - startX) + 1, (endY - startY) + 1);
    const data = imgData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        gSum += data[i+1];
        bSum += data[i+2];
        count++;
    }
    
    return {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count)
    };
}

function trackColorStep() {
    if (!appState.targetColor) {
        logDebug("追跡対象の色が設定されていません。トラックモードで一度ポイントをタップして色を登録してください。");
        return Promise.resolve(false);
    }
    
    const currentPoint = appState.trackingData.find(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
    if (!currentPoint) {
        logDebug("現在のフレームに基準ポイントがありません。");
        return Promise.resolve(false);
    }
    
    const prevX = currentPoint.x;
    const prevY = currentPoint.y;
    const nextFrame = appState.currentFrame + appState.trackingStepSize;
    
    if (nextFrame > appState.totalFrames) {
        logDebug("動画の末尾に達しました。");
        return Promise.resolve(false);
    }
    
    return new Promise((resolve) => {
        const onSeeked = () => {
            appState.videoElement.removeEventListener('seeked', onSeeked);
            
            updateOffscreenCanvas();
            
            const winSize = parseInt(document.getElementById('track-window-size').value) || 60;
            const threshold = parseInt(document.getElementById('track-threshold').value) || 40;
            
            const w = offscreenCanvas.width;
            const h = offscreenCanvas.height;
            
            const startX = Math.max(0, Math.round(prevX - winSize / 2));
            const endX = Math.min(w - 1, Math.round(prevX + winSize / 2));
            const startY = Math.max(0, Math.round(prevY - winSize / 2));
            const endY = Math.min(h - 1, Math.round(prevY + winSize / 2));
            
            const rectW = endX - startX + 1;
            const rectH = endY - startY + 1;
            
            if (rectW <= 0 || rectH <= 0) {
                logDebug("探索窓が動画範囲外です。");
                resolve(false);
                return;
            }
            
            const imgData = offscreenCtx.getImageData(startX, startY, rectW, rectH);
            const data = imgData.data;
            
            let sumX = 0;
            let sumY = 0;
            let matchCount = 0;
            
            for (let y = startY; y <= endY; y++) {
                for (let x = startX; x <= endX; x++) {
                    const localX = x - startX;
                    const localY = y - startY;
                    const idx = (localY * rectW + localX) * 4;
                    
                    const r = data[idx];
                    const g = data[idx+1];
                    const b = data[idx+2];
                    
                    const dist = Math.hypot(r - appState.targetColor.r, g - appState.targetColor.g, b - appState.targetColor.b);
                    
                    if (dist <= threshold) {
                        sumX += x;
                        sumY += y;
                        matchCount++;
                    }
                }
            }
            
            if (matchCount > 0) {
                const nextX = sumX / matchCount;
                const nextY = sumY / matchCount;
                
                const existingIndex = appState.trackingData.findIndex(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
                const newPoint = {
                    id: Date.now(),
                    frame: appState.currentFrame,
                    time: frameTimeOf(appState.currentFrame),
                    x: nextX,
                    y: nextY,
                    objectId: appState.activeObjectId
                };
                
                if (existingIndex >= 0) {
                    appState.trackingData[existingIndex] = newPoint;
                } else {
                    appState.trackingData.push(newPoint);
                }
                
                persistState();
                updateDataTable();
                drawVideoFrame();
                updateGraph();
                logDebug(`追跡成功: Frame ${appState.currentFrame}, X: ${nextX.toFixed(1)}, Y: ${nextY.toFixed(1)}`);
                resolve(true);
            } else {
                logDebug(`追跡失敗: 一致する色が探索窓内で見つかりませんでした (閾値: ${threshold})`);
                resolve(false);
            }
        };
        
        appState.videoElement.addEventListener('seeked', onSeeked);
        seekToFrame(nextFrame);
    });
}

async function runAutoTracking() {
    if (appState.isAutoTracking) return;
    
    appState.isAutoTracking = true;
    document.getElementById('btn-auto-track-run').style.display = 'none';
    document.getElementById('btn-auto-track-stop').style.display = 'inline-flex';
    logDebug("自動色追跡を開始しました。");
    
    while (appState.isAutoTracking) {
        const success = await trackColorStep();
        if (!success) {
            stopAutoTracking();
            break;
        }
        await new Promise(r => setTimeout(r, 100));
    }
}

function stopAutoTracking() {
    appState.isAutoTracking = false;
    document.getElementById('btn-auto-track-run').style.display = 'inline-flex';
    document.getElementById('btn-auto-track-stop').style.display = 'none';
    logDebug("自動色追跡を停止しました。");
}

function setupAutoTrackerUI() {
    const btnStep = document.getElementById('btn-auto-track-step');
    const btnRun = document.getElementById('btn-auto-track-run');
    const btnStop = document.getElementById('btn-auto-track-stop');
    const thresholdInput = document.getElementById('track-threshold');
    const lblThreshold = document.getElementById('lbl-threshold');
    
    if (btnStep) btnStep.addEventListener('click', trackColorStep);
    if (btnRun) btnRun.addEventListener('click', runAutoTracking);
    if (btnStop) btnStop.addEventListener('click', stopAutoTracking);
    
    if (thresholdInput && lblThreshold) {
        thresholdInput.addEventListener('input', (e) => {
            lblThreshold.textContent = e.target.value;
        });
    }
}

// --- マーカー描画 ---
function drawTrackingPoints() {
    const scale = appState.viewState.scale;
    const baseRadius = 6;
    const r = baseRadius / scale;
    
    appState.trackingData.forEach(p => {
        const local = videoToLocalCanvas(p.x, p.y);
        
        if (p.frame === appState.currentFrame) {
            // 選択されている場合はハイライト表示を追加
            if (p.id === appState.selectedPointId) {
                appState.ctx.beginPath();
                appState.ctx.arc(local.x, local.y, r * 1.6, 0, Math.PI * 2);
                appState.ctx.strokeStyle = '#FFB627'; // アンバーの選択強調外枠
                appState.ctx.lineWidth = 2.0 / scale;
                appState.ctx.stroke();
            }
            
            // 現在フレームのマーカー
            appState.ctx.beginPath();
            appState.ctx.arc(local.x, local.y, r, 0, Math.PI * 2);
            appState.ctx.fillStyle = COLOR_MAP[(p.objectId - 1) % COLOR_MAP.length];
            appState.ctx.fill();
            appState.ctx.strokeStyle = '#000000';
            appState.ctx.lineWidth = 1.5 / scale;
            appState.ctx.stroke();
            
            // 十字マーク
            appState.ctx.beginPath();
            appState.ctx.moveTo(local.x - r * 1.5, local.y);
            appState.ctx.lineTo(local.x + r * 1.5, local.y);
            appState.ctx.moveTo(local.x, local.y - r * 1.5);
            appState.ctx.lineTo(local.x, local.y + r * 1.5);
            appState.ctx.strokeStyle = '#ffffff';
            appState.ctx.lineWidth = 1.0 / scale;
            appState.ctx.stroke();
        } else {
            // 他のフレームの軌跡表示
            appState.ctx.beginPath();
            appState.ctx.arc(local.x, local.y, r * 0.4, 0, Math.PI * 2);
            appState.ctx.fillStyle = COLOR_MAP[(p.objectId - 1) % COLOR_MAP.length] + '55';
            appState.ctx.fill();
        }
    });
}

function drawCalibrationMarkers() {
    const scale = appState.viewState.scale;
    
    // 原点描画
    if (appState.calibration.origin) {
        const localO = videoToLocalCanvas(appState.calibration.origin.x, appState.calibration.origin.y);
        appState.ctx.beginPath();
        appState.ctx.moveTo(localO.x - 40 / scale, localO.y);
        appState.ctx.lineTo(localO.x + 40 / scale, localO.y);
        appState.ctx.moveTo(localO.x, localO.y - 40 / scale);
        appState.ctx.lineTo(localO.x, localO.y + 40 / scale);
        appState.ctx.strokeStyle = '#FF5A52';
        appState.ctx.lineWidth = 1.5 / scale;
        appState.ctx.stroke();

        appState.ctx.fillStyle = '#FF5A52';
        appState.ctx.font = `bold ${11 / scale}px IBM Plex Sans JP`;
        appState.ctx.fillText("x", localO.x + 45 / scale, localO.y + 4 / scale);
        appState.ctx.fillText("y", localO.x - 4 / scale, localO.y - 45 / scale);
    }
    
    // スケール描画
    if (appState.calibration.scaleStart && appState.calibration.scaleEnd) {
        const localS = videoToLocalCanvas(appState.calibration.scaleStart.x, appState.calibration.scaleStart.y);
        const localE = videoToLocalCanvas(appState.calibration.scaleEnd.x, appState.calibration.scaleEnd.y);
        
        appState.ctx.beginPath();
        appState.ctx.moveTo(localS.x, localS.y);
        appState.ctx.lineTo(localE.x, localE.y);
        appState.ctx.strokeStyle = '#5AA9E6';
        appState.ctx.lineWidth = 2.0 / scale;
        appState.ctx.stroke();
        
        const angle = Math.atan2(localE.y - localS.y, localE.x - localS.x);
        const perp = angle + Math.PI / 2;
        const barLen = 8 / scale;
        
        const drawEndBar = (pt) => {
            appState.ctx.beginPath();
            appState.ctx.moveTo(pt.x - Math.cos(perp) * barLen, pt.y - Math.sin(perp) * barLen);
            appState.ctx.lineTo(pt.x + Math.cos(perp) * barLen, pt.y + Math.sin(perp) * barLen);
            appState.ctx.stroke();
        };
        drawEndBar(localS);
        drawEndBar(localE);
        
        appState.ctx.fillStyle = '#5AA9E6';
        appState.ctx.font = `${11 / scale}px IBM Plex Sans JP`;
        const midX = (localS.x + localE.x) / 2;
        const midY = (localS.y + localE.y) / 2;
        appState.ctx.fillText(`${appState.calibration.scaleActual} cm`, midX + 10 / scale, midY - 10 / scale);
    } else if (appState.calibration.scaleTempStart) {
        const localTemp = videoToLocalCanvas(appState.calibration.scaleTempStart.x, appState.calibration.scaleTempStart.y);
        appState.ctx.beginPath();
        appState.ctx.arc(localTemp.x, localTemp.y, 5 / scale, 0, Math.PI * 2);
        appState.ctx.fillStyle = '#5AA9E6';
        appState.ctx.fill();
    }
}

// --- 測定データテーブルの更新 ---
function updateDataTable() {
    const tableBody = document.querySelector('#data-table tbody');
    if (!tableBody) return;

    // ヘッダの単位をスケール設定に合わせて更新
    const unit = appState.calibration.scaleRatio ? 'cm' : 'px';
    const ths = document.querySelectorAll('#data-table thead th');
    if (ths.length >= 3) { ths[1].textContent = `x (${unit})`; ths[2].textContent = `y (${unit})`; }

    tableBody.innerHTML = '';
    
    const filteredData = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);

    if (filteredData.length === 0) {
        tableBody.innerHTML = `<tr class="empty-row"><td colspan="4">データがありません</td></tr>`;
        updateStepGuide();
        return;
    }
    
    filteredData.forEach(p => {
        const tr = document.createElement('tr');
        
        let physX = p.x;
        let physY = p.y;
        
        if (appState.calibration.origin) {
            physX = p.x - appState.calibration.origin.x;
            physY = appState.calibration.origin.y - p.y; // Y軸反転
        }
        
        if (appState.calibration.scaleRatio) {
            physX *= appState.calibration.scaleRatio;
            physY *= appState.calibration.scaleRatio;
        }
        
        tr.innerHTML = `
            <td>${p.time.toFixed(3)}</td>
            <td>${physX.toFixed(1)}</td>
            <td>${physY.toFixed(1)}</td>
            <td>
                <button class="btn-danger-small" onclick="deletePoint(${p.id})">削除</button>
            </td>
        `;
        
        // 選択された行のスタイルを変更
        if (p.id === appState.selectedPointId) {
            tr.style.background = '#e8f0fe';
            tr.style.fontWeight = 'bold';
        }
        
        tr.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') {
                setSelectedPoint(p.id);
                seekToFrame(p.frame);
                drawVideoFrame();
                updateDataTable(); // 行選択の再描画
            }
        });
        
        tableBody.appendChild(tr);
    });

    updateStepGuide();
}

function deletePoint(id) {
    pushHistory();
    appState.trackingData = appState.trackingData.filter(p => p.id !== id);
    if (appState.selectedPointId === id) {
        setSelectedPoint(null);
    }
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();
    logDebug(`ポイント削除: ID ${id}`);
}

window.deletePoint = deletePoint;

// --- 物理座標・運動学（速度/加速度）の計算 --------------------------------
// 動画ピクセル座標 → 原点基準・スケール適用済みの物理座標へ
function physCoordOf(p) {
    let x = p.x, y = p.y;
    const cal = appState.calibration;
    if (cal.origin) { x = p.x - cal.origin.x; y = cal.origin.y - p.y; }
    if (cal.scaleRatio) { x *= cal.scaleRatio; y *= cal.scaleRatio; }
    return { x, y, t: p.time, frame: p.frame, id: p.id };
}

// 中心差分で速度・加速度を数値微分（端点は片側差分）
function computeKinematics(sortedData) {
    const pts = sortedData.map(physCoordOf);
    const n = pts.length;
    const t = pts.map(p => p.t);
    const deriv = (arr) => arr.map((_, i) => {
        if (n === 1) return 0;
        if (i === 0)       return (arr[1] - arr[0]) / ((t[1] - t[0]) || 1e-9);
        if (i === n - 1)   return (arr[n - 1] - arr[n - 2]) / ((t[n - 1] - t[n - 2]) || 1e-9);
        return (arr[i + 1] - arr[i - 1]) / ((t[i + 1] - t[i - 1]) || 1e-9);
    });
    const x = pts.map(p => p.x), y = pts.map(p => p.y);
    const vx = deriv(x), vy = deriv(y);
    const ax = deriv(vx), ay = deriv(vy);
    return pts.map((p, i) => ({
        t: t[i], x: x[i], y: y[i],
        vx: vx[i], vy: vy[i], v: Math.hypot(vx[i], vy[i]),
        ax: ax[i], ay: ay[i], a: Math.hypot(ax[i], ay[i]),
        id: p.id, frame: p.frame
    }));
}

// --- リアルタイムグラフ（複数表示・縦積み） ---
const GRAPH_TYPES_KEY = 'tracker_for_ipad_graph_types_v1';
const DEFAULT_GRAPH_TYPES = ['y-t', 'v-t'];
let renderedGraphSignature = null; // 現在 DOM 上に組まれているグラフ種別の署名

function getSelectedGraphTypes() {
    const sel = [];
    document.querySelectorAll('#graph-type-checklist input[type="checkbox"]').forEach(b => {
        if (b.checked) sel.push(b.value);
    });
    return sel;
}

function persistGraphTypes(types) {
    try { localStorage.setItem(GRAPH_TYPES_KEY, JSON.stringify(types)); } catch (e) { /* 無視 */ }
}

function loadGraphTypes() {
    try {
        const raw = localStorage.getItem(GRAPH_TYPES_KEY);
        if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a; }
    } catch (e) { /* 破損は無視 */ }
    return DEFAULT_GRAPH_TYPES.slice();
}

function setupGraphEvents() {
    const checklist = document.getElementById('graph-type-checklist');
    if (!checklist) return;
    // 前回の選択（無ければデフォルト y-t / v-t）をチェック状態へ反映
    const saved = loadGraphTypes();
    checklist.querySelectorAll('input[type="checkbox"]').forEach(b => {
        b.checked = saved.includes(b.value);
    });
    checklist.addEventListener('change', () => {
        persistGraphTypes(getSelectedGraphTypes());
        updateGraph();
    });
}

// 1枚のグラフ canvas にクリックハンドラを取り付ける（当たり判定座標は canvas._plotPoints）
function attachGraphClick(cv) {
    cv.addEventListener('click', (e) => {
        const pts = cv._plotPoints || [];
        const rect = cv.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (cv.width / (rect.width || 1));
        const my = (e.clientY - rect.top) * (cv.height / (rect.height || 1));
        let best = null, bestDist = 16;
        pts.forEach(p => {
            const d = Math.hypot(p.cx - mx, p.cy - my);
            if (d < bestDist) { bestDist = d; best = p; }
        });
        if (best) {
            setSelectedPoint(best.id);
            seekToFrame(best.frame);
            drawVideoFrame();
            updateDataTable();
            updateGraph();
        }
    });
}

// グラフ種別 → 系列の定義（速度・加速度を含む）
function graphSeriesFor(graphType, kin, unit) {
    const t = kin.map(p => p.t);
    const map = {
        'y-t':  { xv: t, yv: kin.map(p => p.y),  lx: 't (s)',     ly: `y (${unit})` },
        'x-t':  { xv: t, yv: kin.map(p => p.x),  lx: 't (s)',     ly: `x (${unit})` },
        'y-x':  { xv: kin.map(p => p.x), yv: kin.map(p => p.y), lx: `x (${unit})`, ly: `y (${unit})`, traj: true },
        'vx-t': { xv: t, yv: kin.map(p => p.vx), lx: 't (s)', ly: `vx (${unit}/s)` },
        'vy-t': { xv: t, yv: kin.map(p => p.vy), lx: 't (s)', ly: `vy (${unit}/s)` },
        'v-t':  { xv: t, yv: kin.map(p => p.v),  lx: 't (s)', ly: `速さ (${unit}/s)` },
        'ax-t': { xv: t, yv: kin.map(p => p.ax), lx: 't (s)', ly: `ax (${unit}/s²)` },
        'ay-t': { xv: t, yv: kin.map(p => p.ay), lx: 't (s)', ly: `ay (${unit}/s²)` },
        'a-t':  { xv: t, yv: kin.map(p => p.a),  lx: 't (s)', ly: `加速度 (${unit}/s²)` }
    };
    return map[graphType] || map['y-t'];
}

// 選択されたグラフ種別ぶんのミニ canvas を縦積みし、それぞれ描画する。
function updateGraph() {
    const stack = document.getElementById('graph-stack');
    if (!stack) return;

    const types = getSelectedGraphTypes();
    const sig = types.join(',');

    // 選択が変わったときだけ DOM を組み直す（毎回の再描画では作り直さない）
    if (sig !== renderedGraphSignature) {
        stack.innerHTML = '';
        if (types.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'graph-empty-hint';
            hint.textContent = '上のチェックで表示する量を選んでください';
            stack.appendChild(hint);
        } else {
            types.forEach(type => {
                const box = document.createElement('div');
                box.className = 'mini-graph';
                const cv = document.createElement('canvas');
                cv.dataset.type = type;
                box.appendChild(cv);
                stack.appendChild(box);
                attachGraphClick(cv);
            });
        }
        renderedGraphSignature = sig;
    }

    const data = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);
    const unit = appState.calibration.scaleRatio ? "cm" : "px";
    const kin = data.length ? computeKinematics(data) : [];

    stack.querySelectorAll('canvas').forEach(cv => {
        drawOneGraph(cv, cv.dataset.type, data, kin, unit);
    });
}

// グラフ1枚を canvas に描画。当たり判定座標は cv._plotPoints に保持。
function drawOneGraph(graphCanvas, graphType, data, kin, unit) {
    // 親要素のサイズに Canvas の物理解像度をフィットさせる
    const container = graphCanvas.parentElement;
    if (container.clientWidth > 0 && container.clientHeight > 0) {
        graphCanvas.width = container.clientWidth;
        graphCanvas.height = container.clientHeight;
    }

    const gCtx = graphCanvas.getContext('2d');
    gCtx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
    const plotPoints = [];
    graphCanvas._plotPoints = plotPoints;

    if (!data || data.length === 0) {
        gCtx.fillStyle = '#7A828E';
        gCtx.font = '11px IBM Plex Sans JP';
        gCtx.textAlign = 'center';
        gCtx.textBaseline = 'middle';
        gCtx.fillText("測定が開始されると自動で描画されます", graphCanvas.width / 2, graphCanvas.height / 2);
        return;
    }

    const series = graphSeriesFor(graphType, kin, unit);
    const valX = series.xv, valY = series.yv;
    const labelX = series.lx, labelY = series.ly;

    let minX = Math.min(...valX);
    let maxX = Math.max(...valX);
    let minY = Math.min(...valY);
    let maxY = Math.max(...valY);
    
    // 最大最小が一致する場合のフラット防止
    if (maxX === minX) { maxX += 1; minX -= 1; }
    if (maxY === minY) { maxY += 1; minY -= 1; }
    
    // マージン
    const padL = 35;
    const padR = 15;
    const padT = 15;
    const padB = 22;
    
    const plotW = graphCanvas.width - padL - padR;
    const plotH = graphCanvas.height - padT - padB;
    
    const toCanvasX = (val) => padL + ((val - minX) / (maxX - minX)) * plotW;
    const toCanvasY = (val) => padT + plotH - ((val - minY) / (maxY - minY)) * plotH;
    
    // グリッド背景線
    gCtx.strokeStyle = '#222933';
    gCtx.lineWidth = 1;
    
    // X軸の補助線と目盛りラベル
    const xSteps = 4;
    for (let i = 0; i <= xSteps; i++) {
        const ratio = i / xSteps;
        const val = minX + ratio * (maxX - minX);
        const cx = toCanvasX(val);
        
        gCtx.beginPath();
        gCtx.moveTo(cx, padT);
        gCtx.lineTo(cx, padT + plotH);
        gCtx.stroke();
        
        gCtx.fillStyle = '#7A828E';
        gCtx.font = '8px IBM Plex Mono';
        gCtx.textAlign = 'center';
        gCtx.fillText(val.toFixed(2), cx, padT + plotH + 11);
    }
    
    // Y軸の補助線と目盛りラベル
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
        const ratio = i / ySteps;
        const val = minY + ratio * (maxY - minY);
        const cy = toCanvasY(val);
        
        gCtx.beginPath();
        gCtx.moveTo(padL, cy);
        gCtx.lineTo(padL + plotW, cy);
        gCtx.stroke();
        
        gCtx.fillStyle = '#7A828E';
        gCtx.font = '8px IBM Plex Mono';
        gCtx.textAlign = 'right';
        gCtx.fillText(val.toFixed(1), padL - 5, cy + 3);
    }
    
    // 主軸線
    gCtx.strokeStyle = '#3A434F';
    gCtx.lineWidth = 1.2;
    gCtx.beginPath();
    gCtx.moveTo(padL, padT);
    gCtx.lineTo(padL, padT + plotH);
    gCtx.lineTo(padL + plotW, padT + plotH);
    gCtx.stroke();
    
    // 軸名ラベルの描画
    gCtx.fillStyle = '#9AA3AE';
    gCtx.font = '8px IBM Plex Sans JP';
    gCtx.textAlign = 'right';
    gCtx.fillText(labelX, graphCanvas.width - 4, graphCanvas.height - 4);
    gCtx.textAlign = 'left';
    gCtx.fillText(labelY, 4, 8);
    
    // 線グラフ描画
    gCtx.strokeStyle = COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
    gCtx.lineWidth = 1.8;
    gCtx.beginPath();
    
    valX.forEach((vx, idx) => {
        const cx = toCanvasX(vx);
        const cy = toCanvasY(valY[idx]);
        if (idx === 0) {
            gCtx.moveTo(cx, cy);
        } else {
            gCtx.lineTo(cx, cy);
        }
    });
    gCtx.stroke();
    
    // ドットプロット描画 ＆ クリック当たり判定座標の記録
    valX.forEach((vx, idx) => {
        const cx = toCanvasX(vx);
        const cy = toCanvasY(valY[idx]);
        plotPoints.push({ cx, cy, id: data[idx].id, frame: data[idx].frame });

        gCtx.beginPath();
        // 選択されたポイントはプロット上でも大きく＆アンバーで強調（三者連動）
        const isSel = (data[idx].id === appState.selectedPointId);
        gCtx.arc(cx, cy, isSel ? 5.0 : 3.0, 0, Math.PI * 2);
        gCtx.fillStyle = isSel ? '#FFB627' : COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
        gCtx.fill();
        gCtx.strokeStyle = isSel ? '#FFB627' : '#0F1216';
        gCtx.lineWidth = isSel ? 2 : 1;
        gCtx.stroke();
    });
}

// --- エクスポート ---
// 全物体について 位置・速度・加速度 を計算した行列を作る
function buildExportTable() {
    const unit = appState.calibration.scaleRatio ? 'cm' : 'px';
    const header = ['object_id', 'frame', 't (s)',
        `x (${unit})`, `y (${unit})`,
        `vx (${unit}/s)`, `vy (${unit}/s)`, `v (${unit}/s)`,
        `ax (${unit}/s^2)`, `ay (${unit}/s^2)`, `a (${unit}/s^2)`];
    const rows = [];

    const objectIds = [...new Set(appState.trackingData.map(p => p.objectId))].sort((a, b) => a - b);
    objectIds.forEach(oid => {
        const sorted = appState.trackingData
            .filter(p => p.objectId === oid && inAnalysisRange(p.frame))
            .sort((a, b) => a.frame - b.frame);
        const kin = computeKinematics(sorted);
        kin.forEach(k => {
            rows.push([oid, k.frame,
                round(k.t, 4), round(k.x, 3), round(k.y, 3),
                round(k.vx, 3), round(k.vy, 3), round(k.v, 3),
                round(k.ax, 3), round(k.ay, 3), round(k.a, 3)]);
        });
    });
    return { header, rows };
}

function round(v, d) { const m = Math.pow(10, d); return Math.round(v * m) / m; }

function tableToTSV(table) {
    const lines = [table.header.join('\t')];
    table.rows.forEach(r => lines.push(r.join('\t')));
    return lines.join('\n') + '\n';
}

function setupExport() {
    const btnExport = document.getElementById('btn-export');
    if (!btnExport) return;

    btnExport.addEventListener('click', () => {
        if (appState.trackingData.length === 0) {
            logDebug("エクスポートするデータがありません。");
            return;
        }
        const table = buildExportTable();
        const tsv = tableToTSV(table);
        const hasXlsx = typeof XLSX !== 'undefined';

        const dialogText = `
            <p style="margin-bottom:6px;">位置に加え、速度・加速度（数値微分）も含みます。</p>
            <textarea style="width:100%; height:120px; font-family:'IBM Plex Mono',monospace; background:#0F1216; color:#E6EAEF; border:1px solid #2B333D; border-radius:5px; padding:8px; font-size:0.78rem;" readonly>${tsv}</textarea>
            <div style="margin-top:10px; display:flex; gap:8px;">
                <button class="btn btn-secondary" id="btn-copy-tsv" style="flex:1;">TSVをコピー</button>
                <button class="btn btn-secondary" id="btn-download-tsv" style="flex:1;">TSV保存</button>
                <button class="btn btn-primary" id="btn-download-xlsx" style="flex:1;" ${hasXlsx ? '' : 'disabled title="xlsxライブラリ未読込（ネット接続が必要）"'}>xlsx保存</button>
            </div>
        `;

        showInputDialog("データエクスポート", dialogText, "", () => {});

        document.getElementById('btn-copy-tsv').addEventListener('click', () => {
            navigator.clipboard.writeText(tsv)
                .then(() => logDebug("TSVをクリップボードにコピーしました（表計算に貼り付け可）"))
                .catch(() => logDebug("コピー失敗"));
        });

        document.getElementById('btn-download-tsv').addEventListener('click', () => {
            downloadBlob(new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8;' }), 'tracking_data.tsv');
            logDebug("TSVファイルを保存しました");
        });

        const xlsxBtn = document.getElementById('btn-download-xlsx');
        if (xlsxBtn && hasXlsx) {
            xlsxBtn.addEventListener('click', () => {
                const ws = XLSX.utils.aoa_to_sheet([table.header, ...table.rows]);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'tracking');
                XLSX.writeFile(wb, 'tracking_data.xlsx');
                logDebug("xlsxファイルを保存しました");
            });
        }
    });
}

// --- ストロボ写真 -----------------------------------------------------
// 追跡点周辺の円形パッチ切り貼り方式：基準フレーム（最初の点のコマ）の上に、
// 各確定点の周囲だけをそのコマの映像から切り出して重ねる。明合成と違い
// 背景の明暗に依存せず、明るい教室の映像でも確実に「残像列」になる。
// フレームは1枚ずつシークして合成し、キャッシュしない（iPad Safariの
// canvas総メモリ上限≈384MB対策）。
const STROBE_MAX_DIM = 4096; // iOS Safariのcanvas1辺上限（安全側）

function strobePoints(everyN) {
    return appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame)
        .filter((p, i) => i % everyN === 0);
}

async function generateStrobe(canvas, everyN, radius, onProgress) {
    const v = appState.videoElement;
    const pts = strobePoints(everyN);
    if (pts.length < 2) return 0;

    // 動画実解像度で合成（上限超過時のみ縮小）
    const s = Math.min(1, STROBE_MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round(v.videoWidth * s);
    canvas.height = Math.round(v.videoHeight * s);
    const ctx = canvas.getContext('2d');

    const returnFrame = appState.currentFrame;
    appState.isScanning = true; // 大量シーク中の本描画をスキップ（高速化）
    try {
        // 基準フレーム＝最初の点のコマを全面に敷く
        await getFrameAt(v, seekTimeOf(pts[0].frame));
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        // 2点目以降：そのコマの映像から点の周囲だけを円形に切り貼り
        for (let i = 1; i < pts.length; i++) {
            await getFrameAt(v, seekTimeOf(pts[i].frame));
            ctx.save();
            ctx.beginPath();
            ctx.arc(pts[i].x * s, pts[i].y * s, radius * s, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            ctx.restore();
            if (onProgress) onProgress((i + 1) / pts.length);
        }
    } finally {
        appState.isScanning = false;
        seekToFrame(returnFrame);
    }
    return pts.length;
}

function setupStrobe() {
    const btn = document.getElementById('btn-strobe');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (strobePoints(1).length < 2) {
            showInputDialog('ストロボ写真', '<p>この物体の追跡点が2点以上必要です。<br>十字を対象に合わせて「確定」で点を打ってから使ってください。</p>', '', () => {});
            return;
        }
        const body = `
            <p style="margin-bottom:6px;">追跡点のコマを重ねてストロボ写真を作ります。</p>
            <canvas id="strobe-preview" style="width:100%; border:1px solid #2B333D; border-radius:5px; background:#0F1216;"></canvas>
            <div style="display:flex; gap:14px; margin-top:8px; font-size:0.8rem;">
                <label style="flex:1;">間引き（1/N点）: <span id="strobe-n-val">1</span>
                    <input type="range" id="strobe-n" min="1" max="10" value="1" style="width:100%;">
                </label>
                <label style="flex:1;">パッチ半径(px): <span id="strobe-r-val">60</span>
                    <input type="range" id="strobe-r" min="10" max="200" value="60" style="width:100%;">
                </label>
            </div>
            <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                <button class="btn btn-primary" id="btn-strobe-save" style="flex:1;">PNG保存</button>
                <span id="strobe-status" style="font-size:0.75rem; color:#8A95A3;"></span>
            </div>
        `;
        showInputDialog('ストロボ写真', body, '', () => {});

        const cv = document.getElementById('strobe-preview');
        const status = document.getElementById('strobe-status');
        let busy = false;
        const regen = async () => {
            if (busy) return;
            busy = true;
            const n = parseInt(document.getElementById('strobe-n').value);
            const r = parseInt(document.getElementById('strobe-r').value);
            document.getElementById('strobe-n-val').textContent = n;
            document.getElementById('strobe-r-val').textContent = r;
            if (status) status.textContent = '合成中…';
            const count = await generateStrobe(cv, n, r,
                (p) => { if (status) status.textContent = `合成中… ${Math.round(p * 100)}%`; });
            if (status) status.textContent = count ? `${count}コマを合成` : '点が不足しています';
            busy = false;
        };
        document.getElementById('strobe-n').addEventListener('change', regen);
        document.getElementById('strobe-r').addEventListener('change', regen);
        document.getElementById('btn-strobe-save').addEventListener('click', () => {
            cv.toBlob((blob) => {
                if (blob) { downloadBlob(blob, 'strobe.png'); logDebug('ストロボ写真を保存しました'); }
            }, 'image/png');
        });
        regen();
    });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// --- ダイアログの制御 ---
function showInputDialog(title, bodyText, defaultValue, onOk) {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnOk = document.getElementById('dialog-btn-ok');
    
    if (!overlay) return;
    
    titleEl.textContent = title;
    
    if (bodyText.includes("<textarea") || bodyText.includes("<input") || bodyText.includes("<button")) {
        bodyEl.innerHTML = bodyText;
    } else {
        bodyEl.innerHTML = `
            <p>${bodyText}</p>
            <input type="text" id="dialog-input-val" value="${defaultValue}">
        `;
    }
    
    overlay.style.display = 'flex';
    
    const cleanup = () => {
        overlay.style.display = 'none';
        const newOk = btnOk.cloneNode(true);
        const newCancel = btnCancel.cloneNode(true);
        btnOk.parentNode.replaceChild(newOk, btnOk);
        btnCancel.parentNode.replaceChild(newCancel, btnCancel);
    };
    
    document.getElementById('dialog-btn-ok').addEventListener('click', () => {
        const inputEl = document.getElementById('dialog-input-val');
        const val = inputEl ? inputEl.value : "";
        cleanup();
        onOk(val);
    });
    
    document.getElementById('dialog-btn-cancel').addEventListener('click', () => {
        cleanup();
    });
}

// 確認専用ダイアログ（入力欄なし、OK/キャンセルのコールバックのみ）
function showConfirmDialog(title, bodyText, onOk, onCancel) {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnOk = document.getElementById('dialog-btn-ok');

    if (!overlay) return;

    titleEl.textContent = title;
    bodyEl.innerHTML = `<p>${bodyText}</p>`;

    overlay.style.display = 'flex';

    const cleanup = () => {
        overlay.style.display = 'none';
        const newOk = btnOk.cloneNode(true);
        const newCancel = btnCancel.cloneNode(true);
        btnOk.parentNode.replaceChild(newOk, btnOk);
        btnCancel.parentNode.replaceChild(newCancel, btnCancel);
    };

    document.getElementById('dialog-btn-ok').addEventListener('click', () => {
        cleanup();
        if (onOk) onOk();
    });

    document.getElementById('dialog-btn-cancel').addEventListener('click', () => {
        cleanup();
        if (onCancel) onCancel();
    });
}

// --- Node.js テスト用および統合テスト用エクスポート ---
// 内部状態をテストから差し替えるヘルパ（node・ブラウザ両方で使う）
function test_setVars(vars) {
    if (vars.canvas !== undefined) appState.canvas = vars.canvas;
    if (vars.videoElement !== undefined) appState.videoElement = vars.videoElement;
    if (vars.viewState !== undefined) appState.viewState = vars.viewState;
    if (vars.calibration !== undefined) appState.calibration = vars.calibration;
    if (vars.trackingData !== undefined) appState.trackingData = vars.trackingData;
    if (vars.frameTimes !== undefined) appState.frameTimes = vars.frameTimes;
    if (vars.videoFps !== undefined) appState.videoFps = vars.videoFps;
    if (vars.videoDuration !== undefined) appState.videoDuration = vars.videoDuration;
}

window.canvasToVideo = canvasToVideo;
window.videoToCanvas = videoToCanvas;
window.videoToLocalCanvas = videoToLocalCanvas;
window.getFitMetrics = getFitMetrics;
window.frameTimeOf = frameTimeOf;
window.seekTimeOf = seekTimeOf;
window.generateStrobe = generateStrobe;
window.strobePoints = strobePoints;
window.frameIndexOfTime = frameIndexOfTime;
window.buildFrameTimeTable = buildFrameTimeTable;
window.seekToFrame = seekToFrame;
window.stepFrame = stepFrame;
window.setPendingCapture = setPendingCapture;
window.confirmAtCrosshair = confirmAtCrosshair;
window.getCrosshairVideoCoord = getCrosshairVideoCoord;
window.resetZoom = resetZoom;
window.updateGraph = updateGraph;
window.deletePoint = deletePoint;
window.undo = undo;
window.computeKinematics = computeKinematics;
window.buildExportTable = buildExportTable;
window.startFrameScan = startFrameScan;
window.test_setVars = test_setVars;

if (typeof module !== 'undefined') {
    module.exports = {
        appState,
        canvasToVideo,
        videoToCanvas,
        videoToLocalCanvas,
        getFitMetrics,
        frameTimeOf,
        seekTimeOf,
        buildFrameTimeTable,
        seekToFrame,
        stepFrame,
        sampleColor,
        test_setVars
    };
}
