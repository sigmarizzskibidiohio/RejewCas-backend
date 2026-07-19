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

const HOUSE_BONUSES = {
    'p_palace': 5000000, 'p_box': 10, 'p_garage': 30, 'p_baza': 40, 'p_communalka': 90,
    'p_flat_ru': 180, 'p_studio': 550, 'p_dacha': 900, 'p_cyber_village': 1400, 'p_bali': 2300,
    'p_miami': 4800, 'p_dubai': 8200, 'p_blogger_mansion': 13000, 'p_rublevka': 20000,
    'p_courch': 36000, 'p_flanders_hq': 55000, 'p_castle': 110000, 'p_police_hq': 180000,
    'p_penthouse_ny': 260000, 'p_island': 600000, 'p_hamam_resort': 900000, 'p_moon_base': 1100000,
    'p_cyber_palace': 1500000, 'p_bunker': 2000000
};

// Функция валидации Telegram InitData
function verifyTelegramWebAppData(initData, token) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        
        const pairs = [];
        for (const [key, value] of params.entries()) {
            pairs.push(`${key}=${value}`);
        }
        pairs.sort();
        const dataCheckString = pairs.join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

// Middleware для базовой безопасности
function authMiddleware(req, res, next) {
    const initData = req.headers['x-tg-data'];
    
    // Включение bypass режима для локального тестирования (ID 777777 или root)
    if (!initData) {
        const fallbackId = String(req.body.userId || req.body.tgId || req.body.senderId || '');
        if (fallbackId === '777777' || req.body.username === 'root') {
            return next();
        }
        return res.status(401).json({ error: "Требуется авторизация Telegram Mini Apps" });
    }
    
    if (!verifyTelegramWebAppData(initData, BOT_TOKEN)) {
        return res.status(403).json({ error: "Критическая ошибка безопасности: подпись не совпадает" });
    }
    
    try {
        const params = new URLSearchParams(initData);
        req.tgUser = JSON.parse(params.get('user'));
    } catch (e) {
        return res.status(400).json({ error: "Неверный формат данных аккаунта" });
    }
    
    next();
}

async function loadDatabase() {
    try {
        const response = await axios.get(DB_ENDPOINT, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (response.data && response.data.length > 0) {
            users = response.data[0].data || {};
            if (!users._promocodes) users._promocodes = {};
            if (!users._maintenance) users._maintenance = { enabled: false };
            console.log(`[Supabase DB] Успешно скачано профилей: ${Object.keys(users).length}`);
        } else {
            users = { _promocodes: {}, _maintenance: { enabled: false } };
            isDirty = true;
            await saveDatabaseNow();
        }
    } catch (error) {
        console.error('[Supabase DB] Ошибка подключения:', error.message);
    }
}

async function saveDatabaseNow() {
    try {
        await axios.patch(DB_ENDPOINT, { data: users }, {
            headers: {
                'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json', 'Prefer': 'return=minimal'
            }
        });
        isDirty = false;
    } catch (error) {
        console.error('[Supabase DB] Ошибка синхронизации данных:', error.message);
    }
}

function queueSave() { isDirty = true; }

setInterval(async () => { if (isDirty) await saveDatabaseNow(); }, 5000);

function initUser(userId, tgId, username, nickname, referredBy = null) {
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
            stats: { total: 0, wins: 0, losses: 0, totalTurnover: 0 },
            messages: [],       
            gameHistory: [],
            referredBy: (referredBy && String(referredBy) !== finalId) ? String(referredBy) : null,
            rewardedReferrals: [],
            lastBonusClaim: Date.now()
        };
        queueSave(); 
    } else {
        if (username && users[finalId].username !== cleanUsername) {
            users[finalId].username = cleanUsername;
            queueSave();
        }
        // ФИКС РЕФЕРАЛОВ: Если юзер зашёл ранее без рефа, а теперь перешёл по ссылке — привязываем его
        if (!users[finalId].referredBy && referredBy && String(referredBy) !== finalId) {
            users[finalId].referredBy = String(referredBy);
            queueSave();
        }
        if (!users[finalId].stats.totalTurnover) users[finalId].stats.totalTurnover = 0;
        if (!users[finalId].rewardedReferrals) users[finalId].rewardedReferrals = [];
        if (!users[finalId].lastBonusClaim) users[finalId].lastBonusClaim = Date.now();
    }
    return users[finalId];
}

function processDailyPropertyBonus(user) {
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const elapsedDays = Math.floor((now - user.lastBonusClaim) / msPerDay);

    if (elapsedDays > 0) {
        const currentHouseId = user.ownedProperties.find(id => HOUSE_BONUSES[id] !== undefined);
        const dailyRate = currentHouseId ? HOUSE_BONUSES[currentHouseId] : 0;

        if (dailyRate > 0) {
            const totalBonus = dailyRate * elapsedDays;
            user.balance += totalBonus;
            user.messages.push({
                id: `PROP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
                amount: totalBonus, timestamp: new Date().toISOString(),
                type: 'property_bonus', partnerNickname: 'Твоя Недвижка',
                senderUsername: 'SYSTEM', comment: `Ежедневный пассивный доход за ${elapsedDays} дн.`
            });
            queueSave();
        }
        user.lastBonusClaim += elapsedDays * msPerDay;
    }
}

function checkReferralStatus(user) {
    if (user.referredBy && user.stats.totalTurnover >= 2000) {
        const referrer = users[user.referredBy];
        if (referrer) {
            if (!referrer.rewardedReferrals) referrer.rewardedReferrals = [];
            
            if (!referrer.rewardedReferrals.includes(user.userId)) {
                referrer.rewardedReferrals.push(user.userId);
                const refBonus = 5000; 
                referrer.balance += refBonus;
                
                referrer.messages.push({
                    id: `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
                    amount: refBonus, timestamp: new Date().toISOString(),
                    type: 'referral_bonus', partnerNickname: `Реферал ${user.nickname}`,
                    senderUsername: user.username, comment: `Бонус за оборот реферала более 2000 коинов`
                });

                try {
                    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: referrer.userId,
                        text: `🔔 <b>Реферальный бонус!</b>\nТвой реферал @${user.username} набил оборот более 2000 коинов! Тебе начислено +5,000 $RJC.`,
                        parse_mode: 'HTML'
                    }).catch(() => {});
                } catch(e) {}
                queueSave();
            }
        }
    }
}

const PLINKO_MULTIPLIERS = [5.6, 1.6, 1.1, 0.6, 0.3, 0.6, 1.1, 1.6, 5.6];

// Бесконечный бот-поллинг (сообщения)
let lastUpdateId = 0;
async function startBotPolling() {
    while (true) {
        try {
            const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, {
                params: { offset: lastUpdateId + 1, timeout: 20 }, timeout: 25000
            });
            if (response.data && response.data.result) {
                for (const update of response.data.result) {
                    lastUpdateId = update.update_id;
                    if (update.message && update.message.text) {
                        const rawText = update.message.text.trim();
                        const text = rawText.toLowerCase();
                        const chatId = update.message.chat.id;
                        const tgIdStr = String(update.message.from.id);
                        const rawUsername = String(update.message.from.username || '').toLowerCase().replace('@', '');
                        const isAdmin = ['root', 'tacuv', 'rejew'].includes(rawUsername);

                        if (rawText.startsWith('/new ') || rawText.startsWith('/new\n')) {
                            if (!isAdmin) {
                                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `❌ Отказано в доступе.` });
                                continue;
                            }
                            const updateContent = rawText.substring(5).trim();
                            const targetUsers = Object.keys(users).filter(key => !key.startsWith('_'));
                            let successCount = 0;
                            for (const targetId of targetUsers) {
                                try {
                                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                        chat_id: targetId, text: `📢 <b>ОБНОВЛЕНИЕ В REJEWCAS!</b>\n\n${updateContent}`, parse_mode: 'HTML'
                                    });
                                    successCount++;
                                    await new Promise(res => setTimeout(res, 50));
                                } catch (err) {}
                            }
                            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `✅ Доставлено: ${successCount} пользователям.` });
                            continue;
                        }

                        if (['баланс', 'б', 'балик'].includes(text)) {
                            const user = users[tgIdStr] || initUser(tgIdStr, tgIdStr, update.message.from.username, update.message.from.first_name);
                            processDailyPropertyBonus(user);
                            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                chat_id: chatId, parse_mode: 'HTML',
                                text: `<b>💳 Твой баланс:</b> ${user.balance.toLocaleString()} $RJC\n<b>🌍 Гражданство:</b> ${user.currentCitizenship}`
                            });
                        }
                    }
                }
            }
        } catch (error) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// API ЭНДПОИНТЫ
app.post('/api/user', authMiddleware, async (req, res) => {
    const { userId, tgId, username, nickname, referredBy } = req.body;
    const finalId = userId || tgId;
    if (!finalId) return res.status(400).json({ error: "Пустой идентификатор пользователя" });
    
    const user = initUser(userId, tgId, username, nickname, referredBy);
    processDailyPropertyBonus(user);
    
    const isMaintenance = users._maintenance ? users._maintenance.enabled : false;
    res.json({ ...user, maintenanceActive: isMaintenance });
});

// Защита админских эндпоинтов
app.use('/api/admin/*', authMiddleware, (req, res, next) => {
    const username = req.tgUser ? req.tgUser.username : (req.body.username || 'root'); 
    const cleanUsername = String(username || '').toLowerCase().replace('@', '').trim();
    if (!['root', 'tacuv', 'rejew'].includes(cleanUsername)) {
        return res.status(403).json({ error: "Действие разрешено только создателям проекта!" });
    }
    next();
});

app.post('/api/admin/maintenance/toggle', async (req, res) => {
    if (!users._maintenance) users._maintenance = { enabled: false };
    users._maintenance.enabled = !users._maintenance.enabled;
    queueSave();
    res.json({ success: true, maintenanceActive: users._maintenance.enabled });
});

app.post('/api/admin/add', async (req, res) => {
    const { targetUserId, amount } = req.body;
    const user = users[String(targetUserId)];
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });
    user.balance += parseInt(amount || 0);
    queueSave();
    res.json({ success: true });
});

app.post('/api/admin/promo/create', async (req, res) => {
    const { code, limit, reward } = req.body;
    const cleanCode = String(code).trim().toUpperCase();
    if (!cleanCode) return res.status(400).json({ error: "Недопустимое имя промокода" });

    users._promocodes[cleanCode] = {
        code: cleanCode, maxActivations: parseInt(limit) || 1, currentActivations: 0,
        reward: parseInt(reward) || 0, activatedBy: [] 
    };
    queueSave();
    res.json({ success: true });
});

app.post('/api/game/result', authMiddleware, async (req, res) => {
    const { userId, tgId, bet, winAmount, isWin } = req.body;
    const finalId = String(userId || tgId);
    const user = users[finalId];
    if (!user) return res.status(404).json({ error: "Игрок не обнаружен" });

    const intBet = parseInt(bet || 0);
    const intWin = parseInt(winAmount || 0);

    // ЗАЩИТА ОТ НАКРУТКИ КЛИКЕРА (bet === 0)
    if (intBet === 0 && intWin > 0) {
        let allowedClickPower = 1;
        if (user.currentCitizenship.includes('Монако')) allowedClickPower = 250;
        else {
            const citizenCosts = {
                'Египет': 4000, 'Таиланд': 12000, 'Турция': 35000, 'Кипр': 65000, 'Испания': 85000,
                'ОАЭ': 140000, 'Швейцария': 250000, 'Сингапур': 480000, 'Великобритания': 750000,
                'США': 1500000, 'Япония': 3000000, 'Эль-Сальвадор': 4500000, 'Марс': 8000000
            };
            for (const [key, cost] of Object.entries(citizenCosts)) {
                if (user.currentCitizenship.includes(key)) {
                    allowedClickPower = 1 + Math.floor(cost / 800);
                    break;
                }
            }
        }
        // Лимит: максимум 50 тапов за один интервал отправки пакета
        if (intWin > allowedClickPower * 50) {
            return res.status(400).json({ error: "Античит: слишком много коинов за один цикл!" });
        }
    }

    // ЗАЩИТА ДЛЯ КЛИЕНТСКИХ ИГР (Спины, Ракетка)
    if (intBet > 0) {
        if (isWin && intWin > intBet * 105) {
            return res.status(400).json({ error: "Античит: превышен максимальный множитель игры" });
        }
        if (!isWin && intWin !== 0) {
            return res.status(400).json({ error: "Недопустимый формат игрового пакета" });
        }
    }

    user.balance = user.balance - intBet + intWin;

    if (intBet > 0) {
        user.stats.total += 1;
        user.stats.totalTurnover += intBet;
        if (isWin) user.stats.wins += 1; else user.stats.losses += 1;
    }

    checkReferralStatus(user);
    queueSave();
    res.json(user);
});

app.post('/api/games/plinko', authMiddleware, async (req, res) => {
    const { userId, tgId, bet } = req.body;
    const finalId = String(userId || tgId);
    const user = users[finalId];
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });

    const intBet = parseInt(bet);
    if (user.balance < intBet) return res.status(400).json({ error: "Недостаточный баланс" });

    const weights = [3, 8, 14, 20, 25, 20, 14, 8, 3]; 
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let rng = Math.random() * totalWeight;
    
    let bucketIndex = 0;
    for (let i = 0; i < weights.length; i++) {
        if (rng < weights[i]) { bucketIndex = i; break; }
        rng -= weights[i];
    }

    const multiplier = PLINKO_MULTIPLIERS[bucketIndex];
    const winAmount = Math.floor(intBet * multiplier);
    
    user.balance = user.balance - intBet + winAmount;
    user.stats.total += 1;
    user.stats.totalTurnover += intBet;
    if (multiplier >= 1) user.stats.wins += 1; else user.stats.losses += 1;

    checkReferralStatus(user);
    queueSave();
    res.json({ bucketIndex, multiplier, winAmount, newBalance: user.balance });
});

app.post('/api/rejewpay/transfer', authMiddleware, async (req, res) => {
    const { senderId, tgId, receiverUsername, amount, comment } = req.body;
    const finalSenderId = String(senderId || tgId);
    const sender = users[finalSenderId];
    if (!sender) return res.status(404).json({ error: "Отправитель не найден" });
    
    const intAmount = parseInt(amount);
    if (isNaN(intAmount) || intAmount <= 0) return res.status(400).json({ error: "Сумма некорректна" });
    if (sender.balance < intAmount) return res.status(400).json({ error: "Не хватает коинов на балансе" });

    const cleanReceiverUsername = String(receiverUsername).toLowerCase().replace('@', '').trim();
    const receiver = Object.values(users).find(u => u && u.username === cleanReceiverUsername);
    
    if (!receiver) return res.status(404).json({ error: `Игрок @${cleanReceiverUsername} не найден в базе` });
    if (sender.userId === receiver.userId) return res.status(400).json({ error: "Нельзя переводить баланс самому себе" });

    sender.balance -= intAmount;
    receiver.balance += intAmount;

    const transactionId = `TX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const timestamp = new Date().toISOString();

    const transferLog = { id: transactionId, amount: intAmount, timestamp, senderUsername: sender.username, receiverUsername: receiver.username };
    sender.messages.push({ ...transferLog, type: 'transfer_out', partnerNickname: receiver.nickname });
    receiver.messages.push({ ...transferLog, type: 'transfer_in', partnerNickname: sender.nickname });

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: receiver.userId, parse_mode: 'HTML', disable_web_page_preview: true,
            text: `<b>💸 RejewPay: Получен перевод!</b>\n\n<b>👤 От:</b> ${sender.nickname}\n<b>💰 Сумма:</b> ${intAmount.toLocaleString()} $RJC\n<b>💬 Коммент:</b> ${comment ? comment : '<i>нет</i>'}`
        });
    } catch (e) {}

    queueSave(); 
    res.json({ success: true, newBalance: sender.balance });
});

app.post('/api/buy', authMiddleware, async (req, res) => {
    const { userId, itemId, itemName, cost, type } = req.body;
    const user = users[String(userId)];
    if (!user) return res.status(404).json({ error: "Профиль не найден" });
    
    const intCost = parseInt(cost);
    if (user.balance < intCost) return res.status(400).json({ error: "Недостаточно $RJC для покупки" });

    if (itemId === 'p_hamam_resort') {
        if (!user.ownedProperties.includes('p_island')) {
            return res.status(400).json({ error: "Хаммам нельзя купить с нуля. Только улучшить при наличии Личного Атолла!" });
        }
    }

    user.balance -= intCost;
    if (HOUSE_BONUSES[itemId] !== undefined) {
        user.ownedProperties = user.ownedProperties.filter(id => HOUSE_BONUSES[id] === undefined);
    }

    if (!user.ownedProperties.includes(itemId)) user.ownedProperties.push(itemId);
    if (type === 'citizen') user.currentCitizenship = itemName;

    queueSave();
    res.json(user);
});

app.post('/api/promo/activate', authMiddleware, async (req, res) => {
    const { userId, code } = req.body;
    const user = users[String(userId)];
    if (!user) return res.status(404).json({ error: "Авторизуйтесь в приложении" });
    
    const cleanCode = String(code).trim().toUpperCase();
    const promo = users._promocodes[cleanCode];

    if (!promo) return res.status(404).json({ error: "Такого промокода нет!" });
    if (promo.currentActivations >= promo.maxActivations) return res.status(400).json({ error: "Лимит активаций исчерпан!" });
    if (promo.activatedBy.includes(String(userId))) return res.status(400).json({ error: "Промокод уже активирован тобой!" });

    promo.currentActivations += 1;
    promo.activatedBy.push(String(userId));
    user.balance += promo.reward;

    user.messages.push({
        id: `PR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, amount: promo.reward,
        timestamp: new Date().toISOString(), type: 'promo_bonus',
        partnerNickname: 'Промокоды', senderUsername: 'SYSTEM', comment: `Активация: ${cleanCode}`
    });

    queueSave();
    res.json({ success: true, reward: promo.reward, newBalance: user.balance });
});

app.listen(PORT, async () => {
    console.log(`==================================================`);
    console.log(` Бэк RejewCas успешно запущен на порту: ${PORT}`);
    console.log(`==================================================`);
    await loadDatabase();
    startBotPolling(); 
});
