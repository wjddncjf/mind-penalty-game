'use strict';

(() => {
  const STORAGE_KEY = 'mind-penalty-v2';
  const LEGACY_KEY = 'mind-penalty-v1';
  const DIRECTIONS = ['왼쪽', '중앙', '오른쪽'];
  const MAX_KICKS = 5;
  const WIN_GOALS = 3;
  const MAX_RECORDS = 100;
  const el = (id) => document.getElementById(id);

  // Names deliberately don't explain any goalkeeper's behavior.
  const KEEPERS = [
    { id: 'nocturne', number: '07', name: 'T.쿠르투아', color: '#c9eb75', quote: '“경기장에는 작은 흔적들이 남기 마련이지.”',
      pre: '그는 잠시 공이 놓였던 자리를 쳐다봅니다.', rule: '직전 슈팅 방향을 다시 경계합니다.', first: 1 },
    { id: 'aurora', number: '18', name: '알리송', color: '#94b5ff', quote: '“눈에 보이는 것이 전부일까?”',
      pre: '그는 골대의 세 구역을 차례로 훑어봅니다.', rule: '직전 슈팅 방향의 한 칸 오른쪽으로 움직입니다.', first: 2 },
    { id: 'veil', number: '26', name: 'M.노이어', color: '#f6b67c', quote: '“답은 네 선택 안에 있을 수도 있지.”',
      pre: '그는 전광판의 지난 기록을 한 번 확인합니다.', rule: '지금까지 가장 자주 찬 방향을 경계합니다.', first: 0 }
  ];
  const KEEPER_BY_ID = Object.fromEntries(KEEPERS.map(k => [k.id, k]));

  const defaultStore = () => ({
    version: 2,
    stats: { gamesPlayed: 0, wins: 0, bestScore: 0 },
    settings: { reduceMotion: false, hintRound: 3 },
    records: []
  });
  const boundedInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const safeRecord = (record) => record && typeof record === 'object' &&
    boundedInteger(record.number, 1, 1000000) &&
    boundedInteger(record.hintRound, 2, 4) &&
    boundedInteger(record.goals, 0, 5) &&
    boundedInteger(record.saves, 0, 5) && record.goals + record.saves === MAX_KICKS &&
    boundedInteger(record.seconds, 0, 1000000) && typeof record.won === 'boolean' &&
    record.won === (record.goals >= WIN_GOALS) &&
    typeof record.date === 'string' && record.date.length <= 40 &&
    typeof record.cause === 'string' && record.cause.length <= 400 &&
    (record.keeperOrder === undefined || (typeof record.keeperOrder === 'string' && record.keeperOrder.length <= 100));

  function validStore(value, version) {
    return value && value.version === version && value.stats && value.settings && Array.isArray(value.records) &&
      boundedInteger(value.stats.gamesPlayed, 0, 1000000) &&
      boundedInteger(value.stats.wins, 0, value.stats.gamesPlayed) &&
      boundedInteger(value.stats.bestScore, 0, 5) &&
      typeof value.settings.reduceMotion === 'boolean' &&
      boundedInteger(value.settings.hintRound, 2, 4) &&
      value.records.length <= MAX_RECORDS && value.records.every(safeRecord);
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (!validStore(parsed, 2)) throw new Error('Invalid v2 saved data');
        return { data: parsed, message: '기존 기록을 정상적으로 불러왔습니다.' };
      }
      // Keep the user's old v1 results if they played the first edition.
      const oldRaw = localStorage.getItem(LEGACY_KEY);
      if (oldRaw !== null) {
        const old = JSON.parse(oldRaw);
        if (!validStore(old, 1)) throw new Error('Invalid legacy saved data');
        return { data: { ...old, version: 2 }, message: '이전 버전의 경기 기록을 이어받았습니다.' };
      }
      return { data: defaultStore(), message: '저장된 기록이 없어 기본값으로 시작합니다.' };
    } catch (_error) {
      return { data: defaultStore(), message: '저장값이 손상되어 안전한 기본값으로 복구했습니다.' };
    }
  }

  const loaded = loadStore();
  let store = loaded.data;
  let activeHintRound = store.settings.hintRound;
  let game = initialGame();

  function initialGame() {
    return {
      phase: 'ready', paused: false, autoPaused: false,
      round: 1, aim: 1, aimMoves: 0, goals: 0,
      shots: [], lastShot: null, keeperOrder: [], finishOverlayPending: false,
      timingPosition: 0, timingStartedAt: 0, timingElapsed: 0,
      elapsedMs: 0, lastTick: performance.now()
    };
  }

  // Every match uses a freshly shuffled opponent sequence. The first three
  // kicks introduce all three keepers in unpredictable order; the remaining
  // two are also drawn randomly. Nobody may appear twice in a row.
  function shuffled(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function drawKeeperOrder() {
    const order = shuffled(KEEPERS.map(k => k.id));
    while (order.length < MAX_KICKS) {
      const options = KEEPERS.map(k => k.id).filter(id => id !== order[order.length - 1]);
      order.push(options[Math.floor(Math.random() * options.length)]);
    }
    return order;
  }
  function currentKeeper() {
    return KEEPER_BY_ID[game.keeperOrder[Math.min(game.round - 1, MAX_KICKS - 1)]] || null;
  }
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return true;
    } catch (_error) {
      el('storage-status').textContent = '이 브라우저에서는 저장이 제한됩니다. 게임은 계속할 수 있지만 재접속 후 기록이 유지되지 않을 수 있습니다.';
      return false;
    }
  }
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function updateClock() { el('game-clock').textContent = formatTime(game.elapsedMs / 1000); }
  function tick() {
    const now = performance.now();
    const diff = Math.min(1000, Math.max(0, now - game.lastTick));
    game.lastTick = now;
    if (!game.paused && (game.phase === 'aim' || game.phase === 'timing' || game.phase === 'result')) {
      game.elapsedMs += diff;
      updateClock();
    }
  }

  function beginGame() {
    game = initialGame();
    game.keeperOrder = drawKeeperOrder();
    game.phase = 'aim';
    activeHintRound = store.settings.hintRound;
    game.lastTick = performance.now();
    el('goal-effect').classList.remove('active');
    render();
  }
  function changeAim(direction) {
    if (game.phase !== 'aim' || game.paused) return;
    game.aim = direction;
    game.aimMoves++;
    render();
  }
  function nudgeAim(delta) {
    if (game.phase !== 'aim' || game.paused) return;
    changeAim((game.aim + delta + 3) % 3);
  }

  function keeperDirection(keeper) {
    const previous = game.shots.at(-1);
    if (!previous) return keeper.first;
    if (keeper.id === 'nocturne') return previous.aim;
    if (keeper.id === 'aurora') return (previous.aim + 1) % 3;
    // In a tie this keeper looks at the most recent of those directions.
    const counts = [0, 0, 0];
    game.shots.forEach(s => counts[s.aim]++);
    const max = Math.max(...counts);
    if (counts[previous.aim] === max) return previous.aim;
    return counts.indexOf(max);
  }
  function playGoalEffect() {
    const effect = el('goal-effect');
    effect.classList.remove('active');
    if (store.settings.reduceMotion) return;
    void effect.offsetWidth;
    effect.classList.add('active');
  }
  // 1400 ms for a full left-to-right-to-left cycle. A MISS always goes wide,
  // but GOOD/PERFECT still face the original deterministic keeper logic.
  const TIMING_CYCLE_MS = 1400;
  function timingAt(elapsed) {
    const fraction = (elapsed % TIMING_CYCLE_MS) / TIMING_CYCLE_MS;
    return fraction <= 0.5 ? fraction * 2 : (1 - fraction) * 2;
  }
  function startTiming() {
    if (game.phase !== 'aim' || game.paused) return;
    game.phase = 'timing';
    game.timingElapsed = 0;
    game.timingStartedAt = performance.now();
    game.timingPosition = 0;
    render();
    requestAnimationFrame(timingFrame);
  }
  function timingFrame(now) {
    if (game.phase !== 'timing') return;
    if (!game.paused) {
      game.timingPosition = timingAt(game.timingElapsed + now - game.timingStartedAt);
      el('timing-needle').style.left = `${game.timingPosition * 100}%`;
    }
    requestAnimationFrame(timingFrame);
  }
  function shoot() {
    if (game.phase !== 'timing' || game.paused) return;
    game.timingPosition = timingAt(game.timingElapsed + performance.now() - game.timingStartedAt);
    const error = Math.abs(game.timingPosition - 0.5);
    const timing = error <= 0.08 ? 'PERFECT' : error <= 0.23 ? 'GOOD' : 'MISS';
    const opponent = currentKeeper();
    const keeper = keeperDirection(opponent);
    const missed = timing === 'MISS';
    const goal = !missed && keeper !== game.aim;
    const shot = { number: game.round, aim: game.aim, keeper, keeperId: opponent.id, goal, missed, timing };
    game.shots.push(shot);
    game.lastShot = shot;
    if (goal) game.goals++;
    game.phase = game.round === MAX_KICKS ? 'finished' : 'result';
    if (game.phase === 'finished') {
      game.finishOverlayPending = true;
      finishGame();
    }
    render();
    if (goal) playGoalEffect();
    if (game.phase === 'finished') {
      setTimeout(() => {
        if (game.phase === 'finished' && game.lastShot === shot) {
          game.finishOverlayPending = false;
          renderField();
        }
      }, 900);
    }
  }
  function finishGame() {
    const won = game.goals >= WIN_GOALS;
    store.stats.gamesPlayed++;
    if (won) store.stats.wins++;
    store.stats.bestScore = Math.max(store.stats.bestScore, game.goals);
    store.records.push({
      number: store.stats.gamesPlayed,
      date: new Date().toISOString(), hintRound: activeHintRound,
      keeperOrder: game.keeperOrder.map(id => KEEPER_BY_ID[id].name).join('·'),
      goals: game.goals, saves: MAX_KICKS - game.goals,
      seconds: Math.floor(game.elapsedMs / 1000),
      cause: game.shots.filter(s => !s.goal).map(s => `${s.number}차 ${KEEPER_BY_ID[s.keeperId].name}: ${s.missed ? '타이밍 MISS (실축)' : DIRECTIONS[s.keeper] + ' 선방'}`).join(' / ') || '실패 없음',
      won
    });
    if (store.records.length > MAX_RECORDS) store.records = store.records.slice(-MAX_RECORDS);
    persist();
  }
  function nextKick() {
    if (game.phase !== 'result' || game.paused) return;
    game.round++;
    game.phase = 'aim';
    game.timingElapsed = 0;
    game.timingPosition = 0;
    game.lastShot = null;
    el('goal-effect').classList.remove('active');
    render();
  }
  function togglePause(auto = false) {
    if (game.phase !== 'aim' && game.phase !== 'timing' && game.phase !== 'result') return;
    if (auto && game.paused) return;
    if (game.phase === 'timing') {
      if (!game.paused) game.timingElapsed += performance.now() - game.timingStartedAt;
      else if (!auto) game.timingStartedAt = performance.now();
    }
    game.paused = auto ? true : !game.paused;
    game.autoPaused = auto && game.paused;
    game.lastTick = performance.now();
    render();
  }

  function clueProgress() {
    if (game.phase === 'ready') return 0;
    if (game.phase === 'finished' || game.round >= activeHintRound) return 3;
    return Math.min(game.round - 1, 2);
  }
  function clueText() {
    if (game.phase === 'ready') return '각 골키퍼에게는 이름만으로 알 수 없는 움직임 규칙이 있습니다.';
    const opponent = currentKeeper();
    if (game.phase === 'finished') return '경기 종료! T.쿠르투아는 직전 방향, 알리송은 한 칸 옆, M.노이어는 자주 선택한 방향을 경계합니다. 다음 경기에서 이 기록을 활용해 보세요.';
    if (game.phase === 'result' && game.lastShot) {
      return `${opponent.name}의 실제 다이빙은 ${DIRECTIONS[game.lastShot.keeper]}! 지금까지 기록과 비교해 보세요.`;
    }
    const prior = game.shots.filter(shot => shot.keeperId === opponent.id);
    if (game.round >= activeHintRound) return `전술 기록 해독 · ${opponent.name}: ${opponent.rule}`;
    if (prior.length) {
      const last = prior.at(-1);
      return `이전 대결: ${opponent.name}은 ${DIRECTIONS[last.keeper]}으로 몸을 날렸습니다. ${opponent.pre}`;
    }
    return `${opponent.name}의 첫 등장. ${opponent.pre}`;
  }

  function renderField() {
    const overlay = el('pitch-overlay');
    const eyebrow = el('overlay-eyebrow');
    const title = el('overlay-title');
    const copy = el('overlay-copy');
    const keeper = el('keeper');
    const ball = el('ball');
    const opponent = currentKeeper();
    const hasResult = game.lastShot !== null;
    const finished = game.phase === 'finished';
    const winning = game.goals >= WIN_GOALS;

    keeper.className = hasResult ? `keeper dive-${game.lastShot.keeper}` : 'keeper';
    keeper.style.setProperty('--keeper-shirt', opponent?.color || '#c9eb75');
    ball.style.left = hasResult ? `${50 + (game.lastShot.aim - 1) * 26}%` : `${50 + (game.aim - 1) * 18}%`;
    ball.classList.toggle('kicked', hasResult);
    ball.classList.toggle('wide', hasResult && game.lastShot.missed);
    el('pitch').classList.toggle('is-paused', game.paused);
    el('pitch-keeper-name').textContent = opponent ? `${opponent.number} ${opponent.name}` : '???';
    overlay.hidden = game.phase !== 'ready' && !game.paused && !(finished && !game.finishOverlayPending);

    if (game.phase === 'ready') {
      eyebrow.textContent = 'YOUR MATCH';
      title.textContent = '상대가 누구인지, 아직 알 수 없습니다.';
      copy.textContent = '시작 버튼을 누르면 세 골키퍼가 매 슈팅마다 무작위 순서로 등장합니다.';
    } else if (game.paused) {
      eyebrow.textContent = 'PAUSE';
      title.textContent = game.autoPaused ? '다른 창으로 이동해 경기를 멈췄어요.' : '경기가 일시정지되었습니다.';
      copy.textContent = '경기 시간이 멈췄습니다. 재개 버튼을 누르면 같은 상태에서 이어집니다.';
    } else if (finished) {
      eyebrow.textContent = winning ? 'MATCH WON' : 'MATCH LOST';
      title.textContent = winning ? '승리! 골키퍼의 마음을 읽어냈어요.' : '패배! 다음엔 단서들을 연결해 보세요.';
      copy.textContent = `최종 ${game.goals}골 · ${MAX_KICKS - game.goals}실패. 다시 시작하면 골키퍼 순서가 새로 섞이고 이번 판 점수는 초기화됩니다.`;
    }
  }
  function renderHistory() {
    const history = el('kick-history');
    history.replaceChildren();
    if (!game.shots.length) {
      const placeholder = document.createElement('span');
      placeholder.className = 'history-placeholder';
      placeholder.textContent = '첫 번째 슈팅을 기다리는 중...';
      history.append(placeholder);
      return;
    }
    game.shots.forEach(shot => {
      const chip = document.createElement('span');
      chip.className = `kick-chip ${shot.goal ? 'goal' : 'save'}`;
      chip.textContent = `${shot.number}차 ${KEEPER_BY_ID[shot.keeperId].name} · ${DIRECTIONS[shot.aim]} 슛 / ${DIRECTIONS[shot.keeper]} 다이빙 · ${shot.goal ? 'GOAL' : shot.missed ? 'WIDE' : 'SAVE'} · ${shot.timing || '기존 슛'}`;
      history.append(chip);
    });
  }
  function renderOpponent() {
    const keeper = currentKeeper();
    el('opponent-name').textContent = keeper?.name || '아직 미정';
    el('opponent-number').textContent = keeper?.number || '--';
    el('opponent-label').textContent = keeper ? `GOALKEEPER NO.${keeper.number}` : '이번 슈팅의 상대';
    el('opponent-quote').textContent = keeper?.quote || '시작하면 골키퍼가 무작위로 정해집니다.';
    el('opponent-avatar').style.setProperty('--keeper-shirt', keeper?.color || '#c9eb75');
    const roster = el('roster-avatars');
    roster.replaceChildren();
    KEEPERS.forEach(candidate => {
      const observed = game.shots.some(shot => shot.keeperId === candidate.id) || keeper?.id === candidate.id;
      const badge = document.createElement('span');
      badge.className = 'roster-avatar' + (keeper?.id === candidate.id ? ' current' : '') + (!observed ? ' unseen' : '');
      badge.style.setProperty('--badge-color', candidate.color);
      badge.textContent = observed ? candidate.name : '?';
      badge.title = observed ? `${candidate.name} · ${candidate.number}` : '아직 등장하지 않음';
      roster.append(badge);
    });
  }
  function renderRecords() {
    el('total-games').textContent = String(store.stats.gamesPlayed);
    el('total-wins').textContent = String(store.stats.wins);
    el('best-score').textContent = `${store.stats.bestScore} / 5`;
    const body = el('records-body');
    body.replaceChildren();
    if (!store.records.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'empty-records';
      td.textContent = '완료한 경기가 없습니다. 첫 판을 시작해 보세요!';
      tr.append(td);
      body.append(tr);
      return;
    }
    [...store.records].reverse().forEach(record => {
      const tr = document.createElement('tr');
      const values = [record.number, `${record.hintRound}번째 슛`, record.keeperOrder || '(이전 버전)', record.goals, record.saves, formatTime(record.seconds), record.cause, record.won ? '승리' : '패배'];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        td.textContent = String(value);
        if (index === 7) td.className = record.won ? 'result-win' : 'result-loss';
        tr.append(td);
      });
      body.append(tr);
    });
  }

  // Current-match analysis uses only the five actual shot events.
  // Older archived v2/v3 summaries are intentionally left untouched.
  function renderMatchReport() {
    const report = el('match-report');
    const finished = game.phase === 'finished';
    report.hidden = !finished;
    if (!finished) return;
    const shots = game.shots;
    const perfect = shots.filter(s => s.timing === 'PERFECT').length;
    const good = shots.filter(s => s.timing === 'GOOD').length;
    const miss = shots.filter(s => s.timing === 'MISS').length;
    const saves = shots.filter(s => !s.goal && !s.missed).length;
    el('report-outcome').textContent = game.goals >= WIN_GOALS ? 'VICTORY' : 'DEFEAT';
    el('report-outcome').className = game.goals >= WIN_GOALS ? 'report-outcome won' : 'report-outcome lost';
    el('report-score').textContent = `${game.goals} / ${MAX_KICKS}`;
    el('report-subtitle').textContent = `5번의 슈팅 · ${game.goals}골 · 선방 ${saves}회 · 실축 ${miss}회 · ${formatTime(game.elapsedMs / 1000)}`;
    el('report-rate').textContent = `${Math.round(game.goals / MAX_KICKS * 100)}%`;
    el('report-perfect').textContent = String(perfect);
    el('report-saves').textContent = String(saves);
    el('report-timing').textContent = `PERFECT ${perfect} · GOOD ${good} · MISS ${miss}`;
    const list = el('report-rounds');
    list.replaceChildren();
    shots.forEach(s => {
      const item = document.createElement('li');
      item.className = 'report-round';
      const number = document.createElement('span'); number.className = 'report-round-number'; number.textContent = `${s.number}R`;
      const detail = document.createElement('span'); detail.className = 'report-round-detail';
      const keeper = document.createElement('strong'); keeper.textContent = KEEPER_BY_ID[s.keeperId].name;
      const sub = document.createElement('small'); sub.textContent = `${DIRECTIONS[s.aim]} 슛 · ${s.timing} · 골키퍼 ${DIRECTIONS[s.keeper]}`;
      detail.append(keeper, sub);
      const outcome = document.createElement('strong');
      outcome.className = `report-round-result ${s.goal ? 'goal' : s.missed ? 'out' : 'save'}`;
      outcome.textContent = s.goal ? 'GOAL' : s.missed ? 'OUT' : 'SAVE';
      item.append(number, detail, outcome);
      list.append(item);
    });
    let analysis;
    if (miss > 0 && saves > 0) analysis = `타이밍 실축 ${miss}회와 골키퍼 선방 ${saves}회가 있었어요. 타이밍 조절과 상대 방향 예측을 각각 연습해 보세요.`;
    else if (miss > 0) analysis = `타이밍을 놓친 슈팅이 ${miss}회 있었어요. 중앙 구역을 노려 보세요.`;
    else if (saves > 0) analysis = `실축은 없었지만 골키퍼에게 ${saves}회 막혔어요. 상대의 이전 움직임과 단서를 비교해 보세요.`;
    else analysis = '다섯 번 모두 득점했어요. 이번 경기에서는 실축이나 선방이 없었어요.';
    el('report-analysis').textContent = analysis;
  }

  function render() {
    const inMatch = game.phase === 'aim' || game.phase === 'timing' || game.phase === 'result';
    const canAim = game.phase === 'aim' && !game.paused;
    const phaseText = game.paused ? '일시정지' : ({ ready: '대기 중', aim: '조준 중', timing: '타이밍 조절', result: '킥 결과', finished: game.goals >= WIN_GOALS ? '승리' : '패배' })[game.phase];
    el('status-badge').textContent = phaseText;
    el('round-number').innerHTML = `${game.phase === 'ready' ? 0 : game.round} <span class="stat-suffix">/ 5</span>`;
    el('goal-count').textContent = String(game.goals);
    el('save-count').textContent = String(game.shots.length - game.goals);
    el('field-round-label').textContent = game.phase === 'ready' ? '킥오프 준비' : game.phase === 'finished' ? '경기 종료' : `KICK ${game.round} / ${MAX_KICKS}`;
    el('current-aim').textContent = DIRECTIONS[game.aim];
    el('aim-move-count').textContent = String(game.aimMoves);
    el('clue-text').textContent = clueText();
    el('clue-progress').textContent = `${clueProgress()} / 3`;
    const last = game.shots.at(-1);
    el('last-dive').textContent = last ? `${KEEPER_BY_ID[last.keeperId].name} · ${DIRECTIONS[last.keeper]}` : '아직 없음';
    el('reduce-motion').checked = store.settings.reduceMotion;
    el('hint-round').value = String(store.settings.hintRound);
    el('hint-round').disabled = inMatch;
    document.documentElement.classList.toggle('reduce-motion', store.settings.reduceMotion);
    document.querySelectorAll('[data-aim]').forEach(button => {
      button.disabled = !canAim;
      button.setAttribute('aria-pressed', String(game.aim === Number(button.dataset.aim)));
    });

    const timingPanel = el('timing-panel');
    timingPanel.hidden = game.phase !== 'timing' && game.phase !== 'result' && game.phase !== 'finished';
    el('timing-needle').style.left = `${game.timingPosition * 100}%`;
    el('timing-readout').textContent = game.phase === 'timing' ? (game.paused ? 'PAUSED' : '움직이는 바늘을 중앙에 멈추세요') : (last?.timing || '—');
    const primary = el('primary-action');
    const pause = el('pause-action');
    const hint = el('action-hint');
    pause.disabled = !inMatch;
    pause.textContent = game.paused ? '▶ 재개' : 'Ⅱ 일시정지';
    if (game.phase === 'ready') {
      primary.textContent = '▶  게임 시작'; primary.disabled = false;
      hint.textContent = '시작 → 관찰 → 슈팅 → 결과 → 재시작';
      el('commentary').textContent = '매 슈팅마다 세 명 중 무작위로 골키퍼가 등장합니다. 행동을 기록해 패턴을 추리하세요.';
    } else if (game.phase === 'aim') {
      primary.textContent = '▶  타이밍 시작 · SPACE'; primary.disabled = game.paused;
      hint.textContent = '← / → 조준 · 1/2/3 방향 선택';
      el('commentary').textContent = `${game.round}차 상대는 ${currentKeeper().name}! 움직임을 예상하고 슛을 선택하세요.`;
    } else if (game.phase === 'timing') {
      primary.textContent = '⚽  지금 슈팅! · SPACE'; primary.disabled = game.paused;
      hint.textContent = '중앙 녹색 구역에서 정확하게 멈추기 · P 일시정지';
      el('commentary').textContent = '타이밍을 맞혀도 골키퍼가 같은 방향을 막으면 선방됩니다.';
    } else if (game.phase === 'result') {
      primary.textContent = '→  다음 킥 · ENTER'; primary.disabled = game.paused;
      hint.textContent = '다이빙 모션과 결과를 보고 다음 킥으로';
      el('commentary').textContent = last.missed ? 'WIDE! 타이밍을 놓쳐 골대 밖으로 나갔어요.' : last.goal
        ? `GOAL! ${KEEPER_BY_ID[last.keeperId].name}은 ${DIRECTIONS[last.keeper]}으로 다이빙했어요.`
        : `SAVE! ${KEEPER_BY_ID[last.keeperId].name}이 ${DIRECTIONS[last.keeper]}으로 몸을 던져 막았습니다.`;
    } else {
      primary.textContent = '↻  다시 시작'; primary.disabled = false;
      hint.textContent = '재시작 시 골키퍼 출전 순서를 새로 뽑습니다.';
      el('commentary').textContent = `5번의 슈팅 완료 · ${game.goals}골 ${MAX_KICKS - game.goals}선방 · ${game.goals >= WIN_GOALS ? '승리' : '패배'}.`;
    }
    renderField();
    renderOpponent();
    renderHistory();
    renderRecords();
    renderMatchReport();
    updateClock();
  }
  function primaryAction() {
    if (game.paused) return;
    if (game.phase === 'ready' || game.phase === 'finished') beginGame();
    else if (game.phase === 'aim') startTiming();
    else if (game.phase === 'timing') shoot();
    else if (game.phase === 'result') nextKick();
  }

  // Handlers are only registered once, even after hundreds of restarts.
  el('primary-action').addEventListener('click', primaryAction);
  el('report-restart').addEventListener('click', beginGame);
  el('pause-action').addEventListener('click', () => togglePause());
  document.querySelectorAll('[data-aim]').forEach(button => {
    button.addEventListener('click', () => changeAim(Number(button.dataset.aim)));
  });
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches('select, input, textarea') || target.isContentEditable)) return;
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      if (game.phase === 'aim' && !game.paused) {
        event.preventDefault(); nudgeAim(event.code === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }
    if (event.code === 'Digit1' || event.code === 'Digit2' || event.code === 'Digit3') {
      if (game.phase === 'aim' && !game.paused) {
        event.preventDefault(); changeAim(Number(event.code.slice(-1)) - 1);
      }
      return;
    }
    if (event.code === 'KeyP' && !event.repeat) {
      if (game.phase === 'aim' || game.phase === 'timing' || game.phase === 'result') { event.preventDefault(); togglePause(); }
      return;
    }
    if (event.code === 'Space' && !event.repeat) {
      if ((game.phase === 'aim' || game.phase === 'timing') && !game.paused) { event.preventDefault(); primaryAction(); }
      return;
    }
    if (event.code === 'Enter' && game.phase === 'result' && !game.paused) {
      event.preventDefault(); nextKick();
    }
  });
  window.addEventListener('blur', () => togglePause(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

  el('reduce-motion').addEventListener('change', (event) => {
    store.settings.reduceMotion = event.target.checked;
    if (store.settings.reduceMotion) el('goal-effect').classList.remove('active');
    persist(); render();
  });
  el('hint-round').addEventListener('change', (event) => {
    if (game.phase === 'aim' || game.phase === 'timing' || game.phase === 'result') return;
    store.settings.hintRound = Number(event.target.value);
    persist(); render();
  });
  el('clear-records').addEventListener('click', () => {
    if (!window.confirm('저장된 플레이 기록과 설정을 초기화할까요? 현재 진행 중인 판도 처음 상태로 돌아갑니다.')) return;
    store = defaultStore(); game = initialGame(); activeHintRound = store.settings.hintRound;
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY); } catch (_error) { /* optional storage */ }
    el('goal-effect').classList.remove('active');
    el('storage-status').textContent = '저장 기록과 설정을 초기화했습니다. 기본값으로 시작합니다.';
    render();
  });
  el('export-records').addEventListener('click', () => {
    if (!store.records.length) {
      el('storage-status').textContent = '내보낼 경기 기록이 없습니다. 먼저 한 판을 완료하세요.';
      return;
    }
    const headers = ['경기번호','기록시각(UTC)','단서공개라운드','골키퍼순서','득점','미득점(선방+실축)','시간(초)','실패원인','결과'];
    const rows = store.records.map(r => [r.number, r.date, r.hintRound, r.keeperOrder || '(이전 버전)', r.goals, r.saves, r.seconds, r.cause, r.won ? '승리' : '패배']);
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'mind-penalty-play-records.csv';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    el('storage-status').textContent = '경기별 골키퍼 순서를 포함한 CSV를 생성했습니다.';
  });

  el('storage-status').textContent = loaded.message;
  if (loaded.message.includes('이전 버전')) persist();
  setInterval(tick, 250);
  render();
  // Keep the timing animation in sync with the actual pause-resume state.
})();
