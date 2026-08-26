const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const CARDS_DEF = [
  { id: 0, name: 'Шпион', value: 0, count: 2, desc: 'Дает жетон в конце раунда, если вы единственный выживший с ним.' },
  { id: 1, name: 'Стражница', value: 1, count: 6, desc: 'Назовите карту соперника (кроме Стражницы). Если угадали — он выбывает.' },
  { id: 2, name: 'Священник', value: 2, count: 2, desc: 'Посмотрите карту другого игрока.' },
  { id: 3, name: 'Барон', value: 3, count: 2, desc: 'Тайно сравните карты с соперником. Меньший выбывает.' },
  { id: 4, name: 'Служанка', value: 4, count: 2, desc: 'Защита от свойств карт других игроков до следующего хода.' },
  { id: 5, name: 'Принц', value: 5, count: 2, desc: 'Игрок сбрасывает карту и берет новую (из колоды или закрытую сброшенную).' },
  { id: 6, name: 'Министр', value: 6, count: 2, desc: 'Возьмите 2 карты, выберите 1, остальные 2 верните вниз колоды.' },
  { id: 7, name: 'Король', value: 7, count: 1, desc: 'Обменяйтесь картами на руке с другим игроком.' },
  { id: 8, name: 'Графиня', value: 8, count: 1, desc: 'Обязана быть сброшена, если на руке есть Принц или Король.' },
  { id: 9, name: 'Принцесса', value: 9, count: 1, desc: 'Если вы сбросили Принцессу — вы немедленно выбываете.' }
];

const WIN_TOKENS = { 2: 6, 3: 5, 4: 4 };
const rooms = {};

function createDeck() {
  let deck = [];
  let uid = 1;
  CARDS_DEF.forEach(c => {
    for (let i = 0; i < c.count; i++) {
      deck.push({ uid: uid++, id: c.id, name: c.name, value: c.value, desc: c.desc });
    }
  });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function startRound(room) {
  room.deck = createDeck();
  room.removedFaceDown = room.deck.pop();
  room.removedFaceUp = [];

  // Особое правило для двоих игроков
  if (room.players.length === 2) {
    room.removedFaceUp.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
  }

  room.players.forEach(p => {
    p.hand = [room.deck.pop()];
    p.discards = [];
    p.isProtected = false;
    p.isEliminated = false;
    p.pendingMinister = null;
  });

  room.state = 'PLAYING';
  room.turnIndex = room.lastWinnerIndex !== null ? room.lastWinnerIndex : Math.floor(Math.random() * room.players.length);
  startTurn(room);
}

function startTurn(room) {
  const activePlayers = room.players.filter(p => !p.isEliminated);
  if (activePlayers.length <= 1 || room.deck.length === 0) {
    endRound(room);
    return;
  }

  while (room.players[room.turnIndex].isEliminated) {
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
  }

  const cur = room.players[room.turnIndex];
  cur.isProtected = false; // Защита служанки спадает в начале хода

  if (room.deck.length > 0) {
    cur.hand.push(room.deck.pop());
  }
  broadcastRoom(room);
}

function endRound(room) {
  room.state = 'ROUND_OVER';
  const active = room.players.filter(p => !p.isEliminated);
  let winners = [];

  if (active.length === 1) {
    winners = [active[0]];
  } else {
    let maxVal = -1;
    active.forEach(p => {
      const v = p.hand[0]?.value ?? -1;
      if (v > maxVal) {
        maxVal = v;
        winners = [p];
      } else if (v === maxVal) {
        winners.push(p);
      }
    });
  }

  winners.forEach(w => w.tokens++);
  room.lastWinnerIndex = room.players.indexOf(winners[0]);

  // Проверка жетона шпиона
  const spyHolders = room.players.filter(p => !p.isEliminated && p.discards.some(c => c.id === 0));
  if (spyHolders.length === 1) {
    spyHolders[0].tokens++;
  }

  const reqTokens = WIN_TOKENS[room.players.length] || 4;
  const gameWinner = room.players.find(p => p.tokens >= reqTokens);

  if (gameWinner) {
    room.state = 'GAME_OVER';
    room.winnerName = gameWinner.name;
  }

  broadcastRoom(room);
}

function broadcastRoom(room) {
  room.players.forEach(p => {
    const sanitized = {
      code: room.code,
      state: room.state,
      turnIndex: room.turnIndex,
      deckCount: room.deck ? room.deck.length : 0,
      removedFaceUp: room.removedFaceUp,
      winnerName: room.winnerName,
      you: {
        id: p.id,
        name: p.name,
        hand: p.hand,
        pendingMinister: p.pendingMinister
      },
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        tokens: pl.tokens,
        isEliminated: pl.isEliminated,
        isProtected: pl.isProtected,
        discards: pl.discards,
        handCount: pl.hand.length
      }))
    };
    io.to(p.id).emit('gameState', sanitized);
  });
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name }) => {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[code] = {
      code,
      state: 'LOBBY',
      players: [{ id: socket.id, name, tokens: 0, hand: [], discards: [], isProtected: false, isEliminated: false }],
      deck: [],
      removedFaceDown: null,
      removedFaceUp: [],
      turnIndex: 0,
      lastWinnerIndex: null
    };
    socket.join(code);
    socket.roomCode = code;
    broadcastRoom(rooms[code]);
  });

  socket.on('joinRoom', ({ name, code }) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room || room.state !== 'LOBBY' || room.players.length >= 4) {
      return socket.emit('errorMsg', 'Комната не найдена или заполнена!');
    }
    room.players.push({ id: socket.id, name, tokens: 0, hand: [], discards: [], isProtected: false, isEliminated: false });
    socket.join(code);
    socket.roomCode = code;
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (room && room.state === 'LOBBY' && room.players.length >= 2) {
      startRound(room);
    }
  });

  socket.on('nextRound', () => {
    const room = rooms[socket.roomCode];
    if (room && room.state === 'ROUND_OVER') {
      startRound(room);
    }
  });

  socket.on('playCard', ({ cardUid, targetId, guessCardId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'PLAYING') return;
    const cur = room.players[room.turnIndex];
    if (cur.id !== socket.id) return;

    const cardIndex = cur.hand.findIndex(c => c.uid === cardUid);
    if (cardIndex === -1) return;
    const card = cur.hand[cardIndex];

    // Проверка Графини
    const hasPrinceOrKing = cur.hand.some(c => c.id === 5 || c.id === 7);
    if (hasPrinceOrKing && cur.hand.some(c => c.id === 8) && card.id !== 8) {
      return socket.emit('errorMsg', 'Вы обязаны сыграть Графиню!');
    }

    cur.hand.splice(cardIndex, 1);
    cur.discards.push(card);

    let target = room.players.find(p => p.id === targetId && !p.isEliminated);
    if (target && target.isProtected && card.id !== 5) target = null;

    switch (card.id) {
      case 9: // Принцесса
        cur.isEliminated = true;
        break;
      case 8: // Графиня
        break;
      case 7: // Король
        if (target && target.id !== cur.id) {
          const temp = cur.hand[0];
          cur.hand[0] = target.hand[0];
          target.hand[0] = temp;
        }
        break;
      case 6: // Министр
        const drawn = [];
        if (room.deck.length > 0) drawn.push(room.deck.pop());
        if (room.deck.length > 0) drawn.push(room.deck.pop());
        cur.pendingMinister = [...cur.hand, ...drawn];
        cur.hand = [];
        broadcastRoom(room);
        return;
      case 5: // Принц
        const pTarget = target || cur;
        if (!pTarget.isProtected || pTarget.id === cur.id) {
          const discarded = pTarget.hand.pop();
          if (discarded) {
            pTarget.discards.push(discarded);
            if (discarded.id === 9) {
              pTarget.isEliminated = true;
            } else {
              pTarget.hand.push(room.deck.length > 0 ? room.deck.pop() : room.removedFaceDown);
            }
          }
        }
        break;
      case 4: // Служанка
        cur.isProtected = true;
        break;
      case 3: // Барон
        if (target && target.id !== cur.id) {
          const myVal = cur.hand[0].value;
          const targetVal = target.hand[0].value;
          if (myVal > targetVal) target.isEliminated = true;
          else if (myVal < targetVal) cur.isEliminated = true;
        }
        break;
      case 2: // Священник
        if (target && target.id !== cur.id) {
          socket.emit('peekCard', { targetName: target.name, card: target.hand[0] });
        }
        break;
      case 1: // Стражница
        if (target && target.id !== cur.id && guessCardId !== 1) {
          if (target.hand[0] && target.hand[0].id === guessCardId) {
            target.isEliminated = true;
          }
        }
        break;
      case 0: // Шпион
        break;
    }

    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    startTurn(room);
  });

  socket.on('resolveMinister', ({ keepUid }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const cur = room.players.find(p => p.id === socket.id);
    if (!cur || !cur.pendingMinister) return;

    const keepCard = cur.pendingMinister.find(c => c.uid === keepUid);
    const returns = cur.pendingMinister.filter(c => c.uid !== keepUid);
    cur.hand = [keepCard];
    cur.pendingMinister = null;

    returns.forEach(c => room.deck.unshift(c)); // Карты под низ колоды

    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    startTurn(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[socket.roomCode];
      } else {
        broadcastRoom(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));
    
