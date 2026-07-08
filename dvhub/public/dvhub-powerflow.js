/* DVhubPowerflow — vanilla JS, no deps. Exposes window.DVhubPowerflow. */
(function(){
  const PV_COL=[255,212,33], BAT_COL=[70,211,68], GRID_COL=[255,122,198];
  // Light-theme particle variants (operator request 2026-06-13) — the neon
  // hues above wash out on a light background. Keyed by reference to the
  // dark array so the stream definitions below stay untouched.
  const LIGHT_COLS = new Map([
    [PV_COL,   [168, 126, 0]],
    [BAT_COL,  [21, 128, 61]],
    [GRID_COL, [190, 24, 93]],
  ]);
  const isLightTheme = () => document.documentElement.getAttribute('data-theme') === 'light';
  const fmt = (v, dec=2) => v.toFixed(dec).replace('.', ',');
  const fmtS = v => (v >= 0 ? '+' : '') + fmt(v);

  // Plan 08-11 Task 2: powerflow center widgets render `.chart-skeleton`
  // shimmer placeholders on initial mount so the user sees a "loading" pulse
  // instead of bare "—" dashes that flash for 3 s before the first refresh
  // populates them. The skeleton is removed by `clearSkeletons()` on the
  // first `update()` call.
  // Powerflow 2.0 (operator design import 2026-06-13): the PV node carries an
  // 18-frame photo sky (moon → clouds → full sun, weighted multi-frame
  // blending driven by PV intensity) and the battery node an animated SoC
  // pill (fill level + HSL colour ramp, charge sweep, floating bolts, danger
  // blink under 18 %). Frames are real files under /assets/pf-sky/ (the
  // mockup inlined them as 1.8 MB of data-URIs — not shippable in JS).
  const SKY_FRAME_PCTS = [0, 10, 20, 30, 40, 50, 60, 65, 70, 75, 80, 85, 90, 93, 95, 97, 99, 100];
  const SKY_FRAMES_HTML = SKY_FRAME_PCTS
    .map(p => `<img class="pf-frame" data-pct="${p}" src="/assets/pf-sky/sky-${String(p).padStart(3, '0')}.webp" alt="" loading="eager" decoding="async">`)
    .join('\n        ');

  const TPL = `
    <div class="pf-stars"></div>
    <div class="pf-sunbleed"></div>
    <canvas class="pf-cv"></canvas>
    <div class="pf-hubglow"></div>
    <div class="pf-legend">
      <span class="pf-chip"><span class="d pf-chip-dot pf-chip-dot-pv"></span>PV</span>
      <span class="pf-chip"><span class="d pf-chip-dot pf-chip-dot-bat"></span>Akku</span>
      <span class="pf-chip"><span class="d pf-chip-dot pf-chip-dot-house"></span>Haus</span>
      <span class="pf-chip"><span class="d pf-chip-dot pf-chip-dot-grid"></span>Netz</span>
    </div>
    <div class="pf-node pf-nPV">
      <div class="pf-sky" aria-hidden="true">
        ${SKY_FRAMES_HTML}
      </div>
      <div class="pf-v chart-skeleton" aria-busy="true">&nbsp;</div><div class="pf-lbl">PV · DC + AC</div><div class="pf-sub chart-skeleton" aria-busy="true">&nbsp;</div>
    </div>
    <div class="pf-node pf-nBat">   <div class="pf-star"></div><div class="pf-v chart-skeleton" aria-busy="true">&nbsp;</div><div class="pf-lbl">Akku</div>      <div class="pf-sub chart-skeleton" aria-busy="true">&nbsp;</div></div>
    <div class="pf-node pf-nHouse"> <div class="pf-star"></div><div class="pf-v chart-skeleton" aria-busy="true">&nbsp;</div><div class="pf-lbl">Haus</div>      <div class="pf-mix"></div></div>
    <div class="pf-node pf-nGrid">  <div class="pf-star"></div><div class="pf-v chart-skeleton" aria-busy="true">&nbsp;</div><div class="pf-lbl">Netz</div>      <div class="pf-mix"></div></div>
    <div class="pf-center"><div class="l">Bilanz heute</div><div class="v chart-skeleton" aria-busy="true">&nbsp;</div><div class="d">€ Netto</div></div>
  `;

  function mount(target, opts={}){
    const root = (typeof target === 'string') ? document.querySelector(target) : target;
    if (!root) throw new Error('DVhubPowerflow.mount: target not found');
    if (!root.classList.contains('dvhub-powerflow')) root.classList.add('dvhub-powerflow');
    root.innerHTML = TPL;

    // Plant nameplate power — drives the sky ramp. Default 30 kW; the photo
    // sequence reaches "full sun" at 90 % of nameplate (mockup contract).
    const plantMax = (typeof opts.plantMax === 'number' && opts.plantMax > 0) ? opts.plantMax : 30;
    const pvRampMax = plantMax * 0.9;

    const cv  = root.querySelector('.pf-cv');
    const ctx = cv.getContext('2d');
    // Christin 2026-07-08: nur die Leitstand-Instanz (data-photobg) faded die
    // Partikel-Trails gegen Transparenz, damit der CSS-Foto-Hintergrund durchscheint.
    const photoBg = root.hasAttribute('data-photobg');
    let W=0, H=0, raf=0, alive=true;

    function size(){
      const r = root.getBoundingClientRect();
      W = cv.width  = Math.max(1, r.width  * devicePixelRatio);
      H = cv.height = Math.max(1, r.height * devicePixelRatio);
      cv.style.width  = r.width  + 'px';
      cv.style.height = r.height + 'px';
    }
    size();
    const ro = new ResizeObserver(size); ro.observe(root);

    const streams = [
      { id:'pv2hub',     from:[.5,.09], to:[.5,.5],  color:PV_COL  },
      { id:'bat2hub',    from:[.5,.91], to:[.5,.5],  color:BAT_COL },
      { id:'pv2bat',     from:[.5,.5],  to:[.5,.91], color:PV_COL  },
      { id:'grid2bat',   from:[.5,.5],  to:[.5,.91], color:GRID_COL},
      { id:'pv2house',   from:[.5,.5],  to:[.07,.5], color:PV_COL  },
      { id:'bat2house',  from:[.5,.5],  to:[.07,.5], color:BAT_COL },
      { id:'grid2house', from:[.5,.5],  to:[.07,.5], color:GRID_COL},
      { id:'pv2grid',    from:[.5,.5],  to:[.93,.5], color:PV_COL  },
      { id:'bat2grid',   from:[.5,.5],  to:[.93,.5], color:BAT_COL },
      { id:'grid2hub',   from:[.93,.5], to:[.5,.5],  color:GRID_COL},
    ];
    const dust = [];
    streams.forEach(s => { s.count = 0; s.speed = 0;
      for (let i = 0; i < 400; i++) dust.push({ s, p:Math.random(), life:Math.random(), phase:Math.random()*6.28, sz:Math.random()*1.4+.4, jit:(Math.random()-.5)*.05 });
    });

    const pwr2speed = kW => 0.005 + 0.05*Math.sqrt(Math.max(kW,0));
    const pwr2count = kW => Math.min(Math.round(kW*22), 320);

    const state = { pv:0, bat:0, house:0, grid:null, soc:null, costEur:null };

    function compute(){
      const pvAvail  = Math.max(state.pv, 0);
      const batOut   = Math.max(state.bat, 0);
      const batIn    = Math.max(-state.bat, 0);
      const cons     = Math.max(state.house, 0);
      let gridExp, gridImp;
      if (typeof state.grid === 'number') {
        gridImp = Math.max( state.grid, 0);
        gridExp = Math.max(-state.grid, 0);
      } else {
        const surplus = pvAvail - cons - batIn;
        gridExp = Math.max( surplus, 0);
        gridImp = Math.max(-surplus, 0);
      }
      const inPV=pvAvail, inBat=batOut, inGrid=gridImp;
      const inTot=inPV+inBat+inGrid||1;
      const fPV=inPV/inTot, fBat=inBat/inTot, fGrid=inGrid/inTot;
      return {
        pv:pvAvail, bat:state.bat, batOut, batIn, house:cons, gridExp, gridImp,
        pv2house:cons*fPV,   bat2house:cons*fBat,  grid2house:cons*fGrid,
        pv2bat:  batIn*(inPV  /(inPV+inGrid||1)),  grid2bat: batIn*(inGrid/(inPV+inGrid||1)),
        pv2grid: gridExp*(inPV /(inPV+inBat||1)),  bat2grid: gridExp*(inBat/(inPV+inBat||1)),
        net: gridExp - gridImp,
      };
    }

    function pillsHTML(parts){
      return parts.filter(p=>p.v>0.005).map(p=>`<span class="pf-pill pf-${p.k}"><span class="d"></span>${p.t} <b>${fmt(p.v)}</b></span>`).join('') ||
             '<span class="pf-pill"><span class="d"></span>Standby</span>';
    }

    function applyFlows(){
      const f = compute();
      const map = {
        pv2hub:f.pv, bat2hub:f.batOut, pv2bat:f.pv2bat, grid2bat:f.grid2bat,
        pv2house:f.pv2house, bat2house:f.bat2house, grid2house:f.grid2house,
        pv2grid:f.pv2grid, bat2grid:f.bat2grid, grid2hub:f.gridImp,
      };
      streams.forEach(s => { s.count = pwr2count(map[s.id]); s.speed = pwr2speed(map[s.id]); });

      // Plan 08-11 Task 2: skip text writes while the skeleton placeholders
      // are still showing (= no live data yet). The stream counters above
      // are still updated so the dust animation is in a sane state.
      if (!skeletonCleared) return;

      const $ = sel => root.querySelector(sel);
      $('.pf-nPV .pf-v').textContent  = fmt(f.pv) + ' kW';
      $('.pf-nPV .pf-sub').textContent= f.pv > 0 ? '100 % der Erzeugung' : 'keine Erzeugung';

      // PV sky — weighted multi-frame blending (Powerflow 2.0): every frame is
      // visible inside a ±SPAN % window (smoothstep tent), so 2–4 photos
      // overlap softly instead of a hard 2-frame cross-fade. Frame index maps
      // linearly to PV % of the ramp (0 = moon, 100 = full sun). --pv-i also
      // drives the sun-glow drop-shadow and the scene-wide sunbleed layer.
      const sky = $('.pf-nPV .pf-sky');
      if (sky) {
        const pct = Math.max(0, Math.min(f.pv / pvRampMax, 1)) * 100;
        sky.style.setProperty('--pv-i', (pct / 100).toFixed(3));
        root.style.setProperty('--pv-i', (pct / 100).toFixed(3));
        const frames = sky.querySelectorAll('.pf-frame');
        const SPAN = 18; // tent half-width in %, > max frame gap (10)
        let maxW = 0;
        const weights = [];
        for (let i = 0; i < frames.length; i++) {
          const dlt = Math.abs(pct - Number(frames[i].dataset.pct));
          let w = Math.max(0, 1 - dlt / SPAN);
          w = w * w * (3 - 2 * w);
          weights.push(w);
          if (w > maxW) maxW = w;
        }
        const norm = maxW > 0 ? 1 / maxW : 1;
        for (let i = 0; i < frames.length; i++) {
          frames[i].style.opacity = (weights[i] * norm).toFixed(3);
        }
      }

      $('.pf-nBat .pf-v').textContent = fmtS(f.bat) + ' kW';
      $('.pf-nBat .pf-sub').textContent =
        f.bat > 0 ? `entlädt mit ${fmt(f.bat)} kW`
        : f.bat < 0 ? `lädt mit ${fmt(-f.bat)} kW`
        : 'Standby';

      $('.pf-nHouse .pf-v').textContent = fmt(f.house) + ' kW';
      $('.pf-nHouse .pf-mix').innerHTML = pillsHTML([
        { k:'pv', t:'PV',   v:f.pv2house },
        { k:'bt', t:'Akku', v:f.bat2house },
        { k:'gd', t:'Netz', v:f.grid2house },
      ]);

      const isExp = f.net > 0;
      $('.pf-nGrid .pf-v').textContent   = (isExp ? '−' : '+') + fmt(Math.abs(f.net)) + ' kW';
      $('.pf-nGrid .pf-lbl').textContent = isExp ? 'Netz · Export' : f.gridImp > 0 ? 'Netz · Bezug' : 'Netz · Ruhe';
      $('.pf-nGrid .pf-mix').innerHTML = isExp
        ? pillsHTML([{ k:'pv', t:'PV', v:f.pv2grid }, { k:'bt', t:'Akku', v:f.bat2grid }])
        : pillsHTML([{ k:'gd', t:'Bezug', v:f.gridImp }]);

      // Center now shows the day's net Euro balance (positive = earning,
      // negative = spending). The grid-direction info already lives in the
      // bottom Netz node, so this slot is free for a different KPI.
      const center = $('.pf-center');
      if (center) {
        const eur = state.costEur;
        const vEl = center.querySelector('.v');
        const dEl = center.querySelector('.d');
        if (eur == null || !Number.isFinite(eur)) {
          if (vEl) vEl.textContent = '—';
          if (dEl) { dEl.textContent = '€ Netto'; dEl.style.color = 'var(--pf-dim)'; }
        } else {
          const sign = eur >= 0 ? '+' : '−';
          if (vEl) vEl.textContent = sign + Math.abs(eur).toFixed(2).replace('.', ',') + ' €';
          if (dEl) {
            dEl.textContent = eur >= 0 ? 'GEWINN HEUTE' : 'KOSTEN HEUTE';
            dEl.style.color = eur >= 0 ? 'var(--pf-bat)' : '#ff9a3c';
          }
        }
      }
    }

    function draw(){
      if (!alive) return;
      // Theme-aware trail layer: the per-frame translucent fill is what the
      // particles fade into, and it converges to an OPAQUE canvas background
      // — so this (not the CSS gradient) is the visible backdrop. Light theme
      // fades to the CSS --pf-bg (#f1f5fb) and uses normal compositing
      // (additive 'lighter' particles bleach to white on a light backdrop).
      const light = isLightTheme();
      if (photoBg) {
        // Trails gegen TRANSPARENZ erodieren (destination-out) statt gegen eine
        // opake Farbe zu konvergieren → der Foto-Hintergrund (CSS) bleibt sichtbar.
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      } else {
        ctx.fillStyle = light ? 'rgba(241,245,251,.32)' : 'rgba(3,6,16,.32)';
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
      dust.forEach(d => {
        const s = d.s;
        const rank = (d.phase * 1000) % 1;
        if (rank > Math.min(s.count / 400, 1)) return;
        const fx = s.from[0]*W, fy = s.from[1]*H, tx = s.to[0]*W, ty = s.to[1]*H;
        const dx = tx-fx, dy = ty-fy, len = Math.hypot(dx, dy) || 1;
        const nx = -dy/len, ny = dx/len;
        const jit = Math.sin(d.p*Math.PI*8 + d.life*10) * d.jit * len;
        const x = fx + dx*d.p + nx*jit, y = fy + dy*d.p + ny*jit;
        const env = Math.sin(d.p*Math.PI), a = env*.85, sz = d.sz*devicePixelRatio*(.6+env*.6);
        const c = light ? (LIGHT_COLS.get(s.color) || s.color) : s.color;
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
        ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI*2); ctx.fill();
        // Particle core: white glow on dark, darker core on light.
        ctx.fillStyle = light ? `rgba(19,35,63,${a*.3})` : `rgba(255,255,255,${a*.55})`;
        ctx.beginPath(); ctx.arc(x, y, sz*.35, 0, Math.PI*2); ctx.fill();
        d.p += s.speed * 0.018;
        if (d.p > 1) { d.p = 0; d.life = Math.random(); }
      });
      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(draw);
    }

    // Plan 08-11 Task 2: clear `.chart-skeleton` shimmer + aria-busy on the
    // first `update()` call (= first data refresh). Idempotent: subsequent
    // calls are no-ops because the class+attribute are gone.
    let skeletonCleared = false;
    function clearSkeletons() {
      if (skeletonCleared) return;
      skeletonCleared = true;
      const nodes = root.querySelectorAll('.chart-skeleton');
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].classList.remove('chart-skeleton');
        nodes[i].removeAttribute('aria-busy');
      }
    }

    const api = {
      update(s){
        if (s && typeof s === 'object') {
          if (typeof s.pv    === 'number') state.pv    = s.pv;
          if (typeof s.bat   === 'number') state.bat   = s.bat;
          if (typeof s.house === 'number') state.house = s.house;
          if (typeof s.soc   === 'number') state.soc   = s.soc;
          if ('grid' in s) state.grid = (typeof s.grid === 'number') ? s.grid : null;
          if ('costEur' in s) state.costEur = (typeof s.costEur === 'number') ? s.costEur : null;
        }
        clearSkeletons();
        applyFlows();
      },
      destroy(){
        alive = false;
        cancelAnimationFrame(raf);
        ro.disconnect();
        root.innerHTML = '';
      },
      root,
    };

    applyFlows();
    draw();
    return api;
  }

  window.DVhubPowerflow = { mount };
})();
