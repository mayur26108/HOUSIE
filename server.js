const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game state storage
const rooms = {};

// Generate a random 6-character room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Generate a valid Housie ticket
function generateTicket() {
    const ticket = [[], [], []];
    const columns = 9;
    const numbersPerRow = 5;
    
    // Column ranges
    const colRanges = [
        [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
        [50, 59], [60, 69], [70, 79], [80, 90]
    ];
    
    // For each row, select 5 columns to fill
    for (let row = 0; row < 3; row++) {
        const selectedCols = [];
        while (selectedCols.length < numbersPerRow) {
            const col = Math.floor(Math.random() * columns);
            if (!selectedCols.includes(col)) {
                selectedCols.push(col);
            }
        }
        selectedCols.sort((a, b) => a - b);
        
        for (let col = 0; col < columns; col++) {
            if (selectedCols.includes(col)) {
                const [min, max] = colRanges[col];
                const num = Math.floor(Math.random() * (max - min + 1)) + min;
                ticket[row][col] = num;
            } else {
                ticket[row][col] = null;
            }
        }
    }
    
    // Ensure no duplicate numbers in the same column across rows
    for (let col = 0; col < columns; col++) {
        const nums = [];
        for (let row = 0; row < 3; row++) {
            if (ticket[row][col] !== null) {
                nums.push(ticket[row][col]);
            }
        }
        
        // Check for duplicates and regenerate if needed
        const uniqueNums = new Set(nums);
        if (uniqueNums.size !== nums.length) {
            // Regenerate this column
            const [min, max] = colRanges[col];
            const available = [];
            for (let i = min; i <= max; i++) {
                available.push(i);
            }
            
            for (let row = 0; row < 3; row++) {
                if (ticket[row][col] !== null) {
                    const idx = available.indexOf(ticket[row][col]);
                    if (idx > -1) available.splice(idx, 1);
                }
            }
            
            for (let row = 0; row < 3; row++) {
                if (ticket[row][col] !== null) {
                    const randIdx = Math.floor(Math.random() * available.length);
                    ticket[row][col] = available[randIdx];
                    available.splice(randIdx, 1);
                }
            }
        }
    }
    
    return ticket;
}

// Check if a row is complete
function isRowComplete(ticket, marked) {
    for (let col = 0; col < 9; col++) {
        if (ticket[row][col] !== null && !marked[row][col]) {
            return false;
        }
    }
    return true;
}

// Check if full house
function isFullHouse(ticket, marked) {
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 9; col++) {
            if (ticket[row][col] !== null && !marked[row][col]) {
                return false;
            }
        }
    }
    return true;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Host creates a room
    socket.on('createRoom', () => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            host: socket.id,
            players: {},
            drawnNumbers: [],
            currentNumber: null,
            gameActive: true,
            winners: [],
            bellClaims: []
        };
        
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
        console.log(`Room created: ${roomCode}`);
    });
    
    // Player joins a room
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = rooms[roomCode];
        
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        if (room.host === socket.id) {
            socket.emit('error', { message: 'You are the host' });
            return;
        }
        
        if (Object.keys(room.players).length >= 90) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }
        
        // Generate unique ticket
        let ticket;
        let attempts = 0;
        do {
            ticket = generateTicket();
            attempts++;
        } while (attempts < 100 && Object.values(room.players).some(p => 
            JSON.stringify(p.ticket) === JSON.stringify(ticket)
        ));
        
        room.players[socket.id] = {
            name: playerName,
            ticket: ticket,
            marked: [[false, false, false, false, false, false, false, false, false],
                     [false, false, false, false, false, false, false, false, false],
                     [false, false, false, false, false, false, false, false, false]],
            joinedAt: Date.now()
        };
        
        socket.join(roomCode);
        
        // Send ticket to player
        socket.emit('ticketAssigned', { 
            ticket: ticket,
            roomCode: roomCode,
            playerName: playerName
        });
        
        // Notify host
        io.to(roomCode).emit('playerJoined', {
            playerId: socket.id,
            playerName: playerName,
            totalPlayers: Object.keys(room.players).length
        });
        
        console.log(`${playerName} joined room ${roomCode}`);
    });
    
    // Host draws a number
    socket.on('drawNumber', (roomCode) => {
        const room = rooms[roomCode];
        
        if (!room || room.host !== socket.id) {
            socket.emit('error', { message: 'Only host can draw numbers' });
            return;
        }
        
        if (!room.gameActive) {
            socket.emit('error', { message: 'Game is over' });
            return;
        }
        
        // Find undrawn numbers
        const undrawn = [];
        for (let i = 1; i <= 90; i++) {
            if (!room.drawnNumbers.includes(i)) {
                undrawn.push(i);
            }
        }
        
        if (undrawn.length === 0) {
            socket.emit('error', { message: 'All numbers drawn' });
            return;
        }
        
        const number = undrawn[Math.floor(Math.random() * undrawn.length)];
        room.drawnNumbers.push(number);
        room.currentNumber = number;
        
        io.to(roomCode).emit('numberDrawn', { 
            number: number, 
            drawnNumbers: room.drawnNumbers 
        });
        
        console.log(`Number drawn: ${number} in room ${roomCode}`);
    });
    
    // Player marks a number
    socket.on('markNumber', ({ roomCode, row, col }) => {
        const room = rooms[roomCode];
        const player = room.players[socket.id];
        
        if (!room || !player) {
            socket.emit('error', { message: 'Invalid room or player' });
            return;
        }
        
        const number = player.ticket[row][col];
        
        if (number === null) {
            socket.emit('error', { message: 'No number at this position' });
            return;
        }
        
        if (!room.drawnNumbers.includes(number)) {
            socket.emit('error', { message: 'Number has not been drawn yet' });
            return;
        }
        
        if (player.marked[row][col]) {
            socket.emit('error', { message: 'Number already marked' });
            return;
        }
        
        player.marked[row][col] = true;
        
        socket.emit('numberMarked', { row, col, number });
        
        // Check for line completion
        let lineComplete = false;
        for (let r = 0; r < 3; r++) {
            let complete = true;
            for (let c = 0; c < 9; c++) {
                if (player.ticket[r][c] !== null && !player.marked[r][c]) {
                    complete = false;
                    break;
                }
            }
            if (complete) {
                lineComplete = true;
                break;
            }
        }
        
        if (lineComplete) {
            socket.emit('lineComplete', { row });
        }
        
        // Check for full house
        if (isFullHouse(player.ticket, player.marked)) {
            socket.emit('fullHouseComplete');
        }
    });
    
    // Player rings bell (claims win)
    socket.on('ringBell', ({ roomCode, claimType }) => {
        const room = rooms[roomCode];
        const player = room.players[socket.id];
        
        if (!room || !player) {
            socket.emit('error', { message: 'Invalid room or player' });
            return;
        }
        
        const claim = {
            playerId: socket.id,
            playerName: player.name,
            claimType: claimType,
            timestamp: Date.now(),
            ticket: player.ticket,
            marked: player.marked
        };
        
        room.bellClaims.push(claim);
        
        // Notify host
        io.to(roomCode).emit('bellRung', claim);
        
        console.log(`${player.name} rang bell for ${claimType} in room ${roomCode}`);
    });
    
    // Host verifies claim
    socket.on('verifyClaim', ({ roomCode, playerId, claimType }) => {
        const room = rooms[roomCode];
        
        if (!room || room.host !== socket.id) {
            socket.emit('error', { message: 'Only host can verify claims' });
            return;
        }
        
        const player = room.players[playerId];
        if (!player) {
            socket.emit('error', { message: 'Player not found' });
            return;
        }
        
        // Verify the claim
        let valid = false;
        
        if (claimType === 'line') {
            for (let row = 0; row < 3; row++) {
                let complete = true;
                for (let col = 0; col < 9; col++) {
                    if (player.ticket[row][col] !== null && !player.marked[row][col]) {
                        complete = false;
                        break;
                    }
                }
                if (complete) {
                    valid = true;
                    break;
                }
            }
        } else if (claimType === 'fullHouse') {
            valid = isFullHouse(player.ticket, player.marked);
        }
        
        if (valid) {
            room.winners.push({
                playerId: playerId,
                playerName: player.name,
                claimType: claimType,
                timestamp: Date.now()
            });
            
            io.to(roomCode).emit('claimVerified', {
                playerId: playerId,
                playerName: player.name,
                claimType: claimType,
                winnerNumber: room.winners.length
            });
            
            // Check if game should end (3 winners for full house)
            if (claimType === 'fullHouse' && room.winners.length >= 3) {
                room.gameActive = false;
                io.to(roomCode).emit('gameOver', { winners: room.winners });
            }
        } else {
            io.to(roomCode).emit('claimRejected', {
                playerId: playerId,
                playerName: player.name,
                claimType: claimType
            });
        }
    });
    
    // Host resets game
    socket.on('resetGame', (roomCode) => {
        const room = rooms[roomCode];
        
        if (!room || room.host !== socket.id) {
            socket.emit('error', { message: 'Only host can reset' });
            return;
        }
        
        room.drawnNumbers = [];
        room.currentNumber = null;
        room.gameActive = true;
        room.winners = [];
        room.bellClaims = [];
        
        // Reset all player marks
        Object.values(room.players).forEach(player => {
            player.marked = [[false, false, false, false, false, false, false, false, false],
                            [false, false, false, false, false, false, false, false, false],
                            [false, false, false, false, false, false, false, false, false]];
        });
        
        io.to(roomCode).emit('gameReset');
        console.log(`Game reset in room ${roomCode}`);
    });
    
    // Get room status (for host)
    socket.on('getRoomStatus', (roomCode) => {
        const room = rooms[roomCode];
        
        if (!room || room.host !== socket.id) {
            socket.emit('error', { message: 'Invalid room' });
            return;
        }
        
        socket.emit('roomStatus', {
            drawnNumbers: room.drawnNumbers,
            currentNumber: room.currentNumber,
            players: Object.entries(room.players).map(([id, player]) => ({
                id: id,
                name: player.name
            })),
            winners: room.winners,
            bellClaims: room.bellClaims,
            gameActive: room.gameActive
        });
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Remove from rooms
        for (const [roomCode, room] of Object.entries(rooms)) {
            if (room.host === socket.id) {
                // Host disconnected, end game
                io.to(roomCode).emit('hostDisconnected');
                delete rooms[roomCode];
            } else if (room.players[socket.id]) {
                delete room.players[socket.id];
                io.to(roomCode).emit('playerLeft', {
                    playerId: socket.id,
                    totalPlayers: Object.keys(room.players).length
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Housie server running on http://localhost:${PORT}`);
});