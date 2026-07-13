const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// БЕССМЕРТНОЕ ОБЛАЧНОЕ JSON ХРАНИЛИЩЕ (KVDB.IO)
// ==========================================
const KVDB_BUCKET_ID = '5mTLLiyYaFAK8D3K2o2PyP'; 
const KVDB_URL = `https://kvdb.io/${KVDB_BUCKET_ID}/db_file`;

let users = {};
let isDirty = false; 

async function loadDatabase() {
    try {
        const response = await axios.get(KVDB_URL);
        users = response.data || {};
        console.log(`[Облако DB] Успешно скачано профилей: ${Object.keys(users).length}`);
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log('[Облако DB] База пустая. Инициализируем чистый JSON.');
            users = {};
            isDirty = true;
            await saveDatabaseNow();
        } else {
            console.error('[Облако DB] Ошибка подключения к kvdb:', error.message);
        }
    }
}

async function saveDatabaseNow() {
    try {
        await axios.put(KVDB_URL, users, {
            headers: { 'Content-Type': 'application/json' }
        });
        isDirty = false;
        console.log('[Облако DB] Изменения успешно перезаписаны в JSON на kvdb.io!');
    } catch (error) {
        console.error('[Облако DB] Ошибка сохранения данных в облако:', error.message);
    }
}

function queueSave() {
    isDirty = true;
}

setInterval(async () => {
    if (isDirty) {
        await saveDatabaseNow();
    }
}, 5000);

function initUser(userId, username, nickname) {
    const sId = String(userId);
    const cleanUsername = String(username || 'player').toLowerCase().replace('@', '').trim();
    
    if (!users[sId]) {
        users[sId] = {
            userId: sId,
            username: cleanUsername,
            nickname: String(nickname || username || 'Игрок'),
            balance: 5000,
            currentCitizenship: 'Без гражданства',
            ownedProperties: [],
            stats: { total: 0, wins: 0, losses: 0 },
            messages: [],       
            gameHistory: []
        };
        queueSave(); 
    } else if (username && users[sId].username !== cleanUsername) {
        users[sId].username = cleanUsername;
        queueSave();
    }
    return users[sId];
}

const PLINKO_MULTIPLIERS = [5.6, 1.6, 1.1, 0.6, 0.3, 0.6, 1.1, 1.6, 5.6];

// ==========================================
// API ЭНДПОИНТЫ
// ==========================================

app.post('/api/user', async (req, res) => {
    const { userId, username, nickname } = req.body;
    if (!userId) return res.status(400).json({ error: "Пустой userId" });
    
    const user = initUser(userId, username, nickname);
    res.json(user);
});

// ТОТ САМЫЙ КРИТИЧЕСКИЙ ЭНДПОИНТ ДЛЯ СЛОТОВ, КЛИКЕРА И РАКЕТКИ
app.post('/api/game/result', async (req, res) => {
    const { userId, bet, winAmount, isWin } = req.body;
    const user = users[String(userId)];
    if (!user) return res.status(404).json({ error: "Юзер не найден" });

    const intBet = parseInt(bet || 0);
    const intWin = parseInt(winAmount || 0);

    // Обновляем баланс игрока
    user.balance = user.balance - intBet + intWin;

    // Считаем стату (кликер с bet: 0 не учитываем в лудоманскую статистику)
    if (intBet > 0) {
        user.stats.total += 1;
        if (isWin) user.shadow = user.stats.wins += 1; else user.stats.losses += 1;
    }

    queueSave();
    res.json(user);
});

// ПЕРЕВОДЫ REJEWPAY
app.post('/api/rejewpay/transfer', async (req, res) => {
    const { senderId, receiverUsername, amount } = req.body;
    
    const sender = users[String(senderId)];
    if (!sender) return res.status(404).json({ error: "Отправитель не найден" });
    
    const intAmount = parseInt(amount);
    if (isNaN(intAmount) || intAmount <= 0) return res.status(400).json({ error: "Неверная сумма" });
    if (sender.balance < intAmount) return res.status(400).json({ error: "Недостаточно средств" });

    const cleanReceiverUsername = String(receiverUsername).toLowerCase().replace('@', '').trim();
    const receiver = Object.values(users).find(u => u.username === cleanReceiverUsername);
    
    if (!receiver) return res.status(404).json({ error: `Юзер @${cleanReceiverUsername} не найден` });
    if (sender.userId === receiver.userId) return res.status(400).json({ error: "Нельзя переводить себе" });

    sender.balance -= intAmount;
    receiver.balance += intAmount;

    const transactionId = `TX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const timestamp = new Date().toISOString();

    const transferLog = {
        id: transactionId, amount: intAmount, timestamp,
        senderUsername: sender.username, receiverUsername: receiver.username
    };
    sender.messages.push({ ...transferLog, type: 'transfer_out', partnerNickname: receiver.nickname });
    receiver.messages.push({ ...transferLog, type: 'transfer_in', partnerNickname: sender.nickname });

    queueSave(); 
    res.json({ success: true, newBalance: sender.balance });
});

// МАРКЕТ
app.post('/api/buy', async (req, res) => {
    const { userId, itemId, itemName, cost, type } = req.body;
    const user = users[String(userId)];
    
    if (!user) return res.status(404).json({ error: "Юзер не найден" });
    const intCost = parseInt(cost);
    if (user.balance < intCost) return res.status(400).json({ error: "Не хватает коинов" });

    user.balance -= intCost;
    if (!user.ownedProperties.includes(itemId)) {
        user.ownedProperties.push(itemId);
    }
    if (type === 'citizen') {
        user.currentCitizenship = itemName;
    }

    queueSave();
    res.json(user);
});

// ПЛИНКО
app.post('/api/games/plinko', async (req, res) => {
    const { tgId, bet } = req.body;
    const user = users[String(tgId)];
    if (!user) return res.status(404).json({ error: "User not found" });

    const intBet = parseInt(bet);
    if (user.balance < intBet) return res.status(400).json({ error: "Недостаточно баланса" });

    let bucketIndex = 0;
    for (let i = 0; i < 8; i++) { if (Math.random() > 0.5) bucketIndex++; }
    const multiplier = PLINKO_MULTIPLIERS[bucketIndex];
    const winAmount = Math.floor(intBet * multiplier);
    
    user.balance = user.balance - intBet + winAmount;
    queueSave();
    
    res.json({ bucketIndex, multiplier, winAmount, newBalance: user.balance });
});

// АДМИНКА
app.post('/api/admin/add', async (req, res) => {
    const { targetUserId, amount } = req.body;
    const user = users[String(targetUserId)];
    if (!user) return res.status(404).json({ error: "User not found" });
    
    user.balance += parseInt(amount || 0);
    queueSave();
    res.json({ success: true });
});

app.listen(PORT, async () => {
    console.log(`==================================================`);
    console.log(` Бэк RejewCas успешно запущен на порту: ${PORT}`);
    console.log(` База данных привязана к ключу: ${KVDB_BUCKET_ID}`);
    console.log(`==================================================`);
    await loadDatabase();
});
