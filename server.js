const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// НАСТРОЙКА БЕЗЛИМИТНОЙ БАЗЫ SUPABASE
// ==========================================
const SUPABASE_URL = 'https://tponufkikktrosxrgraz.supabase.co';
const SUPABASE_KEY = 'sb_secret_R6cj-LP93g28zplARQu8Ug_iK5-wJNr';

// Ссылка на конкретную строчку с нашим JSON файлом в таблице database
const DB_ENDPOINT = `${SUPABASE_URL}/rest/v1/database?key=eq.users_file`;

let users = {};
let isDirty = false;

// Загрузка базы данных из Supabase при старте или просыпании Render
async function loadDatabase() {
    try {
        const response = await axios.get(DB_ENDPOINT, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            }
        });
        
        if (response.data && response.data.length > 0) {
            users = response.data[0].data || {};
            console.log(`[Supabase DB] Успешно скачано профилей: ${Object.keys(users).length}`);
        } else {
            console.log('[Supabase DB] База пустая в таблице. Инициализируем чистый JSON.');
            users = {};
            isDirty = true;
            await saveDatabaseNow();
        }
    } catch (error) {
        console.error('[Supabase DB] Критическая ошибка подключения:', error.message);
    }
}

// Принудительное сохранение в облако Supabase
async function saveDatabaseNow() {
    try {
        await axios.patch(DB_ENDPOINT, { data: users }, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            }
        });
        isDirty = false;
        console.log('[Supabase DB] Изменения успешно синхронизированы в PostgreSQL!');
    } catch (error) {
        console.error('[Supabase DB] Ошибка сохранения данных:', error.message);
    }
}

function queueSave() {
    isDirty = true;
}

// Проверка авто-сейва каждые 5 секунд
setInterval(async () => {
    if (isDirty) {
        await saveDatabaseNow();
    }
}, 5000);

// Инициализация юзера (принимает любые варианты ID)
function initUser(userId, tgId, username, nickname) {
    const finalId = String(userId || tgId);
    const cleanUsername = String(username || 'player').toLowerCase().replace('@', '').trim();
    
    if (!users[finalId]) {
        users[finalId] = {
            userId: finalId,
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
    } else if (username && users[finalId].username !== cleanUsername) {
        users[finalId].username = cleanUsername;
        queueSave();
    }
    return users[finalId];
}

const PLINKO_MULTIPLIERS = [5.6, 1.6, 1.1, 0.6, 0.3, 0.6, 1.1, 1.6, 5.6];

// ==========================================
// API ЭНДПОИНТЫ
// ==========================================

// Авторизация / Вход юзера
app.post('/api/user', async (req, res) => {
    const { userId, tgId, username, nickname } = req.body;
    const finalId = userId || tgId;
    if (!finalId) return res.status(400).json({ error: "Пустой userId или tgId" });
    
    const user = initUser(userId, tgId, username, nickname);
    res.json(user);
});

// УНИВЕРСАЛЬНЫЙ РАСЧЕТ ИГР (Слоты, Ракетка, Кликер)
app.post('/api/game/result', async (req, res) => {
    const { userId, tgId, bet, winAmount, isWin } = req.body;
    const finalId = String(userId || tgId);
    
    const user = users[finalId];
    if (!user) return res.status(404).json({ error: `Юзер ${finalId} не найден` });

    const intBet = parseInt(bet || 0);
    const intWin = parseInt(winAmount || 0);

    // Считаем новый баланс
    user.balance = user.balance - intBet + intWin;

    // Обновляем стату (для нормальных игр со ставками)
    if (intBet > 0) {
        user.stats.total += 1;
        if (isWin) user.stats.wins += 1; else user.stats.losses += 1;
    }

    queueSave();
    res.json(user);
});

// ПЕРЕВОДЫ REJEWPAY
app.post('/api/rejewpay/transfer', async (req, res) => {
    const { senderId, tgId, receiverUsername, amount } = req.body;
    const finalSenderId = String(senderId || tgId);
    
    const sender = users[finalSenderId];
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

// МАГАЗИН КАЗИНО
app.post('/api/buy', async (req, res) => {
    const { userId, tgId, itemId, itemName, cost, type } = req.body;
    const finalId = String(userId || tgId);
    
    const user = users[finalId];
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
    const { userId, tgId, bet } = req.body;
    const finalId = String(userId || tgId);

    const user = users[finalId];
    if (!user) return res.status(404).json({ error: `Юзер ${finalId} не найден в Плинко` });

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

// АДМИНКА ДЛЯ НАДУВА БАЛАНСА
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
    console.log(` Хранилище переключено на бессмертный Supabase DB`);
    console.log(`==================================================`);
    await loadDatabase();
});
