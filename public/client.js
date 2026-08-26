const socket = io();
let currentGameState = null;
let selectedCardUid = null;

function createRoom() {
  const name = document.getElementById('username').value.trim();
  if (!name) return alert('Введите имя!');
  socket.emit('createRoom', { name });
}

function joinRoom() {
  const name = document.getElementById('username').value.trim();
  const code = document.getElementById('room-code-input').value.trim();
  if (!name || !code) return alert('Введите имя и код!');
  socket.emit('joinRoom', { name, code });
}

function startGame() { socket.emit('startGame'); }
function nextRound() { socket.emit('nextRound'); }

socket.on('errorMsg', msg => alert(msg));
socket.on('peekCard', ({ targetName, card }) => {
  alert(`Карта игрока ${targetName}: [${card.value}] ${card.name}`);
});

socket.on('gameState', state => {
  currentGameState = state;
  document.getElementById('lobby-view').classList.add('hidden');

  if (state.state === 'LOBBY') {
    document.getElementById('waiting-view').classList.remove('hidden');
    document.getElementById('game-view').classList.add('hidden');
    document.getElementById('display-room-code').innerText = state.code;
    const list = document.getElementById('waiting-players-list');
    list.innerHTML = state.players.map(p => `<li>${p.name}</li>`).join('');
    return;
  }

  document.getElementById('waiting-view').classList.add('hidden');
  document.getElementById('game-view').classList.remove('hidden');

  document.getElementById('deck-count').innerText = state.deckCount;
  const curTurnPlayer = state.players[state.turnIndex];
  document.getElementById('turn-indicator').innerText = `Ход: ${curTurnPlayer.name} ${curTurnPlayer.id === state.you.id ? '(ВАШ)' : ''}`;

  // Открытые сбросы для 2 игроков
  const revContainer = document.getElementById('revealed-cards');
  if (state.removedFaceUp && state.removedFaceUp.length > 0) {
    revContainer.classList.remove('hidden');
    document.getElementById('revealed-list').innerHTML = state.removedFaceUp.map(renderCardHtml).join('');
  } else {
    revContainer.classList.add('hidden');
  }

  // Оппоненты
  const oppDiv = document.getElementById('opponents-zone');
  oppDiv.innerHTML = state.players.filter(p => p.id !== state.you.id).map(p => `
    <div class="opponent-card ${p.isEliminated ? 'eliminated' : ''} ${p.isProtected ? 'protected' : ''}">
      <h4>${p.name} ${p.isProtected ? '🛡️' : ''}</h4>
      <p>Жетоны: <b>${p.tokens}</b> | Карт: ${p.handCount}</p>
      <p>Сброс: ${p.discards.map(c => c.name).join(', ') || '—'}</p>
      ${p.isEliminated ? '<b style="color:red">ВЫБЫЛ</b>' : ''}
    </div>
  `).join('');

  // Рука игрока
  const handDiv = document.getElementById('my-hand');
  if (state.you.pendingMinister) {
    handDiv.innerHTML = `<h4>Выберите 1 карту, которую оставите:</h4>` + 
      state.you.pendingMinister.map(c => `
        <div class="game-card" onclick="selectMinisterCard(${c.uid})">
          <span class="value">${c.value}</span>
          <div class="name">${c.name}</div>
          <div class="desc">${c.desc}</div>
        </div>
      `).join('');
  } else {
    handDiv.innerHTML = state.you.hand.map(c => `
      <div class="game-card" onclick="onCardClick(${c.uid}, ${c.id})">
        <span class="value">${c.value}</span>
        <div class="name">${c.name}</div>
        <div class="desc">${c.desc}</div>
      </div>
    `).join('');
  }

  // Завершение раунда / игры
  const status = document.getElementById('round-status');
  if (state.state === 'ROUND_OVER') {
    status.innerHTML = `<h3>Раунд завершен!</h3><button onclick="nextRound()">Следующий раунд</button>`;
  } else if (state.state === 'GAME_OVER') {
    status.innerHTML = `<h2>Победитель игры: ${state.winnerName}!</h2>`;
  } else {
    status.innerHTML = '';
  }
});

function renderCardHtml(c) {
  return `<div class="game-card"><span class="value">${c.value}</span><div class="name">${c.name}</div></div>`;
}

function selectMinisterCard(keepUid) {
  socket.emit('resolveMinister', { keepUid });
}

function onCardClick(cardUid, cardId) {
  const isMyTurn = currentGameState.players[currentGameState.turnIndex].id === currentGameState.you.id;
  if (!isMyTurn) return alert('Сейчас не ваш ход!');

  selectedCardUid = cardUid;
  const needsTarget = [1, 2, 3, 5, 7].includes(cardId);
  const isGuard = cardId === 1;

  if (!needsTarget) {
    socket.emit('playCard', { cardUid });
    return;
  }

  const select = document.getElementById('modal-targets');
  select.innerHTML = '';
  currentGameState.players.forEach(p => {
    if (!p.isEliminated && (cardId === 5 || p.id !== currentGameState.you.id)) {
      select.innerHTML += `<option value="${p.id}">${p.name} ${p.isProtected ? '(Защищен)' : ''}</option>`;
    }
  });

  document.getElementById('modal-guess-zone').className = isGuard ? '' : 'hidden';
  document.getElementById('action-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('action-modal').classList.add('hidden');
}

function confirmCardPlay() {
  const targetId = document.getElementById('modal-targets').value;
  const guessCardId = parseInt(document.getElementById('modal-guesses').value);
  socket.emit('playCard', { cardUid: selectedCardUid, targetId, guessCardId });
  closeModal();
}

