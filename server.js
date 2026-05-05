const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/ping', (req, res) => res.json({ awake: true }));

// ------------------ هيكل البيانات ------------------
const rooms = {};

const ROLES = {
    MAFIA: 'مافيا',
    DOCTOR: 'طبيب',
    POLICE: 'شرطي',
    CITIZEN: 'مواطن'
};

const TIMEOUTS = {
    MAFIA_SOLO: 30000,
    MAFIA_MULTI_READY: 30000,
    MAFIA_MULTI_VOTE: 30000,
    DOCTOR: 30000,
    POLICE: 30000,
    DAY_VOTING: 60000
};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function generateToken() {
    return Math.random().toString(36).substring(2, 15);
}
function getPlayerBySocket(room, socket) {
    return room.players.find(p => p.socketId === socket.id);
}
function getAlivePlayersExcept(room, excludeToken, excludeMafia = false) {
    return room.players
        .filter(p => p.alive && p.token !== excludeToken && (!excludeMafia || p.role !== ROLES.MAFIA))
        .map(p => ({ id: p.token, name: p.name }));
}

// ------------------ Socket.io ------------------
io.on('connection', (socket) => {
    console.log(`اتصال جديد: ${socket.id}`);

    // ---------- إنشاء غرفة ----------
    socket.on('createRoom', (data, callback) => {
        const { playerName, totalPlayers, mafiaCount } = data;
        if (totalPlayers < 5 || mafiaCount < 1 || mafiaCount >= totalPlayers - 2) {
            return callback({ error: 'إعدادات غير صالحة. (الحد الأدنى 5 لاعبين، المافيا أقل من العدد - 2)' });
        }
        const roomId = generateRoomId();
        const hostToken = generateToken();
        const room = {
            id: roomId,
            hostToken,
            players: [],
            settings: {
                totalPlayers,
                mafiaCount,
                citizenCount: totalPlayers - mafiaCount - 2,
                doctorCount: 1,
                policeCount: 1
            },
            state: 'waiting',
            timer: null,
            phaseTimer: null,
            currentPhase: null,
            nightActions: { mafiaTarget: null, doctorSave: null, policeInvestigate: null },
            mafiaReady: new Set(),
            nightMafiaVotes: {},
            votes: {},
            round: 0,
            killedTonight: null,
            savedByDoctor: false,
            log: []
        };
        const player = {
            token: hostToken,
            socketId: socket.id,
            name: playerName,
            role: null,
            alive: true,
            disconnected: false
        };
        room.players.push(player);
        rooms[roomId] = room;
        socket.join(roomId);
        socket.emit('authenticated', { playerToken: hostToken, roomId, yourName: playerName });
        socket.emit('youAreHost');
        callback({ roomId, players: room.players.map(p => ({ name: p.name, alive: p.alive })) });
    });

    // ---------- انضمام إلى غرفة ----------
    socket.on('joinRoom', (data, callback) => {
        const { roomId, playerName } = data;
        const room = rooms[roomId];
        if (!room) return callback({ error: 'الغرفة غير موجودة.' });
        if (room.state !== 'waiting') return callback({ error: 'اللعبة بدأت بالفعل.' });
        if (room.players.length >= room.settings.totalPlayers) return callback({ error: 'الغرفة ممتلئة.' });
        if (room.players.some(p => p.name === playerName)) return callback({ error: 'الاسم مكرر.' });
        const token = generateToken();
        const player = {
            token,
            socketId: socket.id,
            name: playerName,
            role: null,
            alive: true,
            disconnected: false
        };
        room.players.push(player);
        socket.join(roomId);
        socket.emit('authenticated', { playerToken: token, roomId, yourName: playerName });
        io.to(roomId).emit('playerList', room.players.map(p => ({ name: p.name, alive: p.alive, disconnected: p.disconnected })));
        if (room.players.length === room.settings.totalPlayers) {
            startGameCountdown(roomId);
        }
        callback({ roomId, players: room.players.map(p => ({ name: p.name, alive: p.alive })) });
    });

    // ---------- إعادة اتصال ----------
    socket.on('reauthenticate', ({ roomId, playerToken }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback({ error: 'الغرفة غير موجودة.' });
        const player = room.players.find(p => p.token === playerToken);
        if (!player) return callback({ error: 'اللاعب غير معروف.' });
        player.socketId = socket.id;
        player.disconnected = false;
        socket.join(roomId);
        callback({ success: true, yourName: player.name, role: player.role, alive: player.alive, state: room.state });
        io.to(roomId).emit('playerReconnected', { name: player.name });
    });

    // ---------- بدء فوري ----------
    socket.on('forceStart', ({ roomId }) => {
        const room = rooms[roomId];
        const player = getPlayerBySocket(room, socket);
        if (!room || room.hostToken !== player?.token || room.state !== 'waiting') return;
        if (room.players.length >= 5) {
            if (room.timer) clearInterval(room.timer);
            startGame(roomId);
        } else {
            socket.emit('errorMessage', 'يلزم 5 لاعبين على الأقل.');
        }
    });

    // ---------- مغادرة غرفة ----------
    socket.on('leaveRoom', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = getPlayerBySocket(room, socket);
        if (!player) return;
        removePlayerFromRoom(room, player.token);
        socket.leave(roomId);
    });

    // ---------- انقطاع الاتصال ----------
    socket.on('disconnect', () => {
        for (let rid in rooms) {
            const room = rooms[rid];
            const player = room.players.find(p => p.socketId === socket.id);
            if (!player) continue;
            player.disconnected = true;
            if (room.state === 'waiting') {
                setTimeout(() => {
                    if (player.disconnected && room.players.includes(player)) {
                        removePlayerFromRoom(room, player.token);
                    }
                }, 10000);
            } else {
                setTimeout(() => {
                    if (player.disconnected && player.alive) {
                        player.alive = false;
                        io.to(rid).emit('playerLeft', { name: player.name, message: 'انقطع ولم يعد.' });
                        checkWinCondition(rid);
                        if (room.state === 'day') tryResolveVoting(rid);
                        else if (room.state === 'night') advanceIfNightStalled(rid);
                    }
                }, 30000);
            }
        }
    });

    function removePlayerFromRoom(room, token) {
        const idx = room.players.findIndex(p => p.token === token);
        if (idx !== -1) {
            room.players.splice(idx, 1);
            io.to(room.id).emit('playerList', room.players.map(p => ({ name: p.name, alive: p.alive, disconnected: p.disconnected })));
            if (room.players.length === 0) delete rooms[room.id];
        }
    }

    // ---------- مراحل اللعبة ----------
    function startGameCountdown(roomId) {
        const room = rooms[roomId];
        room.countdown = 30;
        io.to(roomId).emit('gameStarting', { message: 'اكتمل العدد! تبدأ اللعبة بعد 30 ثانية...' });
        room.timer = setInterval(() => {
            room.countdown--;
            if (room.countdown <= 0) {
                clearInterval(room.timer);
                startGame(roomId);
            } else if (room.countdown <= 5 || room.countdown % 10 === 0) {
                io.to(roomId).emit('countdown', room.countdown);
            }
        }, 1000);
    }

    function startGame(roomId) {
        const room = rooms[roomId];
        if (room.state !== 'waiting') return;
        clearInterval(room.timer);
        const roles = [];
        for (let i = 0; i < room.settings.mafiaCount; i++) roles.push(ROLES.MAFIA);
        roles.push(ROLES.DOCTOR, ROLES.POLICE);
        for (let i = 0; i < room.settings.citizenCount; i++) roles.push(ROLES.CITIZEN);
        for (let i = roles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [roles[i], roles[j]] = [roles[j], roles[i]];
        }
        room.players.forEach((p, i) => p.role = roles[i]);
        room.state = 'night';
        room.round = 1;
        room.log = [`--- الجولة 1 ---`];
        room.players.forEach(p => {
            io.to(p.socketId).emit('gameInit', {
                role: p.role,
                yourName: p.name,
                players: room.players.map(pl => ({ name: pl.name, alive: pl.alive }))
            });
        });
        startNightPhase(roomId);
    }

    function startNightPhase(roomId) {
        const room = rooms[roomId];
        room.state = 'night';
        room.nightActions = { mafiaTarget: null, doctorSave: null, policeInvestigate: null };
        room.mafiaReady.clear();
        room.nightMafiaVotes = {};
        clearTimeout(room.phaseTimer);
        io.to(roomId).emit('nightStart', 'الليل يحل... أغمضوا أعينكم.');
        room.currentPhase = 'mafia';
        startMafiaTurn(roomId);
    }

    function startMafiaTurn(roomId) {
        const room = rooms[roomId];
        const aliveMafia = room.players.filter(p => p.alive && p.role === ROLES.MAFIA);
        if (aliveMafia.length === 0) {
            room.currentPhase = 'doctor';
            startDoctorTurn(roomId);
            return;
        }
        if (aliveMafia.length === 1) {
            const solo = aliveMafia[0];
            io.to(solo.socketId).emit('mafiaTurn', {
                message: 'أنت المافيا! اختر شخصاً لتقتله.',
                players: getAlivePlayersExcept(room, solo.token, true)
            });
            room.phaseTimer = setTimeout(() => {
                if (room.currentPhase === 'mafia' && !room.nightActions.mafiaTarget) {
                    room.nightActions.mafiaTarget = null;
                    room.currentPhase = 'doctor';
                    startDoctorTurn(roomId);
                }
            }, TIMEOUTS.MAFIA_SOLO);
        } else {
            aliveMafia.forEach(p => {
                io.to(p.socketId).emit('mafiaTurnMultiple', {
                    message: 'أنتم المافيا! ناقشوا واتفقوا. زر الجاهزية سيفعّل بعد 30 ثانية.',
                    mafiaMembers: aliveMafia.map(m => m.name)
                });
            });
            room.phaseTimer = setTimeout(() => {
                if (room.currentPhase === 'mafia') {
                    aliveMafia.forEach(p => io.to(p.socketId).emit('enableReadyButton'));
                    room.phaseTimer = setTimeout(() => {
                        if (room.currentPhase === 'mafia') {
                            room.nightActions.mafiaTarget = 'failed_disagreement';
                            room.currentPhase = 'doctor';
                            startDoctorTurn(roomId);
                        }
                    }, TIMEOUTS.MAFIA_MULTI_VOTE);
                }
            }, TIMEOUTS.MAFIA_MULTI_READY);
        }
    }

    // أحداث المافيا
    socket.on('mafiaSelectTarget', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.currentPhase !== 'mafia') return;
        const player = getPlayerBySocket(room, socket);
        if (!player || player.role !== ROLES.MAFIA || !player.alive) return;
        if (room.players.filter(p => p.alive && p.role === ROLES.MAFIA).length !== 1) return;
        const target = room.players.find(p => p.token === targetId && p.role !== ROLES.MAFIA);
        if (!target) return;
        room.nightActions.mafiaTarget = targetId;
        clearTimeout(room.phaseTimer);
        room.currentPhase = 'doctor';
        startDoctorTurn(roomId);
    });

    socket.on('mafiaReady', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.currentPhase !== 'mafia') return;
        const player = getPlayerBySocket(room, socket);
        if (!player || player.role !== ROLES.MAFIA || !player.alive) return;
        room.mafiaReady.add(player.token);
        const aliveMafia = room.players.filter(p => p.alive && p.role === ROLES.MAFIA);
        aliveMafia.forEach(p => io.to(p.socketId).emit('mafiaReadyUpdate', { name: player.name, ready: true }));
        if (room.mafiaReady.size === aliveMafia.length) {
            aliveMafia.forEach(p => io.to(p.socketId).emit('mafiaVoteTarget', {
                message: 'اختاروا الهدف. إذا لم تتفقوا تفشل العملية.',
                players: getAlivePlayersExcept(room, p.token, true)
            }));
            clearTimeout(room.phaseTimer);
            room.phaseTimer = setTimeout(() => {
                if (room.currentPhase === 'mafia') {
                    room.nightActions.mafiaTarget = 'failed_disagreement';
                    room.currentPhase = 'doctor';
                    startDoctorTurn(roomId);
                }
            }, TIMEOUTS.MAFIA_MULTI_VOTE);
        }
    });

    socket.on('mafiaVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.currentPhase !== 'mafia') return;
        const player = getPlayerBySocket(room, socket);
        if (!player || player.role !== ROLES.MAFIA || !player.alive) return;
        room.nightMafiaVotes[player.token] = targetId;
        const aliveMafia = room.players.filter(p => p.alive && p.role === ROLES.MAFIA);
        if (Object.keys(room.nightMafiaVotes).length === aliveMafia.length) {
            clearTimeout(room.phaseTimer);
            const votes = Object.values(room.nightMafiaVotes);
            const allSame = votes.every(v => v === votes[0]);
            room.nightActions.mafiaTarget = allSame && votes[0] ? votes[0] : 'failed_disagreement';
            room.currentPhase = 'doctor';
            startDoctorTurn(roomId);
        }
    });

    // طبيب
    function startDoctorTurn(roomId) {
        const room = rooms[roomId];
        const doc = room.players.find(p => p.alive && p.role === ROLES.DOCTOR);
        if (!doc) {
            room.currentPhase = 'police';
            startPoliceTurn(roomId);
            return;
        }
        io.to(doc.socketId).emit('doctorTurn', {
            message: 'أنت الطبيب! اختر شخصاً لتحميه.',
            players: getAlivePlayersExcept(room, doc.token)
        });
        room.phaseTimer = setTimeout(() => {
            if (room.currentPhase === 'doctor') {
                room.nightActions.doctorSave = null;
                room.currentPhase = 'police';
                startPoliceTurn(roomId);
            }
        }, TIMEOUTS.DOCTOR);
    }

    socket.on('doctorSave', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.currentPhase !== 'doctor') return;
        const doc = getPlayerBySocket(room, socket);
        if (!doc || doc.role !== ROLES.DOCTOR || !doc.alive) return;
        room.nightActions.doctorSave = targetId;
        clearTimeout(room.phaseTimer);
        room.currentPhase = 'police';
        startPoliceTurn(roomId);
    });

    // شرطي
    function startPoliceTurn(roomId) {
        const room = rooms[roomId];
        const police = room.players.find(p => p.alive && p.role === ROLES.POLICE);
        if (!police) {
            resolveNight(roomId);
            return;
        }
        io.to(police.socketId).emit('policeTurn', {
            message: 'أنت الشرطي! اختر شخصاً لتعرف دوره.',
            players: getAlivePlayersExcept(room, police.token)
        });
        room.phaseTimer = setTimeout(() => {
            if (room.currentPhase === 'police') {
                room.nightActions.policeInvestigate = null;
                resolveNight(roomId);
            }
        }, TIMEOUTS.POLICE);
    }

    socket.on('policeInvestigate', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.currentPhase !== 'police') return;
        const police = getPlayerBySocket(room, socket);
        if (!police || police.role !== ROLES.POLICE || !police.alive) return;
        const target = room.players.find(p => p.token === targetId);
        if (!target) return;
        room.nightActions.policeInvestigate = targetId;
        io.to(police.socketId).emit('investigationResult', { name: target.name, role: target.role });
        clearTimeout(room.phaseTimer);
        resolveNight(roomId);
    });

    function resolveNight(roomId) {
        const room = rooms[roomId];
        const mafiaTarget = room.nightActions.mafiaTarget;
        const doctorSave = room.nightActions.doctorSave;
        if (mafiaTarget && mafiaTarget !== 'failed_disagreement') {
            if (doctorSave === mafiaTarget) {
                room.savedByDoctor = true;
                room.killedTonight = null;
                room.log.push(`الطبيب حمى ${room.players.find(p => p.token === mafiaTarget)?.name}.`);
            } else {
                room.savedByDoctor = false;
                room.killedTonight = mafiaTarget;
                const victim = room.players.find(p => p.token === mafiaTarget);
                if (victim) {
                    victim.alive = false;
                    room.log.push(`المافيا قتلت ${victim.name}.`);
                }
            }
        } else if (mafiaTarget === 'failed_disagreement') {
            room.savedByDoctor = true;
            room.killedTonight = null;
            room.log.push('محاولة اغتيال فاشلة (لم تتفق المافيا).');
        } else {
            room.savedByDoctor = false;
            room.killedTonight = null;
            room.log.push('لم يُقتل أحد هذه الليلة.');
        }
        io.to(roomId).emit('nightResult', {
            killed: room.killedTonight ? room.players.find(p => p.token === room.killedTonight)?.name : null,
            saved: room.savedByDoctor,
            log: room.log.slice(-2)
        });
        if (checkWinCondition(roomId)) return;
        startDayVoting(roomId);
    }

    // تصويت النهار
    function startDayVoting(roomId) {
        const room = rooms[roomId];
        room.state = 'day';
        room.votes = {};
        const alive = room.players.filter(p => p.alive);
        if (alive.length === 0) { checkWinCondition(roomId); return; }
        io.to(roomId).emit('startVoting', {
            message: 'وقت التصويت! اختر شخصاً أو تخطي.',
            players: alive.map(p => ({ id: p.token, name: p.name })),
            allowSkip: true
        });
        room.phaseTimer = setTimeout(() => {
            if (room.state === 'day') {
                alive.forEach(p => { if (!room.votes[p.token]) room.votes[p.token] = 'skip'; });
                resolveVoting(roomId);
            }
        }, TIMEOUTS.DAY_VOTING);
    }

    socket.on('vote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.state !== 'day') return;
        const voter = getPlayerBySocket(room, socket);
        if (!voter || !voter.alive) return;
        room.votes[voter.token] = targetId;
        const alive = room.players.filter(p => p.alive);
        io.to(roomId).emit('votesUpdate', { voted: Object.keys(room.votes).length, total: alive.length });
        if (Object.keys(room.votes).length === alive.length) {
            clearTimeout(room.phaseTimer);
            resolveVoting(roomId);
        }
    });

    function tryResolveVoting(roomId) {
        const room = rooms[roomId];
        if (room.state !== 'day') return;
        const alive = room.players.filter(p => p.alive);
        if (Object.keys(room.votes).length === alive.length) {
            clearTimeout(room.phaseTimer);
            resolveVoting(roomId);
        }
    }

    function resolveVoting(roomId) {
        const room = rooms[roomId];
        const voteCount = {};
        let skipVotes = 0;
        Object.values(room.votes).forEach(v => {
            if (v === 'skip') skipVotes++;
            else voteCount[v] = (voteCount[v] || 0) + 1;
        });
        let maxVotes = 0, candidate = null, tie = false;
        Object.entries(voteCount).forEach(([token, count]) => {
            if (count > maxVotes) { maxVotes = count; candidate = token; tie = false; }
            else if (count === maxVotes) tie = true;
        });
        if (tie || maxVotes <= skipVotes) {
            io.to(roomId).emit('votingResult', { expelled: null, message: 'تعادل أو تخطي. لم يُطرد أحد.' });
            room.log.push('التصويت: تعادل أو تخطي.');
        } else {
            const expelled = room.players.find(p => p.token === candidate);
            if (expelled) {
                expelled.alive = false;
                io.to(roomId).emit('votingResult', { expelled: expelled.name, role: expelled.role, message: `${expelled.name} طُرد.` });
                room.log.push(`${expelled.name} (${expelled.role}) طُرد.`);
            }
        }
        if (checkWinCondition(roomId)) return;
        room.round++;
        room.log.push(`--- الجولة ${room.round} ---`);
        io.to(roomId).emit('nextRound', room.round);
        setTimeout(() => startNightPhase(roomId), 3000);
    }

    function advanceIfNightStalled(roomId) {
        const room = rooms[roomId];
        if (!room || room.state !== 'night') return;
        if (room.currentPhase === 'mafia' && room.players.filter(p => p.alive && p.role === ROLES.MAFIA).length === 0) {
            clearTimeout(room.phaseTimer);
            room.currentPhase = 'doctor';
            startDoctorTurn(roomId);
        }
    }

    function checkWinCondition(roomId) {
        const room = rooms[roomId];
        const aliveMafia = room.players.filter(p => p.alive && p.role === ROLES.MAFIA).length;
        const aliveCitizens = room.players.filter(p => p.alive && p.role !== ROLES.MAFIA).length;
        if (aliveMafia === 0) {
            io.to(roomId).emit('gameOver', { winner: 'citizens', message: 'انتصار الأبرياء! تم القضاء على المافيا.' });
            room.state = 'ended';
            return true;
        }
        if (aliveMafia >= aliveCitizens) {
            io.to(roomId).emit('gameOver', { winner: 'mafia', message: 'انتصار المافيا! عددهم يساوي عدد الأبرياء.' });
            room.state = 'ended';
            return true;
        }
        return false;
    }

    // دردشة المافيا
    socket.on('mafiaChatMessage', ({ roomId, message }) => {
        const room = rooms[roomId];
        if (!room) return;
        const sender = getPlayerBySocket(room, socket);
        if (!sender || sender.role !== ROLES.MAFIA || !sender.alive) return;
        room.players.filter(p => p.role === ROLES.MAFIA && p.alive).forEach(p => {
            io.to(p.socketId).emit('mafiaChatMessage', { from: sender.name, message });
        });
    });
});

// ------------------ تشغيل الخادم ------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`السيرفر يعمل على المنفذ ${PORT}`);
    console.log("V1.0.0")
});
