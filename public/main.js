const socket = io();
let playerToken = sessionStorage.getItem('playerToken');
let roomId = sessionStorage.getItem('roomId');
let myName = '', myRole = '', myAlive = true;
let isHost = false;

// ------------------ دوال المساعدة ------------------
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(screenId);
    if (el) el.classList.add('active');
}

function showGamePanel(panelId) {
    document.querySelectorAll('#gameScreen .game-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById(panelId);
    if (panel) panel.style.display = 'block';
}

function notifyPlayer() {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = 880; osc.type = 'square'; gain.gain.value = 0.1;
        osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch(e) {}
}

function clearSession() {
    sessionStorage.removeItem('playerToken');
    sessionStorage.removeItem('roomId');
    playerToken = null; roomId = null;
}

// ------------------ شاشة الإيقاظ ------------------
function showWakeup() {
    showScreen('wakeupScreen');
    document.getElementById('wakeupStatus').textContent = 'جاري الاتصال...';
    document.getElementById('wakeupError').style.display = 'none';
    document.getElementById('wakeupRetry').style.display = 'none';
    document.getElementById('spinner').style.display = 'none';
    startPinging();
}

let pingInterval;
function startPinging() {
    const attempt = () => fetch('/ping').then(r => {
        if (r.ok) {
            clearInterval(pingInterval);
            document.getElementById('wakeupStatus').textContent = 'تم الاتصال!';
            setTimeout(() => showScreen('lobbyScreen'), 500);
        }
    }).catch(() => {});
    attempt();
    pingInterval = setInterval(attempt, 5000);
}
document.getElementById('wakeupRetry').onclick = startPinging;

// ------------------ اللوبي ------------------
document.getElementById('btnCreate').onclick = () => {
    document.getElementById('menu').style.display = 'none';
    document.getElementById('createForm').style.display = 'block';
};
document.getElementById('btnJoin').onclick = () => {
    document.getElementById('menu').style.display = 'none';
    document.getElementById('joinForm').style.display = 'block';
};
document.getElementById('btnInstructions').onclick = () => {
    document.getElementById('instructionsPanel').style.display = 'block';
};
document.querySelectorAll('.backBtn').forEach(b => {
    b.addEventListener('click', () => {
        document.getElementById('createForm').style.display = 'none';
        document.getElementById('joinForm').style.display = 'none';
        document.getElementById('menu').style.display = 'block';
    });
});
document.querySelector('.closeInstructions')?.addEventListener('click', () => {
    document.getElementById('instructionsPanel').style.display = 'none';
});

document.getElementById('confirmCreate').onclick = () => {
    const name = document.getElementById('createName').value.trim();
    const total = +document.getElementById('totalPlayers').value;
    const mafia = +document.getElementById('mafiaCount').value;
    if (!name || total < 5 || mafia < 1 || mafia >= total - 2) return alert('بيانات غير صحيحة');
    socket.emit('createRoom', { playerName: name, totalPlayers: total, mafiaCount: mafia }, (res) => {
        if (res.error) alert(res.error);
    });
};

document.getElementById('confirmJoin').onclick = () => {
    const name = document.getElementById('joinName').value.trim();
    const code = document.getElementById('roomCode').value.trim().toUpperCase();
    if (!name || !code) return alert('أدخل الاسم والكود');
    socket.emit('joinRoom', { playerName: name, roomId: code }, (res) => {
        if (res.error) alert(res.error);
    });
};

document.getElementById('btnStart').onclick = () => {
    socket.emit('forceStart', { roomId });
};

document.getElementById('btnLeave').onclick = () => {
    if (roomId) socket.emit('leaveRoom', { roomId });
    clearSession();
    location.reload();
};

// ------------------ استقبال أحداث الخادم ------------------
socket.on('authenticated', ({ playerToken: tok, roomId: rid, yourName: name }) => {
    playerToken = tok; roomId = rid; myName = name;
    sessionStorage.setItem('playerToken', tok);
    sessionStorage.setItem('roomId', rid);
    document.getElementById('createForm').style.display = 'none';
    document.getElementById('joinForm').style.display = 'none';
    document.getElementById('menu').style.display = 'none';
    document.getElementById('waitingRoom').style.display = 'block';
    document.getElementById('roomIdDisplay').textContent = rid;
    document.getElementById('btnStart').style.display = isHost ? 'inline-block' : 'none';
    document.getElementById('waitingMsg').textContent = 'في انتظار اللاعبين...';
});

socket.on('youAreHost', () => {
    isHost = true;
    document.getElementById('btnStart').style.display = 'inline-block';
});

socket.on('playerList', (players) => {
    document.getElementById('playerList').innerHTML = players.map(p => `<div>${p.name} ${p.disconnected ? '⚫' : ''}</div>`).join('');
    if (isHost && players.length >= 5) document.getElementById('btnStart').style.display = 'inline-block';
});

socket.on('gameStarting', ({ message }) => {
    document.getElementById('waitingMsg').textContent = message;
});
socket.on('countdown', (sec) => {
    document.getElementById('waitingMsg').textContent = `تبدأ بعد ${sec} ثانية`;
});

socket.on('gameInit', (data) => {
    myRole = data.role;
    myName = data.yourName;
    myAlive = true;
    document.getElementById('logList').innerHTML = '';
    showScreen('gameScreen');
    showGamePanel('blackScreen');
    document.getElementById('narratorMsg').textContent = 'اللعبة بدأت!';
});

// ------------------ أحداث الليل ------------------
socket.on('nightStart', (msg) => {
    showGamePanel('blackScreen');
    document.getElementById('narratorMsg').textContent = msg;
});

socket.on('mafiaTurn', ({ message, players }) => {
    if (myRole !== 'مافيا' || !myAlive) return;
    notifyPlayer();
    showGamePanel('mafiaSoloPanel');
    document.getElementById('mafiaSoloMsg').textContent = message;
    const list = document.getElementById('mafiaSoloList');
    list.innerHTML = players.map(p => `<button data-id="${p.id}">${p.name}</button>`).join('');
    list.querySelectorAll('button').forEach(b => b.onclick = () => {
        socket.emit('mafiaSelectTarget', { roomId, targetId: b.dataset.id });
        showGamePanel('blackScreen');
    });
});

socket.on('mafiaTurnMultiple', ({ message, mafiaMembers }) => {
    if (myRole !== 'مافيا' || !myAlive) return;
    notifyPlayer();
    showGamePanel('mafiaMultiPanel');
    document.getElementById('mafiaTeam').textContent = 'الفريق: ' + mafiaMembers.join(', ');
    document.getElementById('mafiaReadyBtn').disabled = true;
    document.getElementById('mafiaReadyBtn').textContent = 'جاهز للتصويت (مقفل)';
    document.getElementById('mafiaReadyStatus').textContent = '';
    document.getElementById('mafiaChatMessages').innerHTML = '';
});

socket.on('enableReadyButton', () => {
    const btn = document.getElementById('mafiaReadyBtn');
    btn.disabled = false;
    btn.textContent = 'جاهز للتصويت';
    document.getElementById('mafiaReadyStatus').textContent = 'بإمكانك الضغط على جاهز';
});

document.getElementById('mafiaReadyBtn').onclick = () => socket.emit('mafiaReady', { roomId });
socket.on('mafiaReadyUpdate', ({ name, ready }) => {
    document.getElementById('mafiaReadyStatus').textContent += `${name} جاهز. `;
});

document.getElementById('sendMafiaChat').onclick = () => {
    const msg = document.getElementById('mafiaChatInput').value.trim();
    if (msg) { socket.emit('mafiaChatMessage', { roomId, message: msg }); document.getElementById('mafiaChatInput').value = ''; }
};
socket.on('mafiaChatMessage', ({ from, message }) => {
    const box = document.getElementById('mafiaChatMessages');
    box.innerHTML += `<div><strong>${from}:</strong> ${message}</div>`;
    box.scrollTop = box.scrollHeight;
});

socket.on('mafiaVoteTarget', ({ message, players }) => {
    notifyPlayer();
    showGamePanel('mafiaVotePanel');
    const list = document.getElementById('mafiaVoteList');
    list.innerHTML = players.map(p => `<button data-id="${p.id}">${p.name}</button>`).join('');
    list.querySelectorAll('button').forEach(b => b.onclick = () => {
        socket.emit('mafiaVote', { roomId, targetId: b.dataset.id });
        showGamePanel('blackScreen');
    });
});

socket.on('doctorTurn', ({ message, players }) => {
    if (myRole !== 'طبيب' || !myAlive) return;
    notifyPlayer();
    showGamePanel('doctorPanel');
    document.querySelector('#doctorPanel p').textContent = message;
    const list = document.getElementById('doctorList');
    list.innerHTML = players.map(p => `<button data-id="${p.id}">${p.name}</button>`).join('');
    list.querySelectorAll('button').forEach(b => b.onclick = () => {
        socket.emit('doctorSave', { roomId, targetId: b.dataset.id });
        showGamePanel('blackScreen');
    });
});

socket.on('policeTurn', ({ message, players }) => {
    if (myRole !== 'شرطي' || !myAlive) return;
    notifyPlayer();
    showGamePanel('policePanel');
    document.querySelector('#policePanel p').textContent = message;
    const list = document.getElementById('policeList');
    list.innerHTML = players.map(p => `<button data-id="${p.id}">${p.name}</button>`).join('');
    list.querySelectorAll('button').forEach(b => b.onclick = () => {
        socket.emit('policeInvestigate', { roomId, targetId: b.dataset.id });
    });
});

socket.on('investigationResult', ({ name, role }) => {
    showGamePanel('investPanel');
    document.getElementById('investResult').textContent = `دور ${name}: ${role}`;
    document.getElementById('investOk').onclick = () => showGamePanel('blackScreen');
});

socket.on('nightResult', ({ killed, saved, log }) => {
    updateLog(log);
    let msg = killed ? `تم قتل ${killed}!` : (saved ? 'محاولة اغتيال فاشلة' : 'لم يمت أحد');
    document.getElementById('narratorMsg').textContent = msg;
    showGamePanel('blackScreen');
});

// ------------------ تصويت النهار ------------------
socket.on('startVoting', ({ message, players }) => {
    showGamePanel('votePanel');
    document.getElementById('voteMsg').textContent = message;
    const list = document.getElementById('voteList');
    list.innerHTML = players.map(p => `<button data-id="${p.id}">${p.name}</button>`).join('');
    document.getElementById('skipVote').style.display = 'inline-block';
    let voted = false;
    list.querySelectorAll('button').forEach(b => b.onclick = () => {
        if (voted) return; voted = true;
        socket.emit('vote', { roomId, targetId: b.dataset.id });
    });
    document.getElementById('skipVote').onclick = () => {
        if (voted) return; voted = true;
        socket.emit('vote', { roomId, targetId: 'skip' });
    };
    document.getElementById('voteStatus').textContent = '';
});

socket.on('votesUpdate', ({ voted, total }) => {
    document.getElementById('voteStatus').textContent = `${voted}/${total} صوتوا`;
});

socket.on('votingResult', ({ expelled, message }) => {
    document.getElementById('narratorMsg').textContent = message;
    showGamePanel('blackScreen');
});

socket.on('nextRound', (round) => {
    document.getElementById('narratorMsg').textContent = `الجولة ${round}`;
});

socket.on('gameOver', ({ winner, message }) => {
    showGamePanel('gameOverPanel');
    document.getElementById('gameOverTitle').textContent = message;
    document.getElementById('playAgain').onclick = () => { clearSession(); location.reload(); };
});

socket.on('errorMessage', (msg) => alert(msg));

// ------------------ سجل الأحداث ------------------
function updateLog(entries) {
    const list = document.getElementById('logList');
    entries.forEach(e => {
        const li = document.createElement('li');
        li.textContent = e;
        list.appendChild(li);
    });
}

// ------------------ بدء التطبيق ------------------
function tryReauth() {
    if (playerToken && roomId) {
        socket.emit('reauthenticate', { roomId, playerToken }, (res) => {
            if (res.success) {
                myName = res.yourName;
                myRole = res.role;
                myAlive = res.alive;
                showScreen('gameScreen');
                if (res.state === 'ended') showGamePanel('gameOverPanel');
                else showGamePanel('blackScreen');
            } else {
                clearSession();
                showWakeup();
            }
        });
    } else {
        showWakeup();
    }
}

if (playerToken && roomId) tryReauth();
else showWakeup();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
