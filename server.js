const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Разрешаем CORS, чтобы Telegram Web App спокойно достукивался до сервера
app.use(cors());
app.use(bodyParser.json());

// Наша импровизированная база данных в памяти сервера
let users = {};

// Список ников, которым разрешен админ-режим (Владельцы)
const OWNERS = ['root', 'tacuv', 'rejew'];

// Вспомогательная функция для генерации дефолтного игрока
function createDefaultUser(userId, username, nickname) {
    return {
        userId: userId,
        username: username || 'player',
        nickname: nickname || 'Игрок',
        balance: 10000, // Даем 10к RJC на старте для теста
        currentCitizenship: 'Без гражданства',
        ownedProperties: [],
        stats: {
            total: 0,
            wins: 0,
            losses: 0
        },
        messages: [] // История входящих переводов
    };
}

// 1. Авторизация / Синхронизация профиля
app.post('/api/user', (req, res) => {
    const { userId, username, nickname } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'Не указан userId' });
    }

    // Если юзера нет в базе — создаем
    if (!users[userId]) {
        users[userId] = createDefaultUser(userId, username, nickname);
    } else {
        // Если зашел старый юзер, просто обновим его ник/юзернейм, если они поменялись в ТГ
        if (username) users[userId].username = username;
        if (nickname && users[userId].nickname === 'Игрок') users[userId].nickname = nickname;
    }

    res.json(users[userId]);
});

// 2. Обработка результатов игр (Слоты и Ракетка)
app.post('/api/game/result', (req, res) => {
    const { userId, bet, winAmount, isWin } = req.body;
    const user = users[userId];

    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.balance < bet) return res.status(400).json({ error: 'Недостаточно коинов на балансе' });

    // Считаем новый баланс: вычитаем ставку, прибавляем выигрыш
    user.balance = user.balance - bet + winAmount;

    // Обновляем стату (только для обычных игроков, у админов на фронте она скрыта)
    user.stats.total += 1;
    if (isWin) {
        user.stats.wins += 1;
    } else {
        user.stats.losses += 1;
    }

    res.json(user);
});

// 3. Покупка в маркете (Паспорта, Тачки, Дома, Яхты)
app.post('/api/buy', (req, res) => {
    const { userId, itemId, itemName, cost, type } = req.body;
    const user = users[userId];

    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.balance < cost) return res.status(400).json({ error: 'Недостаточно средств' });

    // Списание бабок
    user.balance -= cost;

    if (type === 'citizen') {
        user.currentCitizenship = itemName;
    } else {
        // Если итем еще не куплен — добавляем в гараж/имущество
        if (!user.ownedProperties.includes(itemId)) {
            user.ownedProperties.push(itemId);
        }
    }

    res.json(user);
});

// 4. Система безопасных переводов между игроками
app.post('/api/transfer', (req, res) => {
    const { fromUserId, toUserId, amount, comment } = req.body;
    
    const sender = users[fromUserId];
    const receiver = users[toUserId];

    if (!sender) return res.status(404).json({ error: 'Отправитель не найден' });
    if (!receiver) return res.status(404).json({ error: 'Получатель с таким ID не зарегистрирован в боте' });
    if (fromUserId === toUserId) return res.status(400).json({ error: 'Нельзя переводить монеты самому себе' });
    if (sender.balance < amount) return res.status(400).json({ error: 'Недостаточно средств для перевода' });

    // Перекидываем баланс
    sender.balance -= amount;
    receiver.balance += amount;

    // Добавляем уведомление в историю получателя
    receiver.messages.push({
        from: sender.nickname,
        amount: amount,
        comment: comment || 'Без комментария'
    });

    res.json({ success: true });
});

// 5. Админ-панель (Начисление монет элите)
app.post('/api/admin/add', (req, res) => {
    const { adminUserId, targetUserId, amount } = req.body;
    const admin = users[adminUserId];

    if (!admin) return res.status(404).json({ error: 'Админ не найден' });
    
    // Проверка по списку элиты
    const normalizedUser = admin.username.toLowerCase().replace('@', '');
    if (!OWNERS.includes(normalizedUser)) {
        return res.status(403).json({ error: 'Куда руки тянешь? Доступа к админке нет!' });
    }

    const targetUser = users[targetUserId];
    if (!targetUser) return res.status(404).json({ error: 'Целевой пользователь не найден' });

    // Накручиваем баланс
    targetUser.balance += parseInt(amount);

    res.json({ success: true });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер RejewCas запущен на порту ${PORT}`);
});