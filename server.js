require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = '/data/shop.json';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ---------- Storage (JSON) ----------
function readDB() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(data.phones)) data.phones = [];
    if (!Array.isArray(data.reviews)) data.reviews = [];
    if (!data.nextId) data.nextId = data.phones.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
    if (!data.nextReviewId) data.nextReviewId = data.reviews.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

    data.phones.forEach(p => {
      if (p.views === undefined) p.views = 0;
      if (p.orders === undefined) p.orders = 0;
      if (p.is_hit === undefined) p.is_hit = false;
    });

    return data;
  } catch {
    return { phones: [], reviews: [], nextId: 1, nextReviewId: 1 };
  }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---------- Telegram ----------
async function notify(text) {
  if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.CHAT_ID, text, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) return `Ошибка Telegram: ${data.description}`;
    return null;
  } catch (e) {
    return 'Ошибка соединения с Telegram.';
  }
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STATUSES = ['available', 'reserved', 'sold'];

// ---------- Auth ----------
function auth(req, res, next) {
  if (!process.env.ADMIN_PASSWORD || req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Неверный пароль' });
  }
  next();
}

// ============================================================
//                         PUBLIC API
// ============================================================
app.get('/api/phones', (req, res) => {
  res.json(readDB().phones);
});

app.get('/api/reviews', (req, res) => {
  const db = readDB();
  const approved = db.reviews.filter(r => r.approved === true).sort((a,b) => b.id - a.id);
  res.json(approved);
});

app.post('/api/review', async (req, res) => {
  const { name, text, rating, phone_model } = req.body || {};
  if (!name || !text) return res.status(400).json({ ok: false, error: 'Заполните имя и текст' });

  const db = readDB();
  const review = {
    id: db.nextReviewId++,
    name: String(name).slice(0, 50),
    text: String(text).slice(0, 500),
    rating: Math.min(5, Math.max(1, Number(rating) || 5)),
    phone_model: String(phone_model || '').slice(0, 100),
    approved: false,
    created_at: new Date().toISOString()
  };
  db.reviews.push(review);
  writeDB(db);

  await notify(
    `🌟 <b>Новый отзыв!</b>\n\n` +
    `👤 <b>Имя:</b> ${esc(name)}\n` +
    `📱 <b>Товар:</b> ${esc(phone_model) || 'Не указан'}\n` +
    `⭐ <b>Оценка:</b> ${review.rating}/5\n` +
    `💬 <b>Текст:</b> ${esc(text)}\n\n` +
    `<i>Зайдите в админку, чтобы опубликовать его.</i>`
  );

  res.json({ ok: true });
});

app.post('/api/phone/:id/view', (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  const phone = db.phones.find(p => p.id === id);
  if (phone) {
    phone.views = (phone.views || 0) + 1;
    writeDB(db);
  }
  res.json({ ok: true });
});

app.post('/api/order', async (req, res) => {
  const { phone_id, name, contact, message, type } = req.body || {};
  if (!name || !contact) return res.status(400).json({ ok: false, error: 'Заполните имя и контакт' });

  let finalContact = contact.trim();
  if (finalContact && !finalContact.startsWith('+') && !/^\d+$/.test(finalContact) && !finalContact.startsWith('@')) {
    finalContact = '@' + finalContact;
  }

  const db = readDB();
  const phone = phone_id ? db.phones.find(p => p.id === Number(phone_id)) : null;

  if (phone && type !== 'notify') {
    phone.orders = (phone.orders || 0) + 1;
    writeDB(db);
  }

  const phoneLine = phone
    ? `<b>${esc(phone.brand)} ${esc(phone.model)}</b>\n💰 Цена: ${Number(phone.price).toLocaleString('ru-RU')} ₽`
    : '<i>Общий запрос</i>';

  let title = '🛒 <b>Новая заявка</b>';
  let extraLine = '';

  if (type === 'notify') {
    title = '🔔 <b>Запрос на уведомление</b>';
    extraLine = '\n<i>(Клиент ждет поступления этого товара)</i>';
  }

  const err = await notify(
    `${title}\n\n` +
    `📱 ${phoneLine}${extraLine}\n\n` +
    `👤 <b>Имя:</b> ${esc(name)}\n` +
    `📞 <b>Контакт:</b> ${esc(finalContact)}\n` +
    `📝 <b>Комментарий:</b> ${esc(message) || '—'}\n\n` +
    `🕒 ${new Date().toLocaleString('ru-RU')}`
  );

  if (err) return res.status(500).json({ ok: false, error: err });
  res.json({ ok: true });
});

// ============================================================
//                        ADMIN API
// ============================================================
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Неверный пароль' });
});

app.get('/api/admin/reviews', auth, (req, res) => {
  res.json(readDB().reviews.reverse());
});

app.put('/api/admin/reviews/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  const idx = db.reviews.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найдено' });

  db.reviews[idx] = { ...db.reviews[idx], ...req.body };
  writeDB(db);
  res.json({ ok: true });
});

app.delete('/api/admin/reviews/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  db.reviews = db.reviews.filter(r => r.id !== id);
  writeDB(db);
  res.json({ ok: true });
});

app.post('/api/admin/phones', auth, async (req, res) => {
  const { brand, model, storage, color, price, old_price, discount_ends, condition, description, images, battery, kit, sim, imei, is_hit } = req.body || {};
  if (!brand || !model || !price) return res.status(400).json({ ok: false, error: 'Заполните бренд, модель и цену' });

  let finalPrice = Number(price);
  let finalOldPrice = null;
  let finalDiscountEnds = null;

  if (old_price && Number(old_price) > Number(price)) {
    finalOldPrice = Number(old_price);
    finalDiscountEnds = discount_ends || null;
  }

  const db = readDB();
  const phone = {
    id: db.nextId++,
    brand: String(brand).slice(0, 100),
    model: String(model).slice(0, 100),
    storage: storage || '',
    color: color || '',
    price: finalPrice,
    old_price: finalOldPrice,
    discount_ends: finalDiscountEnds,
    condition: condition || 'Новый',
    description: description || '',
    images: Array.isArray(images) ? images : [],
    battery: battery || '',
    kit: kit || '',
    sim: sim || '',
    imei: imei || '',
    is_hit: is_hit === true,
    status: 'available',
    views: 0,
    orders: 0,
    created_at: new Date().toISOString()
  };
  db.phones.unshift(phone);
  writeDB(db);

  await notify(`➕ <b>Добавлен товар</b>\n📱 ${esc(brand)} ${esc(model)}\n💰 Цена: ${Number(price).toLocaleString('ru-RU')} ₽`);
  res.json({ ok: true, id: phone.id });
});

app.put('/api/admin/phones/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  const idx = db.phones.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найдено' });

  const prev = db.phones[idx];
  const updated = { ...prev, ...req.body, id, price: Number(req.body.price || prev.price) };
  if (!STATUSES.includes(updated.status)) updated.status = prev.status;

  if (updated.old_price && Number(updated.old_price) > updated.price) {
    updated.old_price = Number(updated.old_price);
    updated.discount_ends = req.body.discount_ends || updated.discount_ends || null;
  } else {
    updated.old_price = null;
    updated.discount_ends = null;
  }

  db.phones[idx] = updated;
  writeDB(db);

  if (updated.status !== prev.status) {
    const labels = { available: 'В наличии', reserved: 'Забронировано', sold: 'Продано' };
    let msg = `🔄 <b>Статус изменен</b>\n📱 ${esc(updated.brand)} ${esc(updated.model)}\n📌 ${labels[prev.status]} → ${labels[updated.status]}`;

    if (updated.status === 'sold') {
      msg += `\n\n🎉 <b>Поздравляю с продажей!</b>\nНе забудьте попросить клиента оставить отзыв на сайте.`;
    }

    await notify(msg);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/phones/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  db.phones = db.phones.filter(p => p.id !== id);
  writeDB(db);
  res.json({ ok: true });
});

// ============================================================
//                     HTML PAGES
// ============================================================

const indexHTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iPhone | Shop — премиальная техника</title>
<link rel="icon" type="image/png" href="/logo.png">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { 
    --bg: #fbfbfd; --card: #ffffff; --text: #1d1d1f; --muted: #86868b;
    --border: #d2d2d7; --accent: #0071e3; --red: #ff3b30;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  
  input[type=number]::-webkit-inner-spin-button, 
  input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input[type=number] { -moz-appearance: textfield; }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 10px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: #a8a8a8; }

  body { 
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
    background: var(--bg); color: var(--text); line-height: 1.5; 
    -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; min-height: 100vh;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; width: 100%; }
  
  header { background: rgba(251, 251, 253, 0.8); backdrop-filter: blur(20px); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 50; }
  .header-inner { display: flex; align-items: center; justify-content: center; height: 72px; }
  
  .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; cursor: default; display: flex; align-items: center; gap: 12px; }
  .logo img { height: 42px; width: auto; object-fit: contain; }

  .hero { text-align: center; padding: 80px 0 48px; background: radial-gradient(circle at 50% 0%, #ffffff 0%, #fbfbfd 100%); }
  .hero h1 { font-size: clamp(36px, 5vw, 56px); font-weight: 800; letter-spacing: -0.04em; margin-bottom: 12px; line-height: 1.1; }
  .hero p { color: var(--muted); font-size: 19px; font-weight: 400; }
  
  .filters { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-bottom: 48px; }
  .filter { padding: 10px 24px; border-radius: 100px; border: 1px solid var(--border); background: transparent; color: var(--text); font-size: 15px; font-weight: 500; cursor: pointer; transition: all .2s; font-family: inherit; }
  .filter:hover { background: rgba(0,0,0,0.04); }
  .filter.active { background: var(--text); border-color: var(--text); color: #fff; }
  
  .filter[data-status="discounted"] { color: var(--red); border-color: rgba(255,59,48,0.3); }
  .filter.active[data-status="discounted"] { background: var(--red); border-color: var(--red); color: #fff; }
  
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 32px; padding-bottom: 80px; }
  .card { background: var(--card); border-radius: 24px; overflow: hidden; border: 1px solid var(--border); transition: all .4s cubic-bezier(0.16, 1, 0.3, 1); display: flex; flex-direction: column; cursor: pointer; position: relative; }
  .card:hover { transform: translateY(-8px); box-shadow: 0 30px 60px rgba(0,0,0,0.08); border-color: transparent; }
  
  .card.sold .card-img img { filter: grayscale(100%) opacity(0.7); }
  .card.sold .card-title { color: var(--muted); }
  .card.sold .price { color: var(--muted); }

  .card-img { aspect-ratio: 4/5; background: #f5f5f7; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .card-img img { width: 100%; height: 100%; object-fit: cover; transition: transform .6s ease; }
  .card:hover .card-img img { transform: scale(1.04); }
  .card-img svg { width: 64px; height: 64px; color: var(--border); }
  
  .status { position: absolute; top: 16px; right: 16px; padding: 8px 16px; border-radius: 100px; font-size: 13px; font-weight: 700; z-index: 2; box-shadow: 0 4px 12px rgba(0,0,0,0.08); display: inline-flex; align-items: center; justify-content: center; }
  .status.available { background: rgba(255, 255, 255, 0.95); color: #1a7f37; border: 1px solid rgba(26, 127, 55, 0.2); }
  .status.reserved  { background: rgba(255, 255, 255, 0.95); color: #b05e00; border: 1px solid rgba(176, 94, 0, 0.2); }
  .status.sold      { background: rgba(255, 255, 255, 0.95); color: #b0251f; border: 1px solid rgba(176, 37, 31, 0.2); }

  .hit-badge { position: absolute; top: 16px; left: 16px; background: var(--text); color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 800; z-index: 2; box-shadow: 0 4px 12px rgba(0,0,0,0.2); text-transform: uppercase; letter-spacing: 0.5px; }
  
  .card-body { padding: 28px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .card-title { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .card-meta { color: #515154; font-size: 15px; font-weight: 500; }
  
  .trust-badges { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 8px 0; }
  .trust-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); background: #f5f5f7; padding: 4px 8px; border-radius: 6px; font-weight: 500; }
  .trust-badge svg { width: 14px; height: 14px; color: #1a7f37; }

  .card-footer { display: flex; align-items: flex-end; justify-content: space-between; margin-top: auto; padding-top: 12px; }
  
  .price-wrap { display: flex; flex-direction: column; gap: 2px; }
  .price-row { display: flex; align-items: center; gap: 6px; }
  .price-old { font-size: 14px; color: var(--muted); text-decoration: line-through; font-weight: 500; }
  .discount-percent-inline { background: var(--red); color: #fff; font-size: 11px; font-weight: 800; padding: 2px 6px; border-radius: 4px; }
  .price { font-size: 26px; font-weight: 800; letter-spacing: -0.03em; }
  .price.discounted { color: var(--red); }
  .timer-label { font-size: 11px; color: var(--red); font-weight: 600; margin-top: 4px; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  
  .btn { border: none; border-radius: 14px; padding: 12px 24px; font-size: 15px; font-weight: 600; cursor: pointer; background: var(--text); color: #fff; transition: all .2s; font-family: inherit; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: #000; transform: scale(1.02); }
  .btn:disabled { background: #e5e5ea; color: #86868b; cursor: not-allowed; transform: none; }
  
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); font-size: 18px; }

  /* Отзывы */
  .reviews-section { padding: 80px 0; background: #fff; border-top: 1px solid var(--border); }
  .reviews-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
  .reviews-title { font-size: 32px; font-weight: 800; letter-spacing: -0.03em; }
  .reviews-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 24px; }
  .review-card { background: var(--bg); padding: 24px; border-radius: 20px; border: 1px solid var(--border); display: flex; flex-direction: column; gap: 12px; }
  .review-header { display: flex; justify-content: space-between; align-items: center; }
  .review-author { font-weight: 700; font-size: 16px; }
  
  .stars-wrap { display: inline-flex; gap: 2px; color: #ffb400; }
  .stars-wrap svg { width: 16px; height: 16px; }

  .review-model { font-size: 13px; color: var(--accent); font-weight: 500; }
  .review-text { font-size: 14px; color: #444; line-height: 1.5; font-style: italic; }
  .review-date { font-size: 12px; color: var(--muted); margin-top: auto; }

  /* Недавно просмотренные */
  .recent-section { padding-bottom: 80px; display: none; }
  .recent-header { margin-bottom: 24px; }
  .recent-title { font-size: 24px; font-weight: 800; letter-spacing: -0.03em; margin: 0; }
  
  .recent-grid { display: flex; gap: 20px; overflow-x: auto; padding-bottom: 20px; scroll-snap-type: x mandatory; scroll-behavior: smooth; }
  .recent-grid::-webkit-scrollbar { height: 6px; }
  .recent-card { min-width: 240px; max-width: 240px; scroll-snap-align: start; }
  .recent-card .card-img { aspect-ratio: 1; }
  .recent-card .card-body { padding: 16px; }
  .recent-card .card-title { font-size: 16px; }
  .recent-card .price { font-size: 20px; }
  .recent-card .btn { padding: 8px 12px; font-size: 13px; }
  .recent-card .status { top: 10px; right: 10px; font-size: 11px; padding: 6px 10px; }
  .recent-card .hit-badge { top: 10px; left: 10px; font-size: 11px; padding: 4px 8px; }
  .recent-card .trust-badges { display: none; }
  .recent-card .timer-label { display: none; }

  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(12px); display: none; align-items: center; justify-content: center; padding: 20px; z-index: 100; opacity: 0; transition: opacity .3s ease; }
  .modal-overlay.open { display: flex; opacity: 1; }
  .modal { background: #fff; border-radius: 32px; width: 100%; animation: pop .4s cubic-bezier(0.16, 1, 0.3, 1); position: relative; overflow: hidden; }
  @keyframes pop { from { transform: scale(0.95) translateY(20px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }
  
  .detail-modal { max-width: 1000px; display: flex; flex-direction: column; max-height: 90vh; }
  @media(min-width: 768px) { .detail-modal { flex-direction: row; } }
  
  .detail-img-container { flex: 1.2; background: #f5f5f7; display: flex; flex-direction: column; min-height: 400px; }
  .detail-main-img { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
  .detail-main-img img { width: 100%; height: 100%; object-fit: cover; position: absolute; inset: 0; }
  .detail-main-img svg { width: 120px; height: 120px; color: var(--border); }
  
  .detail-thumbnails { display: flex; gap: 10px; padding: 16px; overflow-x: auto; background: #fff; border-top: 1px solid var(--border); }
  .detail-thumb { width: 60px; height: 60px; border-radius: 8px; object-fit: cover; cursor: pointer; border: 2px solid transparent; transition: border-color .2s; }
  .detail-thumb:hover, .detail-thumb.active { border-color: var(--accent); }

  .detail-content { flex: 1; padding: 48px; display: flex; flex-direction: column; overflow-y: auto; }
  .detail-close { position: absolute; top: 24px; right: 24px; width: 40px; height: 40px; border-radius: 50%; border: none; background: rgba(0,0,0,0.05); color: var(--text); font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .2s; z-index: 10; }
  .detail-close:hover { background: rgba(0,0,0,0.1); }
  .detail-title { font-size: 32px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.03em; line-height: 1.2; }
  .detail-meta { color: var(--muted); font-size: 16px; margin-bottom: 32px; }
  
  .specs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; background: #fbfbfd; padding: 24px; border-radius: 20px; border: 1px solid var(--border); }
  .spec-item { display: flex; flex-direction: column; gap: 4px; }
  .spec-label { font-size: 13px; color: var(--muted); font-weight: 500; }
  .spec-value { font-size: 15px; font-weight: 600; }
  
  .detail-desc { font-size: 16px; color: #333; line-height: 1.6; margin-bottom: 32px; white-space: pre-wrap; }
  
  .detail-trust-badges { display: flex; gap: 12px; margin-bottom: 32px; flex-wrap: wrap; }
  .detail-trust-badges .trust-badge { font-size: 14px; padding: 8px 12px; background: #fff; border: 1px solid var(--border); box-shadow: 0 2px 8px rgba(0,0,0,0.02); }
  .detail-trust-badges .trust-badge svg { width: 16px; height: 16px; }

  .detail-bottom { margin-top: auto; border-top: 1px solid var(--border); padding-top: 32px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .detail-price-wrap { display: flex; flex-direction: column; }
  .detail-price-old { font-size: 18px; color: var(--muted); text-decoration: line-through; margin-bottom: 4px; }
  .detail-price { font-size: 36px; font-weight: 800; letter-spacing: -0.03em; }
  .detail-price.discounted { color: var(--red); }
  
  .order-modal, .review-modal { max-width: 460px; padding: 40px; }
  .order-modal h2, .review-modal h2 { font-size: 28px; margin-bottom: 8px; font-weight: 800; letter-spacing: -0.02em; }
  .order-modal p, .review-modal p { color: var(--muted); font-size: 15px; margin-bottom: 24px; }
  
  .deposit-note { font-size: 12px; color: #b05e00; background: #fff7ed; padding: 10px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ffe8cc; display: flex; align-items: center; gap: 6px; }
  .deposit-note svg { width: 16px; height: 16px; }

  .input-group { margin-bottom: 20px; }
  .input-group label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--text); }
  .input-group input, .input-group textarea { width: 100%; padding: 16px; border: 1px solid var(--border); border-radius: 14px; font-size: 16px; font-family: inherit; outline: none; transition: border-color .2s; background: #fafafa; }
  .input-group input:focus, .input-group textarea:focus { border-color: var(--text); background: #fff; }
  
  /* КРАСИВЫЙ РЕЙТИНГ ЗВЕЗДАМИ (БЕЗ ГЛЮКОВ) */
  .star-rating { display: flex; gap: 8px; margin-top: 4px; }
  .star-rating .star { cursor: pointer; color: #d2d2d7; }
  .star-rating .star svg { width: 32px; height: 32px; fill: transparent; stroke: currentColor; stroke-width: 2; pointer-events: none; }
  .star-rating .star.active { color: #ffb400; }
  .star-rating .star.active svg { fill: #ffb400; stroke: #ffb400; }

  .order-modal .btn, .review-modal .btn { width: 100%; margin-top: 8px; padding: 18px; font-size: 17px; }
  .modal-msg { margin-top: 20px; padding: 14px; border-radius: 12px; font-size: 15px; text-align: center; display: none; font-weight: 500; }
  .modal-msg.ok { display: block; background: #e8f5e9; color: #1a7f37; }
  .modal-msg.err { display: block; background: #ffebee; color: #b0251f; }

  .info-modal { max-width: 500px; padding: 40px; }
  .info-modal h2 { font-size: 24px; margin-bottom: 24px; font-weight: 800; letter-spacing: -0.02em; }
  .info-modal #info-text { margin-bottom: 24px; }
  .info-modal .btn { width: 100%; }
  
  .faq-item { margin-bottom: 20px; }
  .faq-item:last-child { margin-bottom: 0; }
  .faq-q { font-weight: 700; font-size: 16px; margin-bottom: 6px; color: var(--text); }
  .faq-a { font-size: 15px; color: #444; line-height: 1.5; }
  .info-text-block { font-size: 16px; color: #444; line-height: 1.6; }

  footer { background: #f5f5f7; border-top: 1px solid var(--border); padding: 64px 0 32px; margin-top: auto; }
  .footer-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 40px; margin-bottom: 48px; }
  .footer-col h4 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text); }
  .footer-col ul { list-style: none; }
  .footer-col li { margin-bottom: 12px; }
  .footer-col a { color: var(--muted); text-decoration: none; font-size: 14px; transition: color .2s; cursor: pointer; }
  .footer-col a:hover { color: var(--text); }
  .footer-bottom { border-top: 1px solid var(--border); padding-top: 32px; display: flex; justify-content: space-between; color: var(--muted); font-size: 13px; }
  
  @media (max-width: 768px) {
    .grid { grid-template-columns: 1fr 1fr; gap: 16px; }
    .card-body { padding: 16px; }
    .card-title { font-size: 16px; }
    .price { font-size: 20px; }
    .btn { padding: 10px 14px; font-size: 13px; }
    .detail-content { padding: 24px; }
    .detail-img-container { min-height: 300px; }
    .footer-grid { grid-template-columns: 1fr; gap: 32px; }
    .footer-bottom { flex-direction: column; gap: 12px; text-align: center; }
    .recent-card { min-width: 180px; max-width: 180px; }
    .recent-card .card-title { font-size: 14px; }
    .recent-card .price { font-size: 16px; }
    .recent-card .btn { display: none; }
    .logo img { height: 32px; }
    .logo span { font-size: 18px; }
    .reviews-header { flex-direction: column; align-items: flex-start; gap: 16px; }
  }
</style>
</head>
<body>

<header>
  <div class="container header-inner">
    <div class="logo">
      <img src="/logo.png" alt="Logo">
      <span>iPhone | Shop</span>
    </div>
  </div>
</header>

<main style="flex: 1;">
  <section class="hero">
    <div class="container">
      <h1>Телефоны в наличии</h1>
      <p>Проверенные устройства по честным ценам</p>
    </div>
  </section>
  
  <div class="container">
    <div class="filters" id="filters">
      <button class="filter active" data-status="all">Все</button>
      <button class="filter" data-status="available">В наличии</button>
      <button class="filter" data-status="discounted">Со скидкой</button>
      <button class="filter" data-status="reserved">Забронированы</button>
      <button class="filter" data-status="sold">Проданы</button>
    </div>
    
    <div class="grid" id="grid"></div>

    <div class="recent-section" id="recent-section">
      <div class="recent-header">
        <div class="recent-title">Вы недавно смотрели</div>
      </div>
      <div class="recent-grid" id="recent-grid"></div>
    </div>
  </div>

  <!-- Блок Отзывов -->
  <section class="reviews-section" id="reviews-section" style="display: none;">
    <div class="container">
      <div class="reviews-header">
        <div class="reviews-title">Отзывы наших клиентов</div>
        <button class="btn btn-secondary" onclick="openReview()">Оставить отзыв</button>
      </div>
      <div class="reviews-grid" id="reviews-grid"></div>
    </div>
  </section>
</main>

<footer>
  <div class="container">
    <div class="footer-grid">
      <div class="footer-col">
        <div class="logo" style="margin-bottom:16px;">
          <img src="/logo.png" alt="Logo">
          <span>iPhone | Shop</span>
        </div>
        <p style="color:var(--muted); font-size:14px; line-height:1.6; max-width:300px;">
          Бутик проверенных смартфонов. Берем на себя все риски покупки с рук: личный отбор, полная диагностика и честные цены без переплат магазинам.
        </p>
      </div>
      <div class="footer-col">
        <h4>Покупателям</h4>
        <ul>
          <li><a onclick="showInfo('meeting')">Встреча и оплата</a></li>
          <li><a onclick="showInfo('check')">Проверка при встрече</a></li>
          <li><a onclick="showInfo('faq')">Частые вопросы</a></li>
          <li><a onclick="openReview()">Оставить отзыв</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Компания</h4>
        <ul>
          <li><a onclick="showInfo('about')">О нас</a></li>
          <li><a onclick="showInfo('reviews')">Отзывы</a></li>
          <li><a onclick="showInfo('contacts')">Контакты</a></li>
        </ul>
      </div>
            <div class="footer-col">
        <h4>Связаться с нами</h4>
        <ul>
          <li><a href="https://t.me/ShopysiPhones" target="_blank" style="font-weight:600; color:var(--text); margin-bottom: 8px; display: inline-block;">Написать менеджеру: @ShopysiPhones</a></li>
          <li><a href="https://t.me/ShopysiPhonesStore" target="_blank" style="font-weight:600; color:var(--text);">Наш канал: @ShopysiPhonesStore</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <div>© 2026 iPhone | Shop. Все права защищены.</div>
      <div><a onclick="showInfo('privacy')" style="cursor:pointer; color:inherit; text-decoration:none; transition: color 0.2s;" onmouseover="this.style.color='#1d1d1f'" onmouseout="this.style.color='inherit'">Политика конфиденциальности</a></div>
    </div>
  </div>
</footer>

<!-- DETAIL MODAL -->
<div class="modal-overlay" id="detail-modal" onclick="if(event.target===this) closeDetail()">
  <div class="modal detail-modal">
    <button class="detail-close" onclick="closeDetail()">×</button>
    <div class="detail-img-container">
      <div class="detail-main-img" id="detail-main-img-box"></div>
      <div class="detail-thumbnails" id="detail-thumbs-box"></div>
    </div>
    <div class="detail-content">
      <div class="detail-title" id="detail-title"></div>
      <div class="detail-meta" id="detail-meta"></div>
      
      <div class="specs-grid" id="detail-specs"></div>
      
      <div class="detail-desc" id="detail-desc"></div>

      <div class="detail-trust-badges">
        <span class="trust-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          Проверен
        </span>
        <span class="trust-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-4"></path></svg>
          Оригинал
        </span>
        <span class="trust-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          Безопасно
        </span>
      </div>

      <div class="detail-bottom">
        <div class="detail-price-wrap" id="detail-price-wrap">
          <div class="detail-price-old" id="detail-price-old" style="display:none;"></div>
          <div class="detail-price" id="detail-price"></div>
        </div>
        <button class="btn" id="detail-order-btn">Забронировать</button>
      </div>
    </div>
  </div>
</div>

<!-- ORDER MODAL -->
<div class="modal-overlay" id="order-modal" onclick="if(event.target===this) closeOrder()">
  <form class="modal order-modal" id="order-form">
    <h2 id="modal-title">Оформление заявки</h2>
    <p id="order-product"></p>
    
    <div class="deposit-note" id="deposit-note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
      Внесение залога 1000 ₽ гарантирует сохранение устройства за Вами.
    </div>

    <div class="input-group">
      <label>Ваше имя</label>
      <input name="name" required maxlength="100" placeholder="Иван">
    </div>
    <div class="input-group">
      <label>Телефон или Telegram</label>
      <input name="contact" required maxlength="100" placeholder="+7 900 000-00-00 или @username">
    </div>
    <div class="input-group">
      <label>Комментарий</label>
      <textarea name="message" maxlength="1000" placeholder="Удобное время звонка..."></textarea>
    </div>
    <button type="submit" class="btn" id="submit-btn">Отправить</button>
    <div class="modal-msg" id="order-msg"></div>
  </form>
</div>

<!-- REVIEW MODAL -->
<div class="modal-overlay" id="review-modal" onclick="if(event.target===this) closeReview()">
  <form class="modal review-modal" id="review-form">
    <h2>Оставить отзыв</h2>
    <p>Нам очень важно Ваше мнение!</p>

    <div class="input-group">
      <label>Ваше имя</label>
      <input name="name" required maxlength="50" placeholder="Иван">
    </div>
    <div class="input-group">
      <label>Какой телефон покупали? (необязательно)</label>
      <input name="phone_model" maxlength="100" placeholder="iPhone 14 Pro Max">
    </div>
    <div class="input-group">
      <label>Оценка</label>
      <div class="star-rating" id="star-rating">
        <input type="hidden" name="rating" id="rating-input" value="5">
        <label data-value="1" class="star active"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></label>
        <label data-value="2" class="star active"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></label>
        <label data-value="3" class="star active"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></label>
        <label data-value="4" class="star active"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></label>
        <label data-value="5" class="star active"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></label>
      </div>
    </div>
    <div class="input-group">
      <label>Текст отзыва</label>
      <textarea name="text" required maxlength="500" placeholder="Расскажите о Вашем опыте покупки..."></textarea>
    </div>
    <button type="submit" class="btn" id="review-submit-btn">Отправить</button>
    <div class="modal-msg" id="review-msg"></div>
  </form>
</div>

<!-- INFO MODAL -->
<div class="modal-overlay" id="info-modal" onclick="if(event.target===this) closeInfo()">
  <div class="modal info-modal">
    <h2 id="info-title"></h2>
    <div id="info-text"></div>
    <button class="btn" onclick="closeInfo()">Понятно</button>
  </div>
</div>

<script>
(function() {
  var STATUS_LABEL = { available:'В наличии', reserved:'Забронировано', sold:'Продано' };
  var STATUS_BTN   = { available:'Забронировать', reserved:'Узнать', sold:'Уведомить' };
  var allPhones = [];
  var currentFilter = 'all';
  var selectedPhone = null;
  var currentActionType = 'order';
  var timersInterval = null;

  var grid = document.getElementById('grid');
  var filters = document.getElementById('filters');
  var detailModal = document.getElementById('detail-modal');
  var orderModal = document.getElementById('order-modal');
  var infoModal = document.getElementById('info-modal');
  var reviewModal = document.getElementById('review-modal');
  
  var orderForm = document.getElementById('order-form');
  var orderMsg = document.getElementById('order-msg');
  var submitBtn = document.getElementById('submit-btn');
  
  var reviewForm = document.getElementById('review-form');
  var reviewMsg = document.getElementById('review-msg');
  var reviewSubmitBtn = document.getElementById('review-submit-btn');

  var phoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>';

  // Логика звездного рейтинга на JS (без глюков CSS)
  var stars = document.querySelectorAll('#star-rating .star');
  var ratingInput = document.getElementById('rating-input');

  function setStars(val) {
    stars.forEach(function(s, i) {
      if (i < val) s.classList.add('active');
      else s.classList.remove('active');
    });
  }

  if (stars.length > 0) {
    stars.forEach(function(star, index) {
      star.addEventListener('mouseover', function() { setStars(index + 1); });
      star.addEventListener('click', function() { ratingInput.value = index + 1; });
    });

    var starContainer = document.getElementById('star-rating');
    starContainer.addEventListener('mouseleave', function() {
      setStars(parseInt(ratingInput.value) || 5);
    });
  }

  function getStarsHtml(rating) {
    var html = '<div class="stars-wrap">';
    for (var i = 1; i <= 5; i++) {
      if (i <= rating) {
        html += '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
      } else {
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
      }
    }
    html += '</div>';
    return html;
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function formatTime(ms) {
    if (ms <= 0) return 'Скидка закончилась';
    var totalSec = Math.floor(ms / 1000);
    var d = Math.floor(totalSec / 86400);
    var h = Math.floor((totalSec % 86400) / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (d > 0) return 'Сгорит через ' + d + 'д ' + h + 'ч ' + m + 'м';
    if (h > 0) return 'Сгорит через ' + h + 'ч ' + m + 'м ' + s + 'с';
    return 'Сгорит через ' + m + 'м ' + s + 'с';
  }

  function updateTimers() {
    var now = new Date().getTime();
    document.querySelectorAll('.timer-label').forEach(function(el) {
      var end = parseInt(el.dataset.end, 10);
      var diff = end - now;
      if (diff <= 0) {
        el.textContent = 'Скидка закончилась';
        el.style.opacity = '0.5';
      } else {
        el.textContent = formatTime(diff);
      }
    });
  }

  function startTimers() {
    if (timersInterval) clearInterval(timersInterval);
    updateTimers();
    timersInterval = setInterval(updateTimers, 1000);
  }

  document.getElementById('recent-grid').addEventListener('wheel', function(e) {
    var isAtEnd = this.scrollWidth - this.scrollLeft <= this.clientWidth;
    var isAtStart = this.scrollLeft === 0;

    if ((e.deltaY > 0 && !isAtEnd) || (e.deltaY < 0 && !isAtStart)) {
      e.preventDefault();
      this.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  function load() {
    fetch('/api/phones').then(function(r) { return r.json(); }).then(function(data) {
      allPhones = data; 
      render(); 
      renderRecent();
    }).catch(function() {
      grid.innerHTML = '<div class="empty">Ошибка загрузки данных</div>';
    });

    fetch('/api/reviews').then(function(r) { return r.json(); }).then(function(data) {
      renderReviews(data);
    });
  }

  function renderReviews(reviews) {
    var section = document.getElementById('reviews-section');
    var gridBox = document.getElementById('reviews-grid');

    if (reviews.length > 0) {
      section.style.display = 'block';
      var html = '';
      for (var i = 0; i < reviews.length; i++) {
        var r = reviews[i];
        var stars = getStarsHtml(r.rating);
        var date = new Date(r.created_at).toLocaleDateString('ru-RU');
        
        html += '<div class="review-card">' +
          '<div class="review-header">' +
            '<div class="review-author">' + esc(r.name) + '</div>' +
            stars +
          '</div>' +
          (r.phone_model ? '<div class="review-model">Купил(а): ' + esc(r.phone_model) + '</div>' : '') +
          '<div class="review-text">«' + esc(r.text) + '»</div>' +
          '<div class="review-date">' + date + '</div>' +
        '</div>';
      }
      gridBox.innerHTML = html;
    } else {
      section.style.display = 'none';
    }
  }

  function buildCardHtml(p, isRecent) {
    var mainImg = p.images && p.images.length > 0 ? p.images[0] : '';
    var img = mainImg ? '<img src="' + mainImg + '" alt="" loading="lazy">' : phoneSvg;
    
    var meta = [p.storage, p.color].filter(Boolean).join(' · ');
    var btn = '';
    
    if (!isRecent) {
      if (p.status === 'sold') {
        btn = '<button class="btn" data-notify-btn="' + p.id + '">Уведомить</button>';
      } else {
        btn = '<button class="btn" data-order-btn="' + p.id + '">' + STATUS_BTN[p.status] + '</button>';
      }
    }

    var now = new Date().getTime();
    var isDiscounted = p.old_price && p.old_price > p.price;
    var hasTimer = p.discount_ends && new Date(p.discount_ends).getTime() > now;
    if (p.discount_ends && !hasTimer) isDiscounted = false;

    var priceHtml = '';
    var hitHtml = '';

    if (p.is_hit) {
      hitHtml = '<div class="hit-badge">ХИТ ПРОДАЖ</div>';
    }

    if (isDiscounted) {
      var discountPercent = Math.round((1 - (p.price / p.old_price)) * 100);
      
      priceHtml = '<div class="price-row">' +
        '<span class="price-old">' + Number(p.old_price).toLocaleString('ru-RU') + ' ₽</span>' +
        '<span class="discount-percent-inline">-' + discountPercent + '%</span>' +
      '</div>';
      priceHtml += '<div class="price discounted">' + Number(p.price).toLocaleString('ru-RU') + ' ₽</div>';
      
      if (hasTimer && !isRecent) {
        var endMs = new Date(p.discount_ends).getTime();
        priceHtml += '<div class="timer-label" data-end="' + endMs + '">' + formatTime(endMs - now) + '</div>';
      }
    } else {
      priceHtml = '<div class="price">' + Number(p.price).toLocaleString('ru-RU') + ' ₽</div>';
    }

    var trustHtml = '';
    if (!isRecent) {
      trustHtml = '<div class="trust-badges">' +
        '<span class="trust-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Проверен</span>' +
        '<span class="trust-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-4"></path></svg> Оригинал</span>' +
        '<span class="trust-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg> Безопасно</span>' +
      '</div>';
    }

    return '<article class="card ' + p.status + (isRecent ? ' recent-card' : '') + '" data-card="' + p.id + '">' +
      '<div class="card-img">' + img + hitHtml +
        '<span class="status ' + p.status + '">' + STATUS_LABEL[p.status] + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<div class="card-title">' + esc(p.brand) + ' ' + esc(p.model) + '</div>' +
        (meta ? '<div class="card-meta">' + esc(meta) + '</div>' : '') +
        trustHtml +
        '<div class="card-footer">' +
          '<div class="price-wrap">' + priceHtml + '</div>' +
          btn +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function render() {
    var now = new Date().getTime();
    var list = [];
    
    if (currentFilter === 'all') {
      list = allPhones;
    } else if (currentFilter === 'discounted') {
      list = allPhones.filter(function(p) {
        var isDiscounted = p.old_price && p.old_price > p.price;
        var hasTimer = p.discount_ends && new Date(p.discount_ends).getTime() > now;
        if (p.discount_ends && !hasTimer) return false;
        return isDiscounted;
      });
    } else {
      list = allPhones.filter(function(p) { return p.status === currentFilter; });
    }

    if (list.length === 0) {
      var emptyText = currentFilter === 'discounted' ? 'Сейчас нет товаров со скидкой' : 'В этой категории пока нет товаров';
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">' + emptyText + '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += buildCardHtml(list[i], false);
    }
    grid.innerHTML = html;
    startTimers();
  }

  function trackView(id) {
    fetch('/api/phone/' + id + '/view', { method: 'POST' });
    
    var recent = [];
    try { recent = JSON.parse(localStorage.getItem('recently_viewed') || '[]'); } catch(e) {}
    recent = recent.filter(function(x) { return x !== id; });
    recent.unshift(id);
    if (recent.length > 5) recent.pop();
    localStorage.setItem('recently_viewed', JSON.stringify(recent));
  }

  function renderRecent() {
    var recent = [];
    try { recent = JSON.parse(localStorage.getItem('recently_viewed') || '[]'); } catch(e) {}
    
    var recentPhones = [];
    for (var i = 0; i < recent.length; i++) {
      var p = allPhones.find(function(x) { return x.id === recent[i]; });
      if (p) recentPhones.push(p);
    }

    var section = document.getElementById('recent-section');
    var gridBox = document.getElementById('recent-grid');

    if (recentPhones.length > 0) {
      section.style.display = 'block';
      var html = '';
      for (var j = 0; j < recentPhones.length; j++) {
        html += buildCardHtml(recentPhones[j], true);
      }
      gridBox.innerHTML = html;
    } else {
      section.style.display = 'none';
    }
  }

  filters.addEventListener('click', function(e) {
    var btn = e.target.closest('.filter');
    if (!btn) return;
    filters.querySelectorAll('.filter').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    currentFilter = btn.dataset.status;
    render();
  });

  grid.addEventListener('click', function(e) {
    var orderBtn = e.target.closest('[data-order-btn]');
    if (orderBtn) {
      e.stopPropagation();
      openOrder(Number(orderBtn.dataset.orderBtn), 'order');
      return;
    }
    var notifyBtn = e.target.closest('[data-notify-btn]');
    if (notifyBtn) {
      e.stopPropagation();
      openOrder(Number(notifyBtn.dataset.notifyBtn), 'notify');
      return;
    }
    var card = e.target.closest('[data-card]');
    if (card) {
      openDetail(Number(card.dataset.card));
    }
  });

  document.getElementById('recent-grid').addEventListener('click', function(e) {
    var card = e.target.closest('[data-card]');
    if (card) {
      openDetail(Number(card.dataset.card));
    }
  });

  function openDetail(id) {
    var p = allPhones.find(function(x) { return x.id === id; });
    if (!p) return;
    
    trackView(id); 

    var mainBox = document.getElementById('detail-main-img-box');
    var thumbsBox = document.getElementById('detail-thumbs-box');
    
    if (p.images && p.images.length > 0) {
      mainBox.innerHTML = '<img src="' + p.images[0] + '" id="main-gallery-img">';
      if (p.images.length > 1) {
        var thumbsHtml = '';
        for (var i = 0; i < p.images.length; i++) {
          thumbsHtml += '<img src="' + p.images[i] + '" class="detail-thumb ' + (i===0?'active':'') + '" onclick="changeMainImg(this, \'' + p.images[i] + '\')">';
        }
        thumbsBox.innerHTML = thumbsHtml;
        thumbsBox.style.display = 'flex';
      } else {
        thumbsBox.style.display = 'none';
      }
    } else {
      mainBox.innerHTML = phoneSvg;
      thumbsBox.style.display = 'none';
    }

    document.getElementById('detail-title').textContent = p.brand + ' ' + p.model;
    document.getElementById('detail-meta').textContent = [p.storage, p.color].filter(Boolean).join(' · ');
    document.getElementById('detail-desc').textContent = p.description || 'Описание отсутствует.';
    
    var now = new Date().getTime();
    var isDiscounted = p.old_price && p.old_price > p.price;
    var hasTimer = p.discount_ends && new Date(p.discount_ends).getTime() > now;
    if (p.discount_ends && !hasTimer) isDiscounted = false;

    var priceOldEl = document.getElementById('detail-price-old');
    var priceEl = document.getElementById('detail-price');
    
    if (isDiscounted) {
      priceOldEl.style.display = 'block';
      priceOldEl.textContent = 'Старая цена: ' + Number(p.old_price).toLocaleString('ru-RU') + ' ₽';
      priceEl.textContent = Number(p.price).toLocaleString('ru-RU') + ' ₽';
      priceEl.classList.add('discounted');
    } else {
      priceOldEl.style.display = 'none';
      priceEl.textContent = Number(p.price).toLocaleString('ru-RU') + ' ₽';
      priceEl.classList.remove('discounted');
    }
    
    var specsHtml = '';
    if (p.condition) specsHtml += '<div class="spec-item"><span class="spec-label">Состояние</span><span class="spec-value">' + esc(p.condition) + '</span></div>';
    if (p.battery) specsHtml += '<div class="spec-item"><span class="spec-label">Аккумулятор</span><span class="spec-value">' + esc(p.battery) + '%</span></div>';
    if (p.kit) specsHtml += '<div class="spec-item"><span class="spec-label">Комплектация</span><span class="spec-value">' + esc(p.kit) + '</span></div>';
    if (p.sim) specsHtml += '<div class="spec-item"><span class="spec-label">SIM</span><span class="spec-value">' + esc(p.sim) + '</span></div>';
    
    if (p.imei) {
      var imeiStr = String(p.imei).replace(/\D/g, '');
      var last5 = imeiStr.slice(-5);
      if (last5.length > 0) {
        specsHtml += '<div class="spec-item"><span class="spec-label">IMEI</span><span class="spec-value">... ' + last5 + '</span></div>';
      }
    }
    
    document.getElementById('detail-specs').innerHTML = specsHtml || '<div style="grid-column:1/-1; color:var(--muted); font-size:14px;">Характеристики не указаны</div>';
    
    var btn = document.getElementById('detail-order-btn');
    if (p.status === 'sold') {
      btn.disabled = false;
      btn.textContent = 'Уведомить';
      btn.onclick = function() { closeDetail(); openOrder(p.id, 'notify'); };
    } else {
      btn.disabled = false;
      btn.textContent = STATUS_BTN[p.status];
      btn.onclick = function() { closeDetail(); openOrder(p.id, 'order'); };
    }
    
    detailModal.classList.add('open');
  }

  window.changeMainImg = function(el, src) {
    document.getElementById('main-gallery-img').src = src;
    document.querySelectorAll('.detail-thumb').forEach(function(t) { t.classList.remove('active'); });
    el.classList.add('active');
  };

  window.closeDetail = function() { detailModal.classList.remove('open'); };

  function openOrder(id, type) {
    selectedPhone = allPhones.find(function(x) { return x.id === id; });
    if (!selectedPhone) return;
    
    currentActionType = type || 'order';

    var titleEl = document.getElementById('modal-title');
    var productEl = document.getElementById('order-product');
    var depositEl = document.getElementById('deposit-note');

    if (currentActionType === 'notify') {
      titleEl.textContent = 'Уведомить о поступлении';
      productEl.textContent = 'Мы сообщим Вам, когда ' + selectedPhone.brand + ' ' + selectedPhone.model + ' появится в наличии';
      depositEl.style.display = 'none';
    } else {
      titleEl.textContent = 'Оформление заявки';
      productEl.textContent = selectedPhone.brand + ' ' + selectedPhone.model + ' — ' + Number(selectedPhone.price).toLocaleString('ru-RU') + ' ₽';
      depositEl.style.display = 'flex';
    }

    orderMsg.className = 'modal-msg';
    orderForm.reset();
    orderModal.classList.add('open');
  }

  window.closeOrder = function() {
    orderModal.classList.remove('open');
    selectedPhone = null;
  };

  window.openReview = function() {
    reviewMsg.className = 'modal-msg';
    reviewForm.reset();
    if (ratingInput) ratingInput.value = 5;
    if (stars.length > 0) setStars(5);
    reviewModal.classList.add('open');
  };

  window.closeReview = function() {
    reviewModal.classList.remove('open');
  };

  var infoData = {
    meeting: { title: 'Встреча и оплата', html: '<p class="info-text-block">Мы не отправляем товар почтой. Встречаемся лично в удобном для Вас общественном месте (торговый центр, кафе) для осмотра и передачи устройства. Оплата наличными или переводом на карту при получении.</p>' },
    check: { title: 'Проверка при встрече', html: '<p class="info-text-block">Вы можете проверять устройство столько, сколько потребуется: проверка IMEI, экрана, динамиков, аккумулятора и всех функций. Возврата после сделки нет, так как Вы проверяете все на месте.</p>' },
    faq: { 
      title: 'Частые вопросы', 
      html: '<div class="faq-item"><div class="faq-q">Можно ли проверить телефон перед покупкой?</div><div class="faq-a">Да, мы всегда даем достаточно времени на полную проверку всех функций и диагностику.</div></div>' +
            '<div class="faq-item"><div class="faq-q">Откуда у Вас устройства?</div><div class="faq-a">Мы лично отбираем и выкупаем лучшие экземпляры с рук, проводим полную диагностику и проверку на оригинальность деталей.</div></div>' +
            '<div class="faq-item"><div class="faq-q">Есть ли торг?</div><div class="faq-a">Небольшая скидка возможна, если Вы готовы совершить сделку сегодня или завтра. Мы ценим быстроту, поэтому готовы поощрить Вас за оперативность.</div></div>'
    },
    about: { title: 'О нас', html: '<p class="info-text-block">Мы верим, что хорошая техника не должна стоить безумных денег. Наш магазин — это тщательно отобранные устройства. Мы гарантируем безупречное техническое состояние: лично проверяем историю каждого аппарата, аккумулятор и подлинность деталей. Все внешние нюансы (если они есть) мы всегда честно описываем. Вы получаете статусный гаджет по честной цене и без рисков покупки с рук.</p>' },
    reviews: { title: 'Отзывы', html: '<p class="info-text-block">Мы очень дорожим своей репутацией. Вы можете посмотреть реальные отзывы наших клиентов в разделе «Отзывы наших клиентов» на этой странице. Если Вы уже совершили у нас покупку, будем рады Вашему отзыву!</p>' },
    contacts: { title: 'Контакты', html: '<p class="info-text-block">Связаться с нами напрямую можно в Telegram: <b>@ShopysiPhones</b>.<br>Наши новости и отзывы в канале: <b>@ShopysiPhonesStore</b>.<br>Мы онлайн ежедневно с 10:00 до 22:00.</p>' },
    privacy: { title: 'Политика конфиденциальности', html: '<p class="info-text-block">Ваша конфиденциальность очень важна для нас. <br><br>Мы собираем только те данные (имя и контакт), которые вы добровольно оставляете в формах заявок на нашем сайте. Эти данные используются исключительно для связи с вами по поводу покупки интересующего вас устройства.<br><br>Мы никогда не передаем ваши персональные данные третьим лицам и не используем их для спам-рассылок. Нажимая кнопку «Отправить» в форме заявки, вы даете согласие на обработку ваших персональных данных в указанных целях.</p>' },
  };

  window.showInfo = function(key) {
    var data = infoData[key];
    if (!data) return;
    document.getElementById('info-title').textContent = data.title;
    document.getElementById('info-text').innerHTML = data.html;
    infoModal.classList.add('open');
  };

  window.closeInfo = function() {
    infoModal.classList.remove('open');
  };

  orderForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    orderMsg.className = 'modal-msg';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправка...';
    
    var data = Object.fromEntries(new FormData(orderForm).entries());
    data.phone_id = selectedPhone ? selectedPhone.id : null;
    data.type = currentActionType;
    
    try {
      var r = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      var res = await r.json();
      if (!res.ok) throw new Error(res.error || 'Ошибка');
      
      orderMsg.textContent = currentActionType === 'notify' ? 'Спасибо! Мы напишем Вам, как только товар появится.' : 'Заявка успешно отправлена! Мы свяжемся с Вами.';
      orderMsg.classList.add('ok');
      orderForm.reset();
      setTimeout(function() { 
        window.closeOrder();
        load(); 
      }, 2500);
    } catch (err) {
      orderMsg.textContent = err.message;
      orderMsg.classList.add('err');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Отправить';
    }
  });

  reviewForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    reviewMsg.className = 'modal-msg';
    reviewSubmitBtn.disabled = true;
    reviewSubmitBtn.textContent = 'Отправка...';
    
    var data = Object.fromEntries(new FormData(reviewForm).entries());
    
    try {
      var r = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      var res = await r.json();
      if (!res.ok) throw new Error(res.error || 'Ошибка');
      
      reviewMsg.textContent = 'Спасибо за Ваш отзыв! Он появится на сайте после проверки.';
      reviewMsg.classList.add('ok');
      reviewForm.reset();
      if (ratingInput) ratingInput.value = 5;
      if (stars.length > 0) setStars(5);
      setTimeout(function() { 
        window.closeReview();
      }, 3000);
    } catch (err) {
      reviewMsg.textContent = err.message;
      reviewMsg.classList.add('err');
    } finally {
      reviewSubmitBtn.disabled = false;
      reviewSubmitBtn.textContent = 'Отправить';
    }
  });

  load();
})();
</script>
</body>
</html>`;

const adminHTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Админ-панель — iPhone | Shop</title>
<link rel="icon" type="image/png" href="/logo.png">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fbfbfd; --card:#fff; --text:#1d1d1f; --muted:#86868b;
    --border:#d2d2d7; --accent:#0071e3; --green:#34c759; --amber:#ff9500; --red:#ff3b30; }
  * { box-sizing:border-box; margin:0; padding:0; }
  
  input[type=number]::-webkit-inner-spin-button, 
  input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input[type=number] { -moz-appearance: textfield; }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 10px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: #a8a8a8; }

  body { font-family:'Inter', -apple-system, sans-serif; background:var(--bg); color:var(--text); }
  .container { max-width:1100px; margin:0 auto; padding:0 20px; }
  
  .login-screen { min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); padding:20px; }
  .login-box { background:#fff; border-radius:24px; padding:40px; width:100%; max-width:400px; box-shadow:0 10px 40px rgba(0,0,0,0.05); border:1px solid var(--border); }
  .login-box h1 { font-size:24px; margin-bottom:8px; font-weight:700; letter-spacing:-0.02em; }
  .login-box p { color:var(--muted); font-size:14px; margin-bottom:24px; }
  .login-box input { width:100%; padding:14px 16px; border:1px solid var(--border); background:#fafafa; border-radius:12px; font-size:15px; margin-bottom:16px; font-family:inherit; outline:none; transition:border-color .2s; }
  .login-box input:focus { border-color:var(--text); background:#fff; }
  .login-err { color:var(--red); font-size:13px; text-align:center; margin-top:12px; min-height:20px; }
  
  .app { display:none; }
  .app.visible { display:block; }
  header { background:rgba(251, 251, 253, 0.8); backdrop-filter:blur(20px); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:50; }
  .header-inner { display:flex; align-items:center; justify-content:space-between; height:72px; }
  
  .logo { font-size:20px; font-weight:800; letter-spacing:-0.5px; display: flex; align-items: center; gap: 10px; }
  .logo img { height: 36px; width: auto; object-fit: contain; }

  .header-actions { display:flex; gap:12px; }
  
  .btn { border:none; border-radius:12px; padding:12px 24px; font-size:14px; font-weight:600; cursor:pointer; background:var(--text); color:#fff; transition:all .2s; font-family:inherit; }
  .btn:hover:not(:disabled) { background:#000; }
  .btn:disabled { opacity:0.5; cursor:not-allowed; }
  .btn-secondary { background:#f5f5f7; color:var(--text); border:none; }
  .btn-secondary:hover { background:#e5e5ea; }
  .btn-danger { background:#ffebee; color:#b0251f; }
  .btn-danger:hover { background:#ffcdd2; }
  .btn-sm { padding:8px 16px; font-size:13px; border-radius:10px; }
  .btn-success { background:#e8f5e9; color:#1a7f37; }
  .btn-success:hover { background:#c8e6c9; }
  
  .tabs { display: flex; gap: 10px; margin-bottom: 32px; border-bottom: 1px solid var(--border); }
  .tab { padding: 12px 24px; font-size: 16px; font-weight: 600; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; transition: all .2s; background: none; border-top: none; border-left: none; border-right: none; font-family: inherit; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--text); }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  main { padding:40px 0 80px; }
  .page-title { font-size:32px; font-weight:800; margin-bottom:32px; letter-spacing:-0.03em; }
  
  .form-card { background:#fff; border-radius:24px; padding:40px; border:1px solid var(--border); margin-bottom:48px; box-shadow:0 4px 20px rgba(0,0,0,0.02); }
  .form-card h2 { font-size:22px; margin-bottom:24px; font-weight:700; letter-spacing:-0.02em; }
  .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
  .form-grid .full { grid-column:1 / -1; }
  .form-card label { display:block; font-size:13px; font-weight:600; margin-bottom:8px; color:var(--text); }
  
  .form-card input, .form-card textarea { width:100%; padding:14px 16px; border:1px solid var(--border); background:#fafafa; border-radius:12px; font-size:15px; font-family:inherit; outline:none; transition:border-color .2s; }
  .form-card textarea { min-height:100px; resize:vertical; }
  
  .form-card select {
    width: 100%; padding: 14px 16px; padding-right: 44px; border: 1px solid var(--border); background-color: #fafafa; border-radius: 12px; font-size: 15px; font-family: inherit; outline: none; transition: border-color .2s; cursor: pointer;
    -webkit-appearance: none; -moz-appearance: none; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2386868b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 16px center; background-size: 16px;
  }
  
  .form-card input:focus, .form-card select:focus, .form-card textarea:focus { border-color:var(--text); background-color:#fff; }

  .form-actions { display:flex; gap:12px; margin-top:32px; }
  .form-msg { margin-top:20px; padding:14px; border-radius:12px; font-size:15px; text-align:center; display:none; font-weight:500; }
  .form-msg.ok { display:block; background:#e8f5e9; color:#1a7f37; }
  .form-msg.err { display:block; background:#ffebee; color:#b0251f; }
  
  .upload-btn-wrap { position: relative; overflow: hidden; display: inline-block; }
  .upload-btn-wrap input[type=file] { font-size: 100px; position: absolute; left: 0; top: 0; opacity: 0; cursor: pointer; }
  .upload-btn { display: inline-block; padding: 12px 24px; background: #e5e5ea; color: var(--text); border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background .2s; }
  .upload-btn:hover { background: #d1d1d6; }
  .image-preview-container { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
  .preview-img-wrap { position: relative; width: 80px; height: 80px; border-radius: 12px; border: 1px solid var(--border); overflow: hidden; }
  .preview-img-wrap img { width: 100%; height: 100%; object-fit: cover; }
  .preview-img-del { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.5); color: #fff; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; }

  .phone-list, .review-list { display:flex; flex-direction:column; gap:16px; }
  .phone-row, .review-row { background:#fff; border-radius:20px; padding:20px 24px; border:1px solid var(--border); display:grid; gap:24px; align-items:center; transition:box-shadow .2s; }
  .phone-row { grid-template-columns:70px 1fr auto auto; }
  .review-row { grid-template-columns: 1fr auto; }
  .phone-row:hover, .review-row:hover { box-shadow:0 10px 30px rgba(0,0,0,0.05); }
  .phone-thumb { width:70px; height:70px; border-radius:16px; background:#fafafa; display:flex; align-items:center; justify-content:center; overflow:hidden; border:1px solid var(--border); }
  .phone-thumb img { width:100%; height:100%; object-fit:cover; }
  .phone-thumb svg { width:28px; height:28px; color:var(--border); }
  .phone-info { min-width:0; }
  .phone-name { font-weight:700; font-size:17px; margin-bottom:6px; letter-spacing:-0.01em; display: flex; align-items: center; gap: 8px; }
  .phone-meta { color:var(--muted); font-size:14px; margin-bottom: 4px; }
  .phone-stats { font-size: 12px; color: #0071e3; font-weight: 600; display: flex; gap: 12px; }
  .phone-price { font-weight:700; font-size:18px; white-space:nowrap; letter-spacing:-0.02em; display: flex; flex-direction: column; }
  .old-price-strike { text-decoration: line-through; color: var(--muted); font-size: 13px; font-weight: 500; }
  .phone-actions { display:flex; gap:10px; align-items:center; }
  
  .review-row { grid-template-columns: 1fr auto; align-items: flex-start; }
  .review-content { flex: 1; }
  .review-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .review-author { font-weight: 700; font-size: 16px; }
  
  .stars-wrap { display: inline-flex; gap: 2px; color: #ffb400; }
  .stars-wrap svg { width: 14px; height: 14px; }

  .review-model { font-size: 13px; color: var(--accent); font-weight: 500; margin-bottom: 8px; }
  .review-text { font-size: 14px; color: #444; line-height: 1.5; margin-bottom: 8px; }
  .review-status { display: inline-block; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
  .review-status.pending { background: #fff7ed; color: #b05e00; }
  .review-status.approved { background: #f0fdf4; color: #1a7f37; }
  .review-actions { display: flex; gap: 8px; flex-direction: column; }

  .admin-hit-badge { background: var(--text); color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }

  .status-select {
    padding: 10px 14px; padding-right: 32px; border-radius: 10px; border: 1px solid var(--border); font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; outline: none; transition: all .2s;
    -webkit-appearance: none; -moz-appearance: none; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2386868b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; background-size: 12px;
  }
  
  .status-select.available { color:#1a7f37; border-color:#cce8d5; background-color:#f0fdf4; }
  .status-select.reserved  { color:#b05e00; border-color:#ffe8cc; background-color:#fff7ed; }
  .status-select.sold      { color:#b0251f; border-color:#fecdd3; background-color:#fef2f2; }
  .empty { text-align:center; padding:60px 20px; color:var(--muted); font-size:16px; }

  .discount-toggle-wrap { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; cursor: pointer; padding: 10px; background: #fafafa; border-radius: 10px; border: 1px solid var(--border); transition: background .2s; }
  .discount-toggle-wrap:hover { background: #f5f5f7; }
  .discount-toggle-wrap input[type=checkbox] { width: 20px; height: 20px; cursor: pointer; accent-color: var(--text); }
  .discount-toggle-wrap label { margin: 0; cursor: pointer; font-size: 15px; }
  
  .discount-fields { display: none; grid-template-columns: 1fr 1fr; gap: 24px; background: #fff; padding: 20px; border-radius: 12px; border: 1px solid var(--border); margin-top: 10px; }
  .discount-fields.active { display: grid; }
  .discount-percent-badge { display: inline-block; background: var(--red); color: #fff; padding: 4px 10px; border-radius: 8px; font-size: 14px; font-weight: 700; margin-left: 10px; vertical-align: middle; }

  .hit-checkbox-wrap { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 14px 16px; background: #fafafa; border-radius: 12px; border: 1px solid var(--border); transition: background .2s; }
  .hit-checkbox-wrap:hover { background: #f5f5f7; }
  .hit-checkbox-wrap input[type=checkbox] { width: 20px; height: 20px; cursor: pointer; accent-color: var(--text); }
  .hit-checkbox-wrap label { margin: 0; cursor: pointer; font-size: 15px; font-weight: 500; }

  @media (max-width:720px) {
    .form-grid { grid-template-columns:1fr; }
    .discount-fields { grid-template-columns: 1fr; }
    .phone-row { grid-template-columns:60px 1fr; gap:16px; padding:20px; }
    .phone-price, .phone-actions { grid-column:1 / -1; }
    .phone-actions { justify-content:flex-end; }
    .review-row { grid-template-columns: 1fr; }
    .review-actions { flex-direction: row; }
    .logo img { height: 28px; }
    .logo span { font-size: 16px; }
  }
</style>
</head>
<body>

<div class="login-screen" id="login-screen">
  <form class="login-box" id="login-form">
    <h1>Админ-панель</h1>
    <p>Введите пароль для управления витриной</p>
    <input type="password" id="password" placeholder="Пароль" required autocomplete="current-password">
    <button type="submit" class="btn" style="width:100%; padding:16px; font-size:16px;">Войти</button>
    <div class="login-err" id="login-err"></div>
  </form>
</div>

<div class="app" id="app">
  <header>
    <div class="container header-inner">
      <div class="logo">
        <img src="/logo.png" alt="Logo">
        <span>iPhone | Shop · Админ</span>
      </div>
      <div class="header-actions">
        <a href="/" class="btn btn-secondary btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;">На сайт</a>
        <button class="btn btn-secondary btn-sm" onclick="logout()">Выйти</button>
      </div>
    </div>
  </header>
  <main class="container">
    <h1 class="page-title">Управление</h1>

    <div class="tabs">
      <button class="tab active" onclick="switchTab('phones')">Товары</button>
      <button class="tab" onclick="switchTab('reviews')">Отзывы</button>
    </div>

    <!-- Вкладка Товары -->
    <div id="tab-phones" class="tab-content active">
      <form class="form-card" id="add-form">
        <h2 id="form-title">Добавить телефон</h2>
        <div class="form-grid">
          <div><label>Бренд *</label><input name="brand" required placeholder="Apple"></div>
          <div><label>Модель *</label><input name="model" required placeholder="iPhone 15 Pro"></div>
          <div>
            <label>Память</label>
            <select name="storage">
              <option value="">Не указано</option>
              <option value="64 ГБ">64 ГБ</option>
              <option value="128 ГБ">128 ГБ</option>
              <option value="256 ГБ">256 ГБ</option>
              <option value="512 ГБ">512 ГБ</option>
              <option value="1 ТБ">1 ТБ</option>
              <option value="2 ТБ">2 ТБ</option>
            </select>
          </div>
          <div>
            <label>Цвет</label>
            <input list="color-list" name="color" placeholder="Выберите или введите">
            <datalist id="color-list">
              <option value="Natural Titanium"></option>
              <option value="Black Titanium"></option>
              <option value="White Titanium"></option>
              <option value="Blue Titanium"></option>
              <option value="Desert Titanium"></option>
              <option value="Черный"></option>
              <option value="Белый"></option>
              <option value="Синий"></option>
              <option value="Зеленый"></option>
              <option value="Розовый"></option>
            </datalist>
          </div>
          
          <div class="full" style="background: #fbfbfd; padding: 24px; border-radius: 16px; border: 1px solid var(--border); margin-bottom: 8px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
              <div>
                <label>Обычная цена (₽) *</label>
                <input name="base_price" type="number" required min="0" placeholder="99900" id="input-base-price" oninput="calcDiscount()">
              </div>
              <div style="display: flex; align-items: flex-end; padding-bottom: 4px;">
                <div class="discount-toggle-wrap" style="margin: 0; width: 100%;">
                  <input type="checkbox" id="discount-checkbox" onchange="toggleDiscount()">
                  <label for="discount-checkbox">Сделать скидку</label>
                </div>
              </div>
            </div>
            
            <div class="discount-fields" id="discount-fields">
              <div>
                <label>Цена со скидкой (₽)</label>
                <input name="discounted_price" type="number" min="0" placeholder="89900" id="input-discounted-price" oninput="calcDiscount()">
              </div>
              <div>
                <label>Скидка сгорит (дата и время) <span id="percent-badge" class="discount-percent-badge" style="display:none;"></span></label>
                <input name="discount_ends" type="datetime-local">
              </div>
            </div>
          </div>

          <div>
            <label>Состояние</label>
            <select name="condition">
              <option>Б/У — как новый</option>
              <option>Б/У — отличное</option>
              <option>Б/У — хорошее</option>
              <option>Восстановленный</option>
            </select>
          </div>
          
          <div><label>Аккумулятор (%)</label><input name="battery" type="number" min="1" max="100" placeholder="100"></div>
          <div><label>IMEI</label><input name="imei" placeholder="Введите IMEI (видно только последние 5 цифр)"></div>
          <div>
            <label>Комплектация</label>
            <select name="kit">
              <option value="">Не указано</option>
              <option>Полный комплект (коробка, док-ты)</option>
              <option>Полный комплект (без зарядки)</option>
              <option>Только телефон</option>
              <option>Телефон + кабель</option>
              <option>Телефон + зарядка</option>
              <option>Телефон + чехол</option>
            </select>
          </div>
          <div>
            <label>Тип SIM</label>
            <select name="sim">
              <option value="">Не указано</option>
              <option>e-SIM + Физ</option>
              <option>Только e-SIM</option>
              <option>1 Физ SIM</option>
            </select>
          </div>
          
          <div class="full">
            <div class="hit-checkbox-wrap">
              <input type="checkbox" id="input-hit" name="is_hit">
              <label for="input-hit">🔥 Отметить как «ХИТ ПРОДАЖ»</label>
            </div>
          </div>

          <div class="full">
            <label>Фотографии (можно выбрать несколько)</label>
            <div class="upload-btn-wrap">
              <div class="upload-btn">Выбрать фото с устройства</div>
              <input type="file" id="image-upload" multiple accept="image/*">
            </div>
            <div class="image-preview-container" id="image-preview"></div>
          </div>

          <div class="full"><label>Описание</label><textarea name="description" placeholder="Подробное описание состояния, дефекты (если есть), история устройства..."></textarea></div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn" id="save-btn">Добавить</button>
          <button type="button" class="btn btn-secondary" id="cancel-edit" style="display:none">Отмена</button>
        </div>
        <div class="form-msg" id="form-msg"></div>
      </form>

      <div class="phone-list" id="phone-list"></div>
    </div>

    <!-- Вкладка Отзывы -->
    <div id="tab-reviews" class="tab-content">
      <div class="review-list" id="review-list"></div>
    </div>

  </main>
</div>

<script>
(function() {
  var $ = function(id) { return document.getElementById(id); };
  var api = function(path, opts) {
    opts = opts || {};
    return fetch(path, Object.assign({}, opts, {
      headers: Object.assign({
        'Content-Type': 'application/json',
        'x-admin-password': localStorage.getItem('admin_pw') || ''
      }, opts.headers || {})
    }));
  };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function getStarsHtml(rating) {
    var html = '<div class="stars-wrap">';
    for (var i = 1; i <= 5; i++) {
      if (i <= rating) {
        html += '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
      } else {
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
      }
    }
    html += '</div>';
    return html;
  }
  
  var phones = [];
  var reviews = [];
  var editingId = null;
  var phoneSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>';

  window.switchTab = function(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    
    document.querySelectorAll('.tab').forEach(t => {
      if(t.textContent.toLowerCase() === (tab === 'phones' ? 'товары' : 'отзывы')) t.classList.add('active');
    });
    
    $('tab-' + tab).classList.add('active');
    if (tab === 'reviews') loadReviews();
  };

  window.toggleDiscount = function() {
    var isChecked = $('discount-checkbox').checked;
    var fields = $('discount-fields');
    if (isChecked) {
      fields.classList.add('active');
      calcDiscount();
    } else {
      fields.classList.remove('active');
      $('input-discounted-price').value = '';
      $('percent-badge').style.display = 'none';
    }
  };

  window.calcDiscount = function() {
    var basePrice = Number($('input-base-price').value);
    var discountedPrice = Number($('input-discounted-price').value);
    var badge = $('percent-badge');
    
    if (basePrice > 0 && discountedPrice > 0 && basePrice > discountedPrice) {
      var percent = Math.round((1 - (discountedPrice / basePrice)) * 100);
      badge.textContent = '-' + percent + '%';
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  };

  var uploadedImages = [];
  var imageUploadInput = $('image-upload');
  var imagePreviewContainer = $('image-preview');

  imageUploadInput.addEventListener('change', function(e) {
    var files = e.target.files;
    for (var i = 0; i < files.length; i++) {
      (function(file) {
        var reader = new FileReader();
        reader.onload = function(event) {
          uploadedImages.push(event.target.result);
          renderPreviews();
        };
        reader.readAsDataURL(file);
      })(files[i]);
    }
    imageUploadInput.value = '';
  });

  function renderPreviews() {
    imagePreviewContainer.innerHTML = '';
    uploadedImages.forEach(function(src, index) {
      var div = document.createElement('div');
      div.className = 'preview-img-wrap';
      div.innerHTML = '<img src="' + src + '"><button type="button" class="preview-img-del" onclick="removeImg(' + index + ')">×</button>';
      imagePreviewContainer.appendChild(div);
    });
  }

  window.removeImg = function(index) {
    uploadedImages.splice(index, 1);
    renderPreviews();
  };

  $('login-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var pw = $('password').value;
    $('login-err').textContent = '';
    try {
      var r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      if (!r.ok) throw new Error('Неверный пароль');
      localStorage.setItem('admin_pw', pw);
      showApp();
    } catch (err) {
      $('login-err').textContent = err.message;
    }
  });

  function showApp() {
    $('login-screen').style.display = 'none';
    $('app').classList.add('visible');
    loadPhones();
  }
  window.logout = function() {
    localStorage.removeItem('admin_pw');
    location.reload();
  };

  async function loadPhones() {
    var r = await api('/api/phones');
    phones = await r.json();
    renderList();
  }

  async function loadReviews() {
    var r = await api('/api/admin/reviews');
    reviews = await r.json();
    renderReviews();
  }
  
  function renderList() {
    var list = $('phone-list');
    if (phones.length === 0) {
      list.innerHTML = '<div class="empty">Нет добавленных товаров</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < phones.length; i++) {
      var p = phones[i];
      var mainImg = p.images && p.images.length > 0 ? p.images[0] : '';
      var thumb = mainImg ? '<img src="' + mainImg + '" alt="">' : phoneSvg;
      var meta = [p.storage, p.color, p.condition].filter(Boolean).join(' · ');
      
      var priceHtml = '';
      if (p.old_price && p.old_price > p.price) {
        priceHtml = '<span class="old-price-strike">' + Number(p.old_price).toLocaleString('ru-RU') + ' ₽</span>' +
                    '<span style="color: var(--red);">' + Number(p.price).toLocaleString('ru-RU') + ' ₽</span>';
      } else {
        priceHtml = Number(p.price).toLocaleString('ru-RU') + ' ₽';
      }

      var statsHtml = '<div class="phone-stats">' +
        '<span>Просмотры: ' + (p.views || 0) + '</span>' +
        '<span>Заявки: ' + (p.orders || 0) + '</span>' +
      '</div>';

      var hitHtml = p.is_hit ? '<span class="admin-hit-badge">ХИТ</span>' : '';

      html += '<div class="phone-row">' +
        '<div class="phone-thumb">' + thumb + '</div>' +
        '<div class="phone-info">' +
          '<div class="phone-name">' + esc(p.brand) + ' ' + esc(p.model) + hitHtml + '</div>' +
          '<div class="phone-meta">' + (esc(meta) || '—') + '</div>' +
          statsHtml +
        '</div>' +
        '<div class="phone-price">' + priceHtml + '</div>' +
        '<div class="phone-actions">' +
          '<select class="status-select ' + p.status + '" data-status-id="' + p.id + '">' +
            '<option value="available"' + (p.status==='available'?' selected':'') + '>В наличии</option>' +
            '<option value="reserved"'  + (p.status==='reserved' ?' selected':'') + '>Забронировано</option>' +
            '<option value="sold"'      + (p.status==='sold'     ?' selected':'') + '>Продано</option>' +
          '</select>' +
          '<button class="btn btn-secondary btn-sm" data-edit="' + p.id + '">Изменить</button>' +
          '<button class="btn btn-danger btn-sm" data-del="' + p.id + '">Удалить</button>' +
        '</div>' +
      '</div>';
    }
    list.innerHTML = html;
  }

  function renderReviews() {
    var list = $('review-list');
    if (reviews.length === 0) {
      list.innerHTML = '<div class="empty">Нет отзывов</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < reviews.length; i++) {
      var r = reviews[i];
      var stars = getStarsHtml(r.rating);
      var date = new Date(r.created_at).toLocaleString('ru-RU');
      var statusHtml = r.approved 
        ? '<span class="review-status approved">Опубликован</span>' 
        : '<span class="review-status pending">На модерации</span>';
      
      var btnApprove = r.approved 
        ? '<button class="btn btn-secondary btn-sm" data-rev-reject="' + r.id + '">Скрыть</button>'
        : '<button class="btn btn-success btn-sm" data-rev-approve="' + r.id + '">Опубликовать</button>';

      html += '<div class="review-row">' +
        '<div class="review-content">' +
          '<div class="review-header">' +
            '<div class="review-author">' + esc(r.name) + '</div>' +
            stars +
          '</div>' +
          (r.phone_model ? '<div class="review-model">Купил(а): ' + esc(r.phone_model) + '</div>' : '') +
          '<div class="review-text">«' + esc(r.text) + '»</div>' +
          '<div class="phone-stats">' + date + ' | ' + statusHtml + '</div>' +
        '</div>' +
        '<div class="review-actions">' +
          btnApprove +
          '<button class="btn btn-danger btn-sm" data-rev-del="' + r.id + '">Удалить</button>' +
        '</div>' +
      '</div>';
    }
    list.innerHTML = html;
  }

  var addForm = $('add-form');
  var formMsg = $('form-msg');
  var formTitle = $('form-title');
  var saveBtn = $('save-btn');
  var cancelEditBtn = $('cancel-edit');

  addForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    formMsg.className = 'form-msg';
    saveBtn.disabled = true;
    
    var formData = Object.fromEntries(new FormData(addForm).entries());
    formData.is_hit = $('input-hit').checked;
    
    var basePrice = Number(formData.base_price);
    var isDiscount = $('discount-checkbox').checked;
    
    if (isDiscount) {
      var discounted = Number(formData.discounted_price);
      if (discounted > 0 && discounted < basePrice) {
        formData.price = discounted; 
        formData.old_price = basePrice; 
      } else {
        formData.price = basePrice;
        formData.old_price = null;
        formData.discount_ends = null;
      }
    } else {
      formData.price = basePrice;
      formData.old_price = null;
      formData.discount_ends = null;
    }

    delete formData.base_price;
    delete formData.discounted_price;
    formData.images = uploadedImages;

    var url = editingId ? '/api/admin/phones/' + editingId : '/api/admin/phones';
    var method = editingId ? 'PUT' : 'POST';
    try {
      var r = await api(url, { method: method, body: JSON.stringify(formData) });
      var res = await r.json();
      if (!res.ok) throw new Error(res.error || 'Ошибка');
      formMsg.textContent = editingId ? 'Товар обновлен' : 'Товар добавлен';
      formMsg.classList.add('ok');
      resetForm();
      await loadPhones();
      setTimeout(function() { formMsg.className = 'form-msg'; }, 2500);
    } catch (err) {
      formMsg.textContent = err.message;
      formMsg.classList.add('err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  function resetForm() {
    addForm.reset();
    editingId = null;
    formTitle.textContent = 'Добавить телефон';
    saveBtn.textContent = 'Добавить';
    cancelEditBtn.style.display = 'none';
    uploadedImages = [];
    renderPreviews();
    
    $('discount-checkbox').checked = false;
    toggleDiscount();
    $('percent-badge').style.display = 'none';
    $('input-hit').checked = false;
  }
  cancelEditBtn.addEventListener('click', resetForm);

  $('phone-list').addEventListener('click', async function(e) {
    var editBtn = e.target.closest('[data-edit]');
    var delBtn = e.target.closest('[data-del]');

    if (editBtn) {
      var p = phones.find(function(x) { return x.id === Number(editBtn.dataset.edit); });
      if (!p) return;
      editingId = p.id;
      formTitle.textContent = 'Редактировать: ' + p.brand + ' ' + p.model;
      saveBtn.textContent = 'Сохранить';
      cancelEditBtn.style.display = 'inline-block';
      var f = addForm.elements;
      f.brand.value = p.brand; f.model.value = p.model;
      f.storage.value = p.storage; f.color.value = p.color;
      f.condition.value = p.condition;
      f.battery.value = p.battery || ''; f.kit.value = p.kit || '';
      f.sim.value = p.sim || ''; f.imei.value = p.imei || '';
      f.description.value = p.description;
      $('input-hit').checked = p.is_hit || false;
      
      if (p.old_price && p.old_price > p.price) {
        f.base_price.value = p.old_price;
        $('discount-checkbox').checked = true;
        toggleDiscount();
        f.discounted_price.value = p.price;
        f.discount_ends.value = p.discount_ends || '';
        calcDiscount();
      } else {
        f.base_price.value = p.price;
        $('discount-checkbox').checked = false;
        toggleDiscount();
        f.discounted_price.value = '';
        f.discount_ends.value = '';
        $('percent-badge').style.display = 'none';
      }

      uploadedImages = p.images ? p.images.slice() : [];
      renderPreviews();

      addForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (delBtn) {
      if (!confirm('Удалить этот товар?')) return;
      await api('/api/admin/phones/' + delBtn.dataset.del, { method: 'DELETE' });
      await loadPhones();
    }
  });

  $('phone-list').addEventListener('change', async function(e) {
    var sel = e.target.closest('[data-status-id]');
    if (!sel) return;
    var id = Number(sel.dataset.statusId);
    var status = sel.value;
    sel.className = 'status-select ' + status;
    await api('/api/admin/phones/' + id, { method: 'PUT', body: JSON.stringify({ status: status }) });
    await loadPhones();
  });

  // Обработка отзывов
  $('review-list').addEventListener('click', async function(e) {
    var appBtn = e.target.closest('[data-rev-approve]');
    var rejBtn = e.target.closest('[data-rev-reject]');
    var delBtn = e.target.closest('[data-rev-del]');

    if (appBtn) {
      await api('/api/admin/reviews/' + appBtn.dataset.revApprove, { method: 'PUT', body: JSON.stringify({ approved: true }) });
      await loadReviews();
    }
    if (rejBtn) {
      await api('/api/admin/reviews/' + rejBtn.dataset.revReject, { method: 'PUT', body: JSON.stringify({ approved: false }) });
      await loadReviews();
    }
    if (delBtn) {
      if (!confirm('Удалить этот отзыв?')) return;
      await api('/api/admin/reviews/' + delBtn.dataset.revDel, { method: 'DELETE' });
      await loadReviews();
    }
  });

  if (localStorage.getItem('admin_pw')) {
    api('/api/phones').then(function(r) {
      if (r.ok) showApp();
      else localStorage.removeItem('admin_pw');
    });
  }
})();
</script>
</body>
</html>`;

// ============================================================
//                        ROUTES
// ============================================================
app.get('/', (req, res) => res.type('html').send(indexHTML));
app.get('/admin', (req, res) => res.type('html').send(adminHTML));
app.get('/admin.html', (req, res) => res.type('html').send(adminHTML));

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  iPhone | Shop запущен');
  console.log('  Витрина:  http://localhost:' + PORT);
  console.log('  Админка:  http://localhost:' + PORT + '/admin');
  console.log('');
});
