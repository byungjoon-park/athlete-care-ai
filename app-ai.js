(function(){
  'use strict';

  const APP_STORE_KEY = (typeof storeKey !== 'undefined' && storeKey) ? storeKey : 'athlete-care-v1';
  const CAMERA_PREF_KEY = 'athlete-care-camera-facing';
  const FALLBACK_AI_STORE = 'athlete-care-ai-enhanced';

  const stateRefs = {
    stream: null,
    pose: null,
    running: false,
    rafId: 0,
    currentMode: 'bio',
    facingMode: localStorage.getItem(CAMERA_PREF_KEY) || 'environment',
    lastVideoTime: -1,
    lastLandmarks: null,
    romSession: null,
    jumpSession: null,
    latestMetrics: {
      rom: null,
      jump: null,
      fatigue: null,
      bmi: null,
      summary: '분석 대기 중'
    }
  };

  function qs(id){ return document.getElementById(id); }
  function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }
  function safeNumber(v){
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
  function round1(v){ return Math.round(v * 10) / 10; }
  function avg(nums){ return nums.length ? nums.reduce((a,b)=>a+b,0) / nums.length : 0; }
  function nowTs(){ return Date.now(); }
  function uid(){ return nowTs().toString(36); }

  function toastMsg(msg){
    if (typeof toast === 'function') toast(msg);
    else console.log('[AthleteCare]', msg);
  }

  function getAppState(){
    if (typeof state !== 'undefined' && state) return state;
    try {
      const raw = localStorage.getItem(APP_STORE_KEY);
      if (!raw) return { aiLogs: [], dailyLogs: [], injuries: [], profile: {} };
      return JSON.parse(raw);
    } catch (err) {
      return { aiLogs: [], dailyLogs: [], injuries: [], profile: {} };
    }
  }

  function persistFallbackAI(payload){
    try {
      const raw = localStorage.getItem(FALLBACK_AI_STORE);
      const items = raw ? JSON.parse(raw) : [];
      items.unshift(payload);
      localStorage.setItem(FALLBACK_AI_STORE, JSON.stringify(items.slice(0, 30)));
    } catch (err) {}
  }

  function persistAiLog(type, result, extra){
    const payload = Object.assign({
      id: uid(),
      date: new Date().toISOString().slice(0,10),
      type,
      result
    }, extra || {});

    try {
      if (typeof saveAiResult === 'function') {
        saveAiResult(type, result);
      } else {
        const appState = getAppState();
        appState.aiLogs = Array.isArray(appState.aiLogs) ? appState.aiLogs : [];
        appState.aiLogs.push(payload);
        appState.aiLogs = appState.aiLogs.slice(-20);
        localStorage.setItem(APP_STORE_KEY, JSON.stringify(appState));
      }
    } catch (err) {
      persistFallbackAI(payload);
    }

    persistFallbackAI(payload);

    if (typeof renderReport === 'function') {
      try { renderReport(); } catch (err) {}
    }
    renderAiHistory();
  }

  function latestDailyLog(){
    const appState = getAppState();
    const logs = Array.isArray(appState.dailyLogs) ? [...appState.dailyLogs] : [];
    if (!logs.length) return null;
    logs.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    return logs[0];
  }

  function getFallbackHistory(){
    try {
      const raw = localStorage.getItem(FALLBACK_AI_STORE);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      return [];
    }
  }

  function getCombinedAiHistory(){
    const appState = getAppState();
    const main = Array.isArray(appState.aiLogs) ? appState.aiLogs : [];
    const fallback = getFallbackHistory();
    const map = new Map();
    [...fallback, ...main].forEach(item => {
      const key = [item.id || '', item.date || '', item.type || '', item.result || ''].join('|');
      if (!map.has(key)) map.set(key, item);
    });
    return [...map.values()].sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0, 8);
  }

  function getProfileHeight(){
    const h = safeNumber(qs('aiHeight') && qs('aiHeight').value);
    return h > 0 ? h : 170;
  }

  function updateMetric(id, value){
    const el = qs(id);
    if (el) el.textContent = value;
  }

  function analysisModeMeta(mode){
    return {
      bio: {
        title: '신체정보 · BMI',
        text: '키와 몸무게를 입력하면 BMI를 계산하고 기본 피로 지표 계산에 반영합니다.'
      },
      rom: {
        title: 'ROM 자동 측정',
        text: 'MediaPipe Pose 스켈레톤으로 좌우 관절 각도를 실시간 계산하고 ROM 비대칭을 자동 측정합니다.'
      },
      jmp: {
        title: 'Jump(JMP) 분석',
        text: '점프 시 엉덩이 중심 변위와 비행 시간을 추정해 도약 높이와 착지 비대칭을 계산합니다.'
      }
    }[mode] || {
      title: 'AI 분석',
      text: '분석 항목을 선택하세요.'
    };
  }

  function openMode(mode){
    stateRefs.currentMode = mode;
    const meta = analysisModeMeta(mode);
    updateMetric('aiModeTitle', meta.title);
    updateMetric('aiModeText', meta.text);
    qsa('.ai-card-v6[data-mode]').forEach(card => {
      card.classList.toggle('active-mode', card.dataset.mode === mode);
    });

    const romWrap = qs('romControlsWrap');
    const bioWrap = qs('bioSummaryWrap');
    if (romWrap) romWrap.classList.toggle('hidden', mode !== 'rom');
    if (bioWrap) bioWrap.classList.remove('hidden');

    const hintMap = {
      bio: '신체정보 저장 후 ROM 또는 JMP 분석으로 이동할 수 있습니다.',
      rom: '전신이 프레임에 보이도록 서서 좌우 관절 각도를 측정하세요.',
      jmp: '측면 또는 정면에서 전신이 보이도록 점프하면 자동으로 최고 점프를 추정합니다.'
    };
    updateMetric('cameraHint', hintMap[mode] || 'AI 분석 대기');
  }

  window.openAiMode = openMode;

  function calculateBMI(){
    const h = safeNumber(qs('aiHeight') && qs('aiHeight').value);
    const w = safeNumber(qs('aiWeight') && qs('aiWeight').value);
    if (!h || !w) {
      updateMetric('bmiResult', 'BMI: -');
      stateRefs.latestMetrics.bmi = null;
      return null;
    }
    const bmi = w / Math.pow(h / 100, 2);
    const label = bmi < 18.5 ? '저체중' : bmi < 23 ? '정상' : bmi < 25 ? '과체중' : '고위험';
    const text = `BMI ${round1(bmi)} · ${label}`;
    updateMetric('bmiResult', text);
    stateRefs.latestMetrics.bmi = { value: round1(bmi), label };
    return stateRefs.latestMetrics.bmi;
  }

  function angleABC(a,b,c){
    if (!a || !b || !c) return null;
    const abx = a.x - b.x, aby = a.y - b.y;
    const cbx = c.x - b.x, cby = c.y - b.y;
    const dot = abx * cbx + aby * cby;
    const mag1 = Math.hypot(abx, aby);
    const mag2 = Math.hypot(cbx, cby);
    if (!mag1 || !mag2) return null;
    const cos = clamp(dot / (mag1 * mag2), -1, 1);
    return Math.acos(cos) * 180 / Math.PI;
  }

  function visOk(p){ return p && (p.visibility == null || p.visibility > 0.45); }

  function computeRomMetrics(lm, joint){
    const spec = {
      shoulder: {
        label: '어깨',
        left: [13,11,23],
        right: [14,12,24]
      },
      elbow: {
        label: '팔꿈치',
        left: [11,13,15],
        right: [12,14,16]
      },
      hip: {
        label: '고관절',
        left: [11,23,25],
        right: [12,24,26]
      },
      knee: {
        label: '무릎',
        left: [23,25,27],
        right: [24,26,28]
      },
      ankle: {
        label: '발목',
        left: [25,27,31],
        right: [26,28,32]
      }
    }[joint] || {
      label: '무릎',
      left: [23,25,27],
      right: [24,26,28]
    };

    const leftPts = spec.left.map(i => lm[i]);
    const rightPts = spec.right.map(i => lm[i]);
    const left = leftPts.every(visOk) ? angleABC(leftPts[0], leftPts[1], leftPts[2]) : null;
    const right = rightPts.every(visOk) ? angleABC(rightPts[0], rightPts[1], rightPts[2]) : null;
    const asymmetry = (left != null && right != null) ? Math.abs(left - right) : null;
    return {
      label: spec.label,
      left: left != null ? round1(left) : null,
      right: right != null ? round1(right) : null,
      asymmetry: asymmetry != null ? round1(asymmetry) : null
    };
  }

  function resetRomSession(){
    stateRefs.romSession = {
      leftMax: null,
      rightMax: null,
      leftMin: null,
      rightMin: null,
      joint: qs('romJoint') ? qs('romJoint').value : 'knee'
    };
  }

  function updateRomSession(metrics){
    if (!stateRefs.romSession || stateRefs.romSession.joint !== (qs('romJoint') ? qs('romJoint').value : 'knee')) {
      resetRomSession();
    }
    const s = stateRefs.romSession;
    ['left','right'].forEach(side => {
      const value = metrics[side];
      if (value == null) return;
      const maxKey = side + 'Max';
      const minKey = side + 'Min';
      s[maxKey] = s[maxKey] == null ? value : Math.max(s[maxKey], value);
      s[minKey] = s[minKey] == null ? value : Math.min(s[minKey], value);
    });
  }

  function bodyPixelHeight(lm, canvasHeight){
    const nose = lm[0];
    const leftAnkle = lm[27];
    const rightAnkle = lm[28];
    if (!visOk(nose) || !visOk(leftAnkle) || !visOk(rightAnkle)) return 0;
    const ankleMid = {
      x: (leftAnkle.x + rightAnkle.x) / 2,
      y: (leftAnkle.y + rightAnkle.y) / 2
    };
    return Math.hypot((nose.x - ankleMid.x) * canvasHeight, (nose.y - ankleMid.y) * canvasHeight);
  }

  function resetJumpSession(){
    stateRefs.jumpSession = {
      baselineSamples: [],
      baselineHip: null,
      squatStartTs: null,
      takeoffTs: null,
      landingTs: null,
      lastHipY: null,
      lastTs: null,
      peakDispNorm: 0,
      peakDispPx: 0,
      peakHeightCm: 0,
      flightMs: 0,
      landingAsym: null,
      movementState: 'ready'
    };
  }

  function updateJumpMetrics(lm, canvasHeight){
    if (!stateRefs.jumpSession) resetJumpSession();
    const s = stateRefs.jumpSession;
    const leftHip = lm[23], rightHip = lm[24], leftAnkle = lm[27], rightAnkle = lm[28];
    if (![leftHip, rightHip, leftAnkle, rightAnkle].every(visOk)) return null;

    const hipY = (leftHip.y + rightHip.y) / 2;
    const ts = performance.now();

    if (s.baselineSamples.length < 20 && !s.takeoffTs) {
      s.baselineSamples.push(hipY);
      s.baselineHip = avg(s.baselineSamples);
    } else if (s.baselineHip == null) {
      s.baselineHip = hipY;
    } else if (!s.takeoffTs && s.baselineSamples.length >= 20) {
      s.baselineHip = (s.baselineHip * 0.96) + (hipY * 0.04);
    }

    const baseline = s.baselineHip || hipY;
    const upDispNorm = Math.max(0, baseline - hipY);
    const downDispNorm = Math.max(0, hipY - baseline);
    const pxDisp = upDispNorm * canvasHeight;
    const bph = bodyPixelHeight(lm, canvasHeight);
    const estimatedHeight = bph ? (pxDisp / bph) * getProfileHeight() * 0.95 : 0;

    if (pxDisp > s.peakDispPx) {
      s.peakDispPx = pxDisp;
      s.peakDispNorm = upDispNorm;
      s.peakHeightCm = Math.max(s.peakHeightCm, round1(estimatedHeight));
    }

    if (!s.squatStartTs && downDispNorm > 0.02) {
      s.squatStartTs = ts;
      s.movementState = 'loading';
    }

    if (s.squatStartTs && !s.takeoffTs && upDispNorm > 0.035) {
      s.takeoffTs = ts;
      s.movementState = 'airborne';
    }

    if (s.takeoffTs && !s.landingTs && Math.abs(hipY - baseline) < 0.014 && ts - s.takeoffTs > 120) {
      s.landingTs = ts;
      s.flightMs = Math.round(s.landingTs - s.takeoffTs);
      if (s.flightMs >= 120 && s.flightMs <= 850) {
        s.peakHeightCm = Math.max(s.peakHeightCm, round1(122.625 * Math.pow(s.flightMs / 1000, 2)));
      }
      const kneeMetrics = computeRomMetrics(lm, 'knee');
      s.landingAsym = kneeMetrics.asymmetry;
      s.movementState = 'landed';
    }

    s.lastHipY = hipY;
    s.lastTs = ts;

    const result = {
      heightCm: round1(s.peakHeightCm || estimatedHeight || 0),
      flightMs: s.flightMs || 0,
      landingAsym: s.landingAsym != null ? round1(s.landingAsym) : null,
      state: s.movementState,
      baselineReady: s.baselineSamples.length >= 10
    };
    stateRefs.latestMetrics.jump = result;
    return result;
  }

  function calculateFatigueScore(){
    const daily = latestDailyLog();
    const fatigue = daily ? safeNumber(daily.fatigue) : 0;
    const soreness = daily ? safeNumber(daily.soreness) : 0;
    const painPenalty = daily ? ({'없음':0,'가벼움':8,'주의 필요':18,'진료 권장':28}[daily.painState] || 0) : 0;
    const romPenalty = stateRefs.latestMetrics.rom && stateRefs.latestMetrics.rom.asymmetry != null ? clamp(stateRefs.latestMetrics.rom.asymmetry * 2.2, 0, 24) : 0;
    const landingPenalty = stateRefs.latestMetrics.jump && stateRefs.latestMetrics.jump.landingAsym != null ? clamp(stateRefs.latestMetrics.jump.landingAsym * 1.8, 0, 20) : 0;
    const jumpPenalty = stateRefs.latestMetrics.jump && stateRefs.latestMetrics.jump.heightCm ? clamp(35 - stateRefs.latestMetrics.jump.heightCm, 0, 18) : 0;
    const score = Math.round(clamp((fatigue * 6) + (soreness * 4) + painPenalty + romPenalty + landingPenalty + jumpPenalty, 0, 100));
    const level = score >= 70 ? '높음' : score >= 40 ? '보통' : '낮음';
    const reason = [];
    if (fatigue) reason.push(`자가 피로 ${fatigue}/10`);
    if (soreness) reason.push(`근육통 ${soreness}/10`);
    if (romPenalty) reason.push(`ROM 비대칭`);
    if (landingPenalty) reason.push(`착지 비대칭`);
    stateRefs.latestMetrics.fatigue = { score, level, reason: reason.join(' · ') || '기본값' };
    return stateRefs.latestMetrics.fatigue;
  }

  function renderLiveSummary(){
    const rom = stateRefs.latestMetrics.rom;
    const jump = stateRefs.latestMetrics.jump;
    const fatigue = calculateFatigueScore();

    if (rom) {
      updateMetric('currentAngleText', `${rom.label} L ${rom.left == null ? '-' : rom.left + '°'} / R ${rom.right == null ? '-' : rom.right + '°'}`);
      const session = stateRefs.romSession || {};
      const rangeLeft = (session.leftMax != null && session.leftMin != null) ? round1(session.leftMax - session.leftMin) : null;
      const rangeRight = (session.rightMax != null && session.rightMin != null) ? round1(session.rightMax - session.rightMin) : null;
      updateMetric('romResultText', `세션 ROM L ${rangeLeft == null ? '-' : rangeLeft + '°'} / R ${rangeRight == null ? '-' : rangeRight + '°'} · 비대칭 ${rom.asymmetry == null ? '-' : rom.asymmetry + '°'}`);
    }

    if (jump) {
      updateMetric('jumpHeightText', jump.heightCm ? `${jump.heightCm} cm` : '-');
      updateMetric('jumpFlightText', jump.flightMs ? `${jump.flightMs} ms` : '-');
      updateMetric('jumpResultText', `상태 ${jump.state} · 착지 비대칭 ${jump.landingAsym == null ? '-' : jump.landingAsym + '°'}`);
    }

    updateMetric('fatigueScoreText', fatigue ? `${fatigue.score} / 100` : '-');
    updateMetric('fatigueLevelText', fatigue ? `${fatigue.level} · ${fatigue.reason}` : '-');

    const summary = [
      rom && rom.asymmetry != null ? `ROM 비대칭 ${rom.asymmetry}°` : null,
      jump && jump.heightCm ? `점프 ${jump.heightCm}cm` : null,
      fatigue ? `Fatigue ${fatigue.score}` : null
    ].filter(Boolean).join(' · ') || '분석 대기 중';
    updateMetric('analysisSummaryText', summary);

    const confidenceScore = Math.round(clamp(((stateRefs.lastLandmarks ? 1 : 0) * 35) + ((rom && rom.left != null && rom.right != null) ? 30 : 0) + ((jump && jump.baselineReady) ? 20 : 0) + 15, 0, 100));
    updateMetric('analysisConfidenceText', `${confidenceScore}%`);
  }

  function drawOverlay(results){
    const video = qs('aiCamera');
    const canvas = qs('aiCanvas');
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    const w = video.videoWidth || video.clientWidth || 640;
    const h = video.videoHeight || video.clientHeight || 360;
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.save();
    ctx.clearRect(0,0,w,h);
    if (results.poseLandmarks && window.drawConnectors && window.drawLandmarks && window.POSE_CONNECTIONS) {
      drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#7fc941', lineWidth: 4 });
      drawLandmarks(ctx, results.poseLandmarks, { color: '#58a6ff', fillColor: '#d9f99d', radius: 4 });
    }
    ctx.restore();
  }

  function onPoseResults(results){
    drawOverlay(results);
    if (!results || !results.poseLandmarks || !results.poseLandmarks.length) {
      updateMetric('poseStatus', '포즈: 미검출');
      updateMetric('cameraLiveBadge', '스켈레톤 탐색 중');
      return;
    }

    stateRefs.lastLandmarks = results.poseLandmarks;
    updateMetric('poseStatus', '포즈: 추적 중');
    updateMetric('cameraLiveBadge', '스켈레톤 표시 중');

    const joint = qs('romJoint') ? qs('romJoint').value : 'knee';
    const romMetrics = computeRomMetrics(results.poseLandmarks, joint);
    stateRefs.latestMetrics.rom = romMetrics;
    updateRomSession(romMetrics);

    const canvas = qs('aiCanvas');
    updateJumpMetrics(results.poseLandmarks, canvas ? (canvas.height || 720) : 720);
    renderLiveSummary();
  }

  async function ensurePose(){
    if (stateRefs.pose) return stateRefs.pose;
    if (!window.Pose) throw new Error('mediapipe-not-loaded');
    stateRefs.pose = new Pose({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
    });
    stateRefs.pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    stateRefs.pose.onResults(onPoseResults);
    return stateRefs.pose;
  }

  async function frameLoop(){
    if (!stateRefs.running) return;
    const video = qs('aiCamera');
    if (!video) return;

    try {
      if (video.readyState >= 2 && stateRefs.pose && video.currentTime !== stateRefs.lastVideoTime) {
        stateRefs.lastVideoTime = video.currentTime;
        await stateRefs.pose.send({ image: video });
      }
    } catch (err) {
      console.warn(err);
    }
    stateRefs.rafId = requestAnimationFrame(frameLoop);
  }

  function stopTracks(){
    if (stateRefs.stream) {
      stateRefs.stream.getTracks().forEach(track => track.stop());
      stateRefs.stream = null;
    }
  }

  function stopCamera(showToast){
    stateRefs.running = false;
    cancelAnimationFrame(stateRefs.rafId);
    stopTracks();
    const video = qs('aiCamera');
    if (video) {
      try { video.pause(); } catch (err) {}
      video.srcObject = null;
    }
    updateMetric('cameraLiveBadge', '카메라 대기');
    updateMetric('poseStatus', '포즈: 대기');
    if (showToast) toastMsg('카메라를 종료했습니다.');
  }

  async function startCamera(){
    const video = qs('aiCamera');
    if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fallbackToCapture();
      toastMsg('이 환경은 실시간 카메라를 지원하지 않아 촬영 파일 방식으로 전환합니다.');
      return;
    }

    stopCamera(false);
    resetRomSession();
    resetJumpSession();
    calculateBMI();

    try {
      await ensurePose();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: stateRefs.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      stateRefs.stream = stream;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      await video.play();
      stateRefs.running = true;
      updateMetric('cameraLiveBadge', '카메라 연결 완료');
      updateMetric('cameraModeLabel', `카메라: ${stateRefs.facingMode === 'user' ? '전면' : '후면'}`);
      frameLoop();
      toastMsg('카메라와 MediaPipe Pose 분석이 시작되었습니다.');
    } catch (err) {
      console.warn(err);
      fallbackToCapture();
      toastMsg('카메라 권한 또는 HTTPS 환경을 확인해 주세요.');
    }
  }

  async function switchCamera(){
    stateRefs.facingMode = stateRefs.facingMode === 'environment' ? 'user' : 'environment';
    localStorage.setItem(CAMERA_PREF_KEY, stateRefs.facingMode);
    updateMetric('cameraModeLabel', `카메라: ${stateRefs.facingMode === 'user' ? '전면' : '후면'}`);
    if (stateRefs.running || stateRefs.stream) await startCamera();
    else toastMsg(`${stateRefs.facingMode === 'user' ? '전면' : '후면'} 카메라로 전환 준비가 완료되었습니다.`);
  }

  function fallbackToCapture(){
    const input = qs('cameraFallback');
    if (input) input.click();
  }

  async function analyzeFallbackFile(file){
    if (!file) return;
    const video = qs('aiCamera');
    if (!video) return;
    await ensurePose();
    const url = URL.createObjectURL(file);
    video.srcObject = null;
    video.src = url;
    video.controls = true;
    await video.play().catch(()=>{});
    setTimeout(async () => {
      try {
        await stateRefs.pose.send({ image: video });
        toastMsg('촬영 파일 분석이 완료되었습니다.');
      } catch (err) {
        console.warn(err);
      }
    }, 300);
  }

  function formatCaptureSummary(){
    const bmi = calculateBMI();
    const rom = stateRefs.latestMetrics.rom;
    const jump = stateRefs.latestMetrics.jump;
    const fatigue = calculateFatigueScore();

    if (stateRefs.currentMode === 'bio') {
      if (!bmi) return null;
      return {
        type: '신체정보',
        text: `키 ${safeNumber(qs('aiHeight') && qs('aiHeight').value)}cm / 체중 ${safeNumber(qs('aiWeight') && qs('aiWeight').value)}kg / BMI ${bmi.value} (${bmi.label})`
      };
    }

    if (stateRefs.currentMode === 'rom') {
      if (!rom) return null;
      return {
        type: 'ROM',
        text: `${rom.label} 자동측정 · L ${rom.left == null ? '-' : rom.left + '°'} / R ${rom.right == null ? '-' : rom.right + '°'} / 비대칭 ${rom.asymmetry == null ? '-' : rom.asymmetry + '°'} / Fatigue ${fatigue.score}`
      };
    }

    if (stateRefs.currentMode === 'jmp') {
      if (!jump) return null;
      return {
        type: 'JMP',
        text: `점프 높이 ${jump.heightCm || 0}cm / 비행 ${jump.flightMs || 0}ms / 착지 비대칭 ${jump.landingAsym == null ? '-' : jump.landingAsym + '°'} / Fatigue ${fatigue.score}`
      };
    }

    return {
      type: 'AI',
      text: '분석 저장 완료'
    };
  }

  function captureAnalysis(){
    const summary = formatCaptureSummary();
    if (!summary) {
      toastMsg('저장할 분석 데이터가 아직 없습니다.');
      return;
    }
    persistAiLog(summary.type, summary.text);
    const detail = [
      `[${summary.type}] ${summary.text}`,
      stateRefs.latestMetrics.rom ? `ROM: ${stateRefs.latestMetrics.rom.label} / 비대칭 ${stateRefs.latestMetrics.rom.asymmetry == null ? '-' : stateRefs.latestMetrics.rom.asymmetry + '°'}` : null,
      stateRefs.latestMetrics.jump ? `JMP: ${stateRefs.latestMetrics.jump.heightCm || 0}cm / ${stateRefs.latestMetrics.jump.flightMs || 0}ms` : null,
      stateRefs.latestMetrics.fatigue ? `Fatigue Score: ${stateRefs.latestMetrics.fatigue.score} (${stateRefs.latestMetrics.fatigue.level})` : null
    ].filter(Boolean).join('\n');
    updateMetric('aiResult', detail);
    renderLiveSummary();
    toastMsg('AI 분석 결과를 저장했습니다.');
  }

  function renderAiHistory(){
    const wrap = qs('aiHistoryList');
    if (!wrap) return;
    const items = getCombinedAiHistory();
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">저장된 AI 분석 기록이 없습니다.</div>';
      return;
    }
    wrap.innerHTML = items.map(item => {
      const type = item.type || 'AI';
      const badgeClass = type === 'ROM' ? 'blue' : type === 'JMP' ? 'green' : 'red';
      return `
        <div class="record">
          <div class="row"><h4>${type}</h4><span class="pill ${badgeClass}">${item.date || '-'}</span></div>
          <div class="mini" style="margin-top:8px; line-height:1.6; color:#dce4ec;">${String(item.result || '').replace(/</g,'&lt;')}</div>
        </div>
      `;
    }).join('');
  }

  function sanitizeButton(id){
    const oldEl = qs(id);
    if (!oldEl) return null;
    const newEl = oldEl.cloneNode(true);
    oldEl.parentNode.replaceChild(newEl, oldEl);
    return newEl;
  }

  function bindEvents(){
    const startBtn = sanitizeButton('startCameraBtn');
    const switchBtn = sanitizeButton('switchCameraBtn');
    const stopBtn = sanitizeButton('stopCameraBtn');
    const captureBtn = sanitizeButton('captureBtn');
    const fileInput = qs('cameraFallback');
    const h = qs('aiHeight');
    const w = qs('aiWeight');
    const romJoint = qs('romJoint');

    if (startBtn) startBtn.addEventListener('click', startCamera);
    if (switchBtn) switchBtn.addEventListener('click', switchCamera);
    if (stopBtn) stopBtn.addEventListener('click', ()=>stopCamera(true));
    if (captureBtn) captureBtn.addEventListener('click', captureAnalysis);
    if (fileInput) fileInput.addEventListener('change', (e)=>analyzeFallbackFile((e.target.files||[])[0]));
    if (h) h.addEventListener('input', calculateBMI);
    if (w) w.addEventListener('input', calculateBMI);
    if (romJoint) romJoint.addEventListener('change', ()=>{
      resetRomSession();
      renderLiveSummary();
    });
  }

  function hydrateBodyInfo(){
    const appState = getAppState();
    const profile = appState.profile || {};
    const lastBio = getCombinedAiHistory().find(item => item.type === '신체정보');
    if (profile.height && qs('aiHeight') && !qs('aiHeight').value) qs('aiHeight').value = profile.height;
    if (profile.weight && qs('aiWeight') && !qs('aiWeight').value) qs('aiWeight').value = profile.weight;
    if (!qs('aiHeight').value && lastBio) {
      const h = String(lastBio.result).match(/키\s*(\d+(?:\.\d+)?)cm/);
      const w = String(lastBio.result).match(/체중\s*(\d+(?:\.\d+)?)kg/);
      if (h) qs('aiHeight').value = h[1];
      if (w) qs('aiWeight').value = w[1];
    }
    calculateBMI();
  }

  function init(){
    resetRomSession();
    resetJumpSession();
    bindEvents();
    hydrateBodyInfo();
    renderAiHistory();
    openMode('bio');
    renderLiveSummary();
    updateMetric('cameraModeLabel', `카메라: ${stateRefs.facingMode === 'user' ? '전면' : '후면'}`);
    updateMetric('aiEngineBadge', 'MediaPipe Pose');
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('beforeunload', ()=>stopCamera(false));
})();
