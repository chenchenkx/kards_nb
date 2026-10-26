/* ============================================================
 * KARDS Web — 音效系统 (SFX)
 *
 * 双通道设计：
 *   1) WebAudio 实时合成（默认，零资源、离线可用、零延迟）
 *   2) 文件覆盖：把同名音频放到  public/sfx/<name>.mp3|ogg|wav
 *      即自动优先使用文件（首次播放时探测一次）
 *
 * 可用音效名：
 *   deploy   出牌落地（重拍桌）
 *   draw     抽牌
 *   select   选中/拿起卡牌
 *   whoosh   攻击冲锋破空
 *   hit      命中单位
 *   hqhit    轰击总部（大爆炸）
 *   death    单位阵亡
 *   turn     回合切换
 *   error    操作无效
 * ============================================================ */
(function () {
  'use strict';

  const SFX = {};
  let ctx = null;                 // AudioContext（懒创建）
  const fileState = {};           // name -> 'ok' | 'no' | undefined(未探测)
  const fileUrls = {};            // name -> url
  const EXT_PROXY = ['mp3', 'ogg', 'wav'];

  function ac() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  // 首次用户手势解锁音频（浏览器自动播放策略）
  function unlock() { ac(); }
  window.addEventListener('pointerdown', unlock, { once: false, passive: true });
  window.addEventListener('keydown', unlock, { once: false });

  // ---------------- 文件覆盖探测 ----------------
  function probeFile(name) {
    if (fileState[name]) return Promise.resolve(fileState[name] === 'ok');
    return new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i >= EXT_PROXY.length) { fileState[name] = 'no'; resolve(false); return; }
        const url = '/sfx/' + name + '.' + EXT_PROXY[i++];
        fetch(url, { method: 'HEAD' })
          .then(r => {
            if (r.ok) { fileState[name] = 'ok'; fileUrls[name] = url; resolve(true); }
            else tryNext();
          })
          .catch(tryNext);
      };
      tryNext();
    });
  }

  function playFile(name) {
    try {
      const a = new Audio(fileUrls[name]);
      a.volume = 0.9;
      a.play().catch(() => synth(name));
      return true;
    } catch (e) { return false; }
  }

  // ---------------- 合成器 ----------------
  function noiseBuffer(c, seconds) {
    const len = Math.max(1, (c.sampleRate * seconds) | 0);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 噪声爆发：strike = 打击感主体 */
  function burst(c, out, t0, dur, freq, q, gainV, sweepTo) {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, dur + 0.05);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(30, sweepTo), t0 + dur);
    f.Q.value = q || 1;
    const g = c.createGain();
    g.gain.setValueAtTime(gainV, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  /** 低音鼓/重物落体：f0 → f1 指数下滑 */
  function boom(c, out, t0, f0, f1, dur, gainV) {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gainV, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(out);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function tone(c, out, t0, freq, dur, gainV, type) {
    const o = c.createOscillator();
    o.type = type || 'triangle';
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gainV, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(out);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  const SYNTH = {
    /** 出牌：重物拍桌 = 高频拍击 + 低频下坠 */
    deploy(c, out, t0) {
      burst(c, out, t0, 0.06, 2400, 0.8, 0.5);           // 拍击瞬态
      burst(c, out, t0 + 0.005, 0.12, 500, 1.2, 0.35);   // 桌面共鸣
      boom(c, out, t0, 130, 42, 0.22, 0.65);             // 重量下坠
    },
    /** 抽牌：短促纸牌摩擦 */
    draw(c, out, t0) {
      burst(c, out, t0, 0.09, 3200, 2.5, 0.16, 1400);
    },
    /** 选中：轻点 */
    select(c, out, t0) {
      tone(c, out, t0, 880, 0.05, 0.10, 'sine');
    },
    /** 冲锋：破空声，噪声上扫 */
    whoosh(c, out, t0) {
      burst(c, out, t0, 0.22, 350, 1.1, 0.30, 2600);
    },
    /** 命中：金属撞击 + 低频冲击 */
    hit(c, out, t0) {
      burst(c, out, t0, 0.05, 3000, 0.7, 0.55);
      burst(c, out, t0 + 0.01, 0.18, 700, 1.0, 0.42, 180);
      boom(c, out, t0, 105, 38, 0.28, 0.6);
    },
    /** 总部轰击：更大更沉 */
    hqhit(c, out, t0) {
      burst(c, out, t0, 0.08, 2200, 0.6, 0.6);
      burst(c, out, t0 + 0.01, 0.4, 420, 1.0, 0.5, 90);
      boom(c, out, t0, 80, 26, 0.55, 0.8);
      boom(c, out, t0 + 0.06, 55, 22, 0.5, 0.45);
    },
    /** 阵亡：爆裂坍塌 */
    death(c, out, t0) {
      burst(c, out, t0, 0.35, 1600, 0.9, 0.4, 120);
      boom(c, out, t0, 90, 30, 0.4, 0.5);
    },
    /** 回合：号角双音 */
    turn(c, out, t0) {
      tone(c, out, t0, 392, 0.16, 0.12, 'sawtooth');
      tone(c, out, t0 + 0.12, 523, 0.22, 0.12, 'sawtooth');
    },
    /** 无效：低沉嗡 */
    error(c, out, t0) {
      tone(c, out, t0, 130, 0.16, 0.14, 'square');
      tone(c, out, t0 + 0.08, 98, 0.18, 0.12, 'square');
    },
    /** 胜利：金色上行和弦 + 余韵 */
    victory(c, out, t0) {
      [392, 523.25, 659.25, 783.99].forEach((f, i) => tone(c, out, t0 + i * 0.09, f, 0.32, 0.11, 'triangle'));
      boom(c, out, t0, 120, 40, 0.5, 0.35);
    },
  };

  function synth(name) {
    const c = ac();
    if (!c || !SYNTH[name]) return;
    const t0 = c.currentTime + 0.001;
    const out = c.createGain();
    out.gain.value = 0.85;
    out.connect(c.destination);
    try { SYNTH[name](c, out, t0); } catch (e) { /* 忽略合成异常 */ }
  }

  // ---------------- 对外接口 ----------------
  /** 播放音效；若 public/sfx/<name>.* 存在则优先文件 */
  SFX.play = function (name) {
    if (!SYNTH[name] && !fileState[name]) return;
    if (fileState[name] === 'ok') { playFile(name); return; }
    if (fileState[name] === 'no') { synth(name); return; }
    // 未探测：先合成保底（零延迟），同时探测，之后走文件
    synth(name);
    probeFile(name).then((ok) => { if (ok) fileState[name] = 'ok'; });
  };

  /** 预热：解锁音频 + 探测全部覆盖文件 */
  SFX.warmup = function () {
    unlock();
    Object.keys(SYNTH).forEach(probeFile);
  };
  window.addEventListener('pointerdown', () => SFX.warmup(), { once: true, passive: true });

  window.SFX = SFX;
})();
