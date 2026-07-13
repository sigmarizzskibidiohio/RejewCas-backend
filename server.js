const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Временная база данных в оперативе (после перезапуска сервера сбросится)
// Для продакшна потом прикрутишь MongoDB/PostgreSQL, а пока для тестов самое оно
let users = {};

// Массив множителей для Плинко (8 линий = 9 лунок)
const plinkoMultipliers = [5.6, 1.6, 1.1, 0.6, 0.3, 0.6, 1.1, 1.6, 5.6];

// Вспомогательная функция для создания дефолтного юзера
function initUser(userId, username, nickname) {
    if (!users[userId]) {
        users[userId] = {
            userId: String(userId),
            username: String(username || 'player').toLowerCase().replace('@', ''),
            nickname: String(nickname || username || 'Игрок'),
            balance: 5000, // Стартовый капитал
            currentCitizenship: 'Без гражданства',
            ownedProperties: [],
            stats: { total: 0, wins: 0, losses: 0 },
            messages: []
        };
    }
    return users[userId];
}

// 1. Синхронизация и получение профиля
app.post('/api/user', (req, require) => {
    const { userId, username, nickname } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    
    const user = initUser(userId, username, nickname);
    res.json(user);
});

// 2. Обработка Плинко (Честный бэк-обсчет)
app.post('/api/games/plinko', (req, res) => {
    const { tgId, bet } = req.body;
    const user = users[String(tgId)];

    if (!user) return res.status(404).json({ error: "Пользователь не найден" });
    if (isNaN(bet) || bet < 10) return res.status(400).json({ error: "Минимальная ставка — 10 $RJC" });
    if (user.balance < bet) return res.status(400).json({ error: "Недостаточно баланса" });

    // Симулируем 8 рядов колышков. На каждом ряду шарик падает либо влево (0), либо вправо (1)
    let bucketIndex = 0;
    for (let i = 0; i < 8; i++) {
        if (Math.random() > 0.5) {
            bucketIndex++;
        }
    }

    const multiplier = plinkoMultipliers[bucketIndex];
    const winAmount = Math.floor(bet * multiplier);
    
    // Обновляем баланс и стату
    user.balance = user.balance - bet + winAmount;
    user.stats.total += 1;
    if (multiplier >= 1) {
        user.stats.wins += 1;
    } else {
        user.stats.losses += 1;
    }

    res.json({
        bucketIndex: bucketIndex,
        multiplier: multiplier,
        winAmount: winAmount,
        newBalance: user.balance
    });
});

// 3. Обновленная система переводов RejewPay (Поиск по Username)
app.post('/api/rejewpay/transfer', (req, res) => {
    const { senderId, receiverUsername, amount } = req.body;
    
    const sender = users[String(senderId)];
    if (!sender) return res.status(404).json({ error: "Отправитель не авторизован" });
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: "Некорректная сумма перевода" });
    if (sender.balance < amount) return res.status(400).json({ error: "Недостаточно коинов на балансе" });

    const cleanReceiverUsername = String(receiverUsername).toLowerCase().replace('@', '').trim();
    
    // Ищем получателя по его юзернейму в нашей базе
    const receiver = Object.values(users).find(u => u.username === cleanReceiverUsername);
    if (!receiver) {
        return res.status(404).json({ error: `Юзер @${cleanReceiverUsername} еще ни разу не заходил в бота` });
    }

    if (sender.userId === receiver.userId) {
        return res.status(400).json({ error: "Нельзя переводить коины самому себе, не тупи" });
    }

    // Проводим транзакцию
    sender.balance -= amount;
    receiver.balance += amount;

    // Пишем логи в историю обоим участникам
    const txIndex = Date.now();
    
    sender.messages.push({
        id: `tx_${txIndex}_out`,
        amount: amount,
        senderId: sender.userId,
        senderUsername: sender.username,
        receiverUsername: receiver.username,
        partnerNickname: receiver.nickname,
        fromId: sender.userId,
        from: sender.nickname
    });

    receiver.messages.push({
        id: `tx_${txIndex}_in`,
        amount: amount,
        senderId: sender.userId,
        senderUsername: sender.username,
        receiverUsername: receiver.username,
        partnerNickname: sender.nickname,
        fromId: sender.userId,
        from: sender.nickname
    });

    res.json({ success: true, newBalance: sender.balance });
});

// 4. Результаты остальных игр (Слоты, Краш, Кликкер)
app.post('/api/game/result', (req, res) => {
    const { userId, bet, winAmount, isWin } = req.body;
    const user = users[String(userId)];
    
    if (!user) return res.status(404).json({ error: "User not found" });

    if (bet === 0) {
        // Это тупо кликер (майнинг)
        user.balance += winAmount;
    } else {
        // Обычные режимы ставок
        user.balance = user.balance - bet + winAmount;
        user.stats.total += 1;
        if (isWin) user.stats.wins += 1;
        else user.stats.losses += 1;
    }

    res.json(user);
});

// 5. Покупка имущества и паспортов в маркете
app.post('/api/buy', (req, res) => {
    const { userId, itemId, itemName, cost, type } = req.body;
    const user = users[String(userId)];

    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.balance < cost) return res.status(400).json({ error: "Мало золотишка" });

    user.balance -= cost;

    if (type === 'citizen') {
        user.currentCitizenship = itemName;
    } else {
        if (!user.ownedProperties.includes(itemId)) {
            user.ownedProperties.push(itemId);
        }
    }

    res.json(user);
});

// 6. Админ-панель (Накачка баланса)
app.post('/api/admin/add', (req, res) => {
    const { adminUserId, targetUserId, amount } = req.body;
    
    // Проверяем, является ли отправитель админом (дублируем логику фронта)
    const adminUser = users[String(adminUserId)];
    const allowed = ['root', 'tacuv', 'rejew'];
    
    if (!adminUser || !allowed.includes(adminUser.username)) {
        return res.status(403).json({ error: "Куда лезешь? Доступ запрещен." });
    }

    const target = users[String(targetUserId)];
    if (!target) return res.status(404).json({ error: "Целевой юзер не найден" });

    target.balance += parseInt(amount);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Бэкенд RejewCas пашет на порту ${PORT}`);
});
