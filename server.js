const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ТОКЕН ТВОЕГО БОТА
// ==========================================
const BOT_TOKEN = '8700139578:AAHqYBF2TTDHlwgBcgQQ76ekah0pGoqeFj4';

app.use(cors());
app.use(express.json());

// ==========================================
// НАСТРОЙКА БЕЗЛИМИТНОЙ БАЗЫ SUPABASE
// ==========================================
const SUPABASE_URL = 'https://tponufkikktrosxrgraz.supabase.co';
const SUPABASE_KEY = 'sb_secret_R6cj-LP93g28zplARQu8Ug_iK5-wJNr';

const DB_ENDPOINT = `${SUPABASE_URL}/rest/v1/database?key=eq.users_file`;

let users = {};
let isDirty = false;

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

setInterval(async () => {
    if (isDirty) {
        await saveDatabaseNow();
    }
}, 5000);

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
// TELEGRAM BOT POLLING ENGINE (ОБРАБОТКА КОМАНД)
// ==========================================
let lastUpdateId = 0;

async function startBotPolling() {
    console.log("[Telegram Bot] Запуск бесконечного считывания сообщений...");
    while (true) {
        try {
            const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, {
                params: { offset: lastUpdateId + 1, timeout: 20 },
                timeout: 25000
            });
            
            if (response.data && response.data.result) {
                for (const update of response.data.result) {
                    lastUpdateId = update.update_id;
                    
                    if (update.message && update.message.text) {
                        const text = update.message.text.trim().toLowerCase();
                        const chatId = update.message.chat.id;
                        const tgIdStr = String(update.message.from.id);
                        
                        // Проверяем триггеры на баланс
                        if (['баланс', 'б', 'балик'].includes(text)) {
                            // Находим или создаем юзера на лету
                            const user = users[tgIdStr] || initUser(tgIdStr, tgIdStr, update.message.from.username, update.message.from.first_name);
                            
                            const messageText = `<b>💳 Твой игровой баланс:</b> ${user.balance.toLocaleString()} $RJC\n` +
                                                `<b>🌍 Гражданство:</b> ${user.currentCitizenship}`;
                            
                            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                chat_id: chatId,
                                text: messageText,
                                parse_mode: 'HTML'
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.error("[Telegram Bot Polling Error]:", error.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// ==========================================
// API ЭНДПОИНТЫ
// ==========================================

app.post('/api/user', async (req, res) => {
    const { userId, tgId, username, nickname } = req.body;
    const finalId = userId || tgId;
    if (!finalId) return res.status(400).json({ error: "Пустой userId или tgId" });
    
    const user = initUser(userId, tgId, username, nickname);
    res.json(user);
});

app.post('/api/game/result', async (req, res) => {
    const { userId, tgId, bet, winAmount, isWin } = req.body;
    const finalId = String(userId || tgId);
    
    const user = users[finalId];
    if (!user) return res.status(404).json({ error: `Юзер ${finalId} не найден` });

    const intBet = parseInt(bet || 0);
    const intWin = parseInt(winAmount || 0);

    user.balance = user.balance - intBet + intWin;

    if (intBet > 0) {
        user.stats.total += 1;
        if (isWin) user.stats.wins += 1; else user.stats.losses += 1;
    }

    queueSave();
    res.json(user);
});

app.post('/api/rejewpay/transfer', async (req, res) => {
    const { senderId, tgId, receiverUsername, amount, comment } = req.body;
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

    try {
        const tgProfileLink = `tg://user?id=${sender.userId}`;
        const messageText = `<b>💸 Новый перевод в RejewPay!</b>\n\n` +
                            `<b>👤 Отправитель:</b> <a href="${tgProfileLink}">${sender.nickname}</a>\n` +
                            `<b>💰 Сумма:</b> ${intAmount.toLocaleString()} $RJC\n` +
                            `<b>💬 Комментарий:</b> ${comment ? comment : '<i>Без комментария</i>'}`;

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: receiver.userId,
            text: messageText,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (e) {
        console.error("Бот не смог отправить уведомление в ТГ:", e.message);
    }

    queueSave(); 
    res.json({ success: true, newBalance: sender.balance });
});

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
    console.log(` Хранилище синхронизировано с Supabase DB`);
    console.log(`==================================================`);
    await loadDatabase();
    startBotPolling(); // Запуск лонг-поллинга ТГ
});
