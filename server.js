const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// БЕССМЕРТНОЕ ОБЛАЧНОЕ JSON ХРАНИЛИЩЕ (ТВОЙ БАКЕТ)
// ==========================================
const KVDB_BUCKET_ID = 'AHkNCjefJ5mgtXCZxuzFq9'; 
const KVDB_URL = `https://kvdb.io/${KVDB_BUCKET_ID}/users_database`;

let users = {};

// Загрузка базы данных из облака при старте или просыпании Render
async function loadDatabase() {
    try {
        const response = await axios.get(KVDB_URL);
        users = response.data || {};
        console.log(`[Облако DB] Успешно скачано профилей: ${Object.keys(users).length}`);
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log('[Облако DB] База пустая, инициализируем чистый JSON.');
            users = {};
            await saveDatabase();
        } else {
            console.error('[Облако DB] Ошибка подключения к kvdb:', error.message);
        }
    }
}

// Сохранение измененного JSON обратно в облако
async function saveDatabase() {
    try {
        await axios.put(KVDB_URL, users);
        console.log('[Облако DB] Изменения успешно перезаписаны в JSON!');
    } catch (error) {
        console.error('[Облако DB] Ошибка при сохранении JSON в облако:', error.message);
    }
}

// Инициализация юзера
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
            messages: [],       // Логи переводов RejewPay
            gameHistory: [],    // Логи игр
            activeCrashRound: null
        };
        saveDatabase(); 
    } else if (username && users[sId].username !== cleanUsername) {
        users[sId].username = cleanUsername;
        saveDatabase();
    }
    return users[sId];
}

const SLOT_ITEMS = ['🍒', '🍋', '🍇', '💎', '7️⃣'];
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

// ПЕРЕВОДЫ REJEWPAY С ПЕРЕЗАПИСЬЮ ЗНАЧЕНИЙ В JSON
app.post('/api/rejewpay/transfer', async (req, res) => {
    const { senderId, receiverUsername, amount, comment } = req.body;
    
    const sender = users[String(senderId)];
    if (!sender) return res.status(404).json({ error: "Отправитель не найден" });
    
    const intAmount = parseInt(amount);
    if (isNaN(intAmount) || intAmount <= 0) return res.status(400).json({ error: "Неверная сумма" });
    if (sender.balance < intAmount) return res.status(400).json({ error: "Недостаточно средств" });

    const cleanReceiverUsername = String(receiverUsername).toLowerCase().replace('@', '').trim();
    const receiver = Object.values(users).find(u => u.username === cleanReceiverUsername);
    
    if (!receiver) return res.status(404).json({ error: `Юзер @${cleanReceiverUsername} не найден` });
    if (sender.userId === receiver.userId) return res.status(400).json({ error: "Нельзя переводить себе" });

    const finalComment = comment && comment.trim().length > 0 ? comment.trim() : "Без комментария";
    const transactionId = `TX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const timestamp = new Date().toISOString();

    // Меняем значения прямо в структуре JSON
    sender.balance -= intAmount;
    receiver.balance += intAmount;

    // Записываем историю перевода внутрь профилей
    const transferLog = {
        id: transactionId, amount: intAmount, comment: finalComment, timestamp,
        senderUsername: sender.username, receiverUsername: receiver.username
    };
    sender.messages.push({ ...transferLog, type: 'transfer_out', partnerNickname: receiver.nickname });
    receiver.messages.push({ ...transferLog, type: 'transfer_in', partnerNickname: sender.nickname });

    // Пушим обновленный JSON в облако
    await saveDatabase();

    res.json({ success: true, newBalance: sender.balance, transactionId });
});

// МАГАЗИН: ИГРОК ПОКУПАЕТ -> СЕРВЕР МЕНЯЕТ ЗНАЧЕНИЯ В JSON
app.post('/api/buy', async (req, res) => {
    const { userId, itemId, itemName, cost, type } = req.body;
    const user = users[String(userId)];
    
    if (!user) return res.status(404).json({ error: "Юзер не найден" });
    const intCost = parseInt(cost);
    if (user.balance < intCost) return res.status(400).json({ error: "Не хватает коинов" });

    // Сервер меняет значения в JSON файле
    user.balance -= intCost;
    if (!user.ownedProperties.includes(itemId)) {
        user.ownedProperties.push(itemId);
    }
    if (type === 'citizen') {
        user.currentCitizenship = itemName;
    }

    user.gameHistory.push({
        game: 'market',
        bet: intCost,
        winAmount: 0,
        isWin: true,
        details: `Покупка товара: ${itemName}`,
        timestamp: new Date().toISOString()
    });

    await saveDatabase();
    res.json(user);
});

// Игры: Слоты (Спины)
app.post('/api/games/slots', async (req, res) => {
    const { userId, bet } = req.body;
    const user = users[String(userId)];
    if (!user) return res.status(404).json({ error: "User not found" });

    const intBet = parseInt(bet);
    if (user.balance < intBet) return res.status(400).json({ error: "Недостаточно средств" });

    let rng = Math.random() * 100;
    let r1, r2, r3, winAmount = 0, isWin = false;

    if (rng < 8.0) { 
        r1 = r2 = r3 = '💎'; winAmount = intBet * 10; isWin = true;
    } else if (rng < 35.0) { 
        r1 = r2 = SLOT_ITEMS[Math.floor(Math.random() * 3)]; r3 = SLOT_ITEMS[4];
        winAmount = Math.floor(intBet * 1.5); isWin = true;
    } else { 
        r1 = '🍒'; r2 = '🍇'; r3 = '7️⃣';
    }

    user.balance = user.balance - intBet + winAmount;
    user.stats.total += 1;
    if (isWin) user.stats.wins += 1; else user.stats.losses += 1;

    await saveDatabase();
    res.json({ r1, r2, r3, winAmount, isWin, newBalance: user.balance });
});

// Игры: Плинко
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
    await saveDatabase();
    
    res.json({ bucketIndex, multiplier, winAmount, newBalance: user.balance });
});

// Админка надува баланса
app.post('/api/admin/add', async (req, res) => {
    const { targetUserId, amount } = req.body;
    const user = users[String(targetUserId)];
    if (!user) return res.status(404).json({ error: "User not found" });
    
    user.balance += parseInt(amount || 0);
    await saveDatabase();
    res.json({ success: true });
});

// Стартуем сервер и качаем базу
app.listen(PORT, async () => {
    console.log(`==================================================`);
    console.log(` Бэк RejewCas успешно запущен на порту: ${PORT}`);
    console.log(` Хранилище подключено к контейнеру: ${KVDB_BUCKET_ID}`);
    console.log(`==================================================`);
    await loadDatabase();
});
