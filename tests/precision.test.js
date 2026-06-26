// Physics Tracker - tests/precision.test.js
// 「50cm落下でも動く精度」の検証。合成の水平投射動画(120fps・既知g・複製フレーム入り)を
// アプリ実パイプライン(seek-scan→複製除外→自動追跡→運動学)に通し、g±5% / v-t直線 を確認。
// rVFC対応端末と、非対応の古い端末(格安スマホ想定)フォールバックの両方を検証する。
//   実行: node tests/precision.test.js
// 既存 Chrome を DevTools Protocol で駆動（Claude拡張も Playwright も不要）。
// fixtures/fall120.mp4 は gen_fall.py で生成（10px=1cm, g=9.8m/s^2, 末尾に複製1枚）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

function startServer() {
    return new Promise(res => {
        const srv = http.createServer((q, r) => {
            let p = decodeURIComponent(q.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            const fp = p.startsWith('/fix/') ? path.join(FIX, p.slice(5)) : path.join(ROOT, p);
            if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { r.writeHead(404); r.end(); return; }
            r.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
            r.end(fs.readFileSync(fp));
        });
        srv.listen(0, '127.0.0.1', () => res(srv));
    });
}
const httpGet = (u) => new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); });
const connectWS = (u) => new Promise((res, rej) => { const w = new WebSocket(u); w.addEventListener('open', () => res(w)); w.addEventListener('error', () => rej(new Error('ws'))); });

(async () => {
    console.log('=== 精度E2E (実Chrome / DevTools Protocol) 開始 ===');
    const srv = await startServer();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'prec-'));
    const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
        '--no-first-run', '--disable-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
    let ws;
    try {
        const f = path.join(udd, 'DevToolsActivePort'); const t0 = Date.now();
        while (!fs.existsSync(f)) { if (Date.now() - t0 > 12000) throw new Error('no DevToolsActivePort'); await new Promise(r => setTimeout(r, 100)); }
        const port = fs.readFileSync(f, 'utf8').split('\n')[0];
        const ver = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
        ws = await connectWS(ver.webSocketDebuggerUrl);
        let id = 0; const pend = new Map();
        ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { rs, rj } = pend.get(m.id); pend.delete(m.id); m.error ? rj(new Error(JSON.stringify(m.error))) : rs(m.result); } });
        const send = (method, params = {}, S) => { const i = ++id; const msg = { id: i, method, params }; if (S) msg.sessionId = S; return new Promise((rs, rj) => { pend.set(i, { rs, rj }); ws.send(JSON.stringify(msg)); }); };
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
        await send('Runtime.enable', {}, S);
        await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }, S);
        const ev = async body => {
            const r = await send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }, S);
            if (r.exceptionDetails) throw new Error('PAGE:' + JSON.stringify(r.exceptionDetails.exception));
            return r.result.value;
        };
        await send('Page.navigate', { url: base + '/index.html' }, S);
        for (let i = 0; i < 80 && !(await ev(`return document.readyState==='complete'&&!!window.appState`)); i++) await new Promise(r => setTimeout(r, 100));

        // rVFC対応 / 非対応(フォールバック) の両モードを検証
        for (const mode of ['rvfc', 'fallback']) {
            console.log(`\n--- モード: ${mode === 'rvfc' ? 'rVFC対応端末' : 'rVFC非対応の古い端末(フォールバック)'} ---`);
            await ev(`window.__setRvfc(${mode === 'rvfc'}); return 1;`);
            await ev(`
                const b = await fetch('${base}/fix/fall120.mp4').then(r=>r.blob());
                const s=appState; s.frameTimes=[]; s.fpsManual=false; s.fpsMeasured=false; s.trackingData=[];
                s.videoElement.src = URL.createObjectURL(b); s.videoElement.load(); return 1;`);
            for (let i = 0; i < 300 && !(await ev(`return appState.videoElement.readyState>=2 && appState.videoDuration>0`)); i++) await new Promise(r => setTimeout(r, 100));
            for (let i = 0; i < 800 && (await ev(`return appState.isScanning===true || appState.totalFrames===0`)); i++) await new Promise(r => setTimeout(r, 100));

            const meta = await ev(`return {n:appState.frameTimes.length, total:appState.totalFrames, fps:appState.videoFps};`);
            ok(meta.n >= 38 && meta.n <= 41, `重複除外後の実フレーム数≈40 (実測 ${meta.n})／複製1枚は除外`);

            // 黄ボールを全フレーム自動追跡 → trackingData
            await ev(`
                const s=appState, v=s.videoElement, N=s.totalFrames;
                const cv=document.createElement('canvas'); cv.width=540; cv.height=960; const cx=cv.getContext('2d',{willReadFrequently:true});
                const seek=(n)=>new Promise(r=>{let d=false;const h=()=>{if(d)return;d=true;v.removeEventListener('seeked',h);r();};v.addEventListener('seeked',h);window.seekToFrame(n);setTimeout(()=>{if(!d){d=true;v.removeEventListener('seeked',h);r();}},2000);});
                s.trackingData=[]; s.activeObjectId=1;
                for(let n=0;n<=N;n++){ await seek(n); await new Promise(r=>setTimeout(r,20));
                    cx.drawImage(v,0,0,540,960); const d=cx.getImageData(0,0,540,960).data; let sx=0,sy=0,c=0;
                    for(let i=0;i<d.length;i+=4){ if(d[i]>140&&d[i+1]>140&&d[i+2]<110){ sx+=(i/4)%540; sy+=Math.floor((i/4)/540); c++; } }
                    if(c>0){ s.trackingData.push({id:1000+n, frame:n, time:window.frameTimeOf(n), x:sx/c, y:sy/c, objectId:1}); }
                }
                s.calibration={origin:{x:270,y:60}, scaleRatio:0.1, scaleStart:null,scaleEnd:null,scaleActual:0,scaleTempStart:null};
                return s.trackingData.length;
            `);

            const res = await ev(`
                const data=appState.trackingData.filter(p=>p.objectId===1).sort((a,b)=>a.frame-b.frame);
                const kin=window.computeKinematics(data);
                const amag=kin.map(k=>Math.abs(k.ay)).slice(1,-1).sort((x,y)=>x-y);
                const aMed=amag[Math.floor(amag.length/2)];
                const pts=kin.map(k=>({t:k.t,v:k.vy})); const nL=pts.length;
                const mt=pts.reduce((a,p)=>a+p.t,0)/nL, mv=pts.reduce((a,p)=>a+p.v,0)/nL;
                let stt=0,stv=0; pts.forEach(p=>{stt+=(p.t-mt)**2; stv+=(p.t-mt)*(p.v-mv);});
                const slope=stv/stt, inter=mv-slope*mt;
                let ssr=0,sst=0; pts.forEach(p=>{const fk=slope*p.t+inter; ssr+=(p.v-fk)**2; sst+=(p.v-mv)**2;});
                return {aMed, r2:1-ssr/sst};
            `);
            const g = res.aMed / 100; // cm/s^2 -> m/s^2
            const gTol = mode === 'rvfc' ? 0.05 : 0.10;
            const r2Min = mode === 'rvfc' ? 0.99 : 0.97;
            console.log(`  |ay|中央値=${res.aMed.toFixed(1)} cm/s^2 = ${g.toFixed(3)} m/s^2  R^2=${res.r2.toFixed(5)}`);
            ok(Math.abs(g - 9.8) / 9.8 <= gTol, `[${mode}] 加速度 g=${g.toFixed(3)} m/s^2 が 9.8±${gTol * 100}% 以内`);
            ok(res.r2 > r2Min, `[${mode}] v-t 直線 R^2=${res.r2.toFixed(5)} > ${r2Min}`);
        }
    } catch (e) {
        fail++; console.error('❌ 実行エラー: ' + e.message);
    } finally {
        try { if (ws) ws.close(); } catch (e) {}
        try { proc.kill(); } catch (e) {}
        try { srv.close(); } catch (e) {}
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
    }
    console.log(`\n=== 精度E2E 終了: ${pass} PASS / ${fail} FAIL ===`);
    process.exit(fail === 0 ? 0 : 1);
})();
