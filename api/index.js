import 'dotenv/config';
import { Telegraf, session } from 'telegraf';
import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import { URL } from 'url';

// ====== DATABASE MODELS ======
const PlatformSchema = new mongoose.Schema({ name: String });
const ServiceSchema = new mongoose.Schema({
  platform: String,
  type: String,
  display_name: String,
  min_qty: Number,
  max_qty: Number,
  pricing_mode: String,
  description: String,
});
const PricingSchema = new mongoose.Schema({
  service_id: mongoose.Schema.Types.ObjectId,
  mode: String,
  unit_size: Number,
  price_usd: Number,
  qty_from: Number,
  qty_to: Number,
  price_per_unit: Number,
});
const OrderSchema = new mongoose.Schema({
  telegram_user_id: String,
  telegram_chat_id: String,
  platform: String,
  service_id: mongoose.Schema.Types.ObjectId,
  service_type: String,
  target_username: String,
  quantity: Number,
  base_price: Number,
  fee: Number,
  total_price: Number,
  hoodpay_order_id: String,
  hoodpay_raw: Object,
  provider_order_id: String,
  provider_status: String,
  status: String,
  comments: [String],
  created_at: { type: Date, default: Date.now },
});
const Platform = mongoose.model('Platform', PlatformSchema);
const Service = mongoose.model('Service', ServiceSchema);
const Pricing = mongoose.model('Pricing', PricingSchema);
const Order = mongoose.model('Order', OrderSchema);

// ====== ENV & SETUP ======
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mybotdb';
const FIXED_FEE = 0.5;
const MAX_PROVIDER_RETRIES = 3;
const ADMIN_IDS = [process.env.ADMIN_TELEGRAM_ID || '431293700'];

// ====== MONGO CONNECT ======
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(e => {
    console.error('❌ MongoDB Connection Error:', e.message);
    process.exit(1);
  });

// ====== HELPERS ======
function isValidHttpsUrl(u) {
  try { const parsed = new URL(u); return parsed.protocol === 'https:'; }
  catch { return false; }
}
function parseComments(rawText) {
  return rawText.split(',').map(c => c.trim()).filter(Boolean);
}
async function getServicesForPlatform(platform) {
  return await Service.find({ platform }).sort('display_name');
}
async function getServiceById(id) {
  return await Service.findById(id);
}
async function getPricingForService(service, quantity) {
  if (service.pricing_mode === 'flat') {
    const pricing = await Pricing.find({ service_id: service._id, mode: 'flat' }).sort('unit_size');
    if (!pricing.length) throw new Error('Flat pricing not set.');
    let chosen = pricing.find(p => quantity <= p.unit_size);
    if (!chosen) chosen = pricing[pricing.length - 1];
    return Math.ceil(quantity / chosen.unit_size) * chosen.price_usd;
  } else if (service.pricing_mode === 'tiered') {
    const tier = await Pricing.findOne({ service_id: service._id, mode: 'tiered', qty_from: { $lte: quantity }, qty_to: { $gte: quantity } });
    if (!tier) throw new Error('No pricing tier found for this quantity.');
    return quantity * tier.price_per_unit;
  }
  throw new Error('Unknown pricing mode.');
}
async function retryWithBackoff(fn, retries = 3, baseDelay = 1000) {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      await new Promise(r => setTimeout(r, Math.round(baseDelay * Math.pow(1.5, attempt - 1))));
    }
  }
}

// ====== EXPRESS SETUP ======
const app = express();
app.use(express.json());

// ====== TELEGRAM BOT SETUP ======
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

// ========= ADMIN PANEL =========
// ... (الكود كما بالأعلى - نفس لوحة الأدمن مع عرض الطلبات وتعديل السعر ...)

// ========= MAIN BOT FLOW ==========

bot.start(async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session = {};
  const platforms = await Platform.find({});
  if (!platforms.length) return ctx.reply('No platforms available now.');
  const keyboard = platforms.map(p => [{ text: p.name[0].toUpperCase() + p.name.slice(1), callback_data: `platform_${p.name}` }]);
  await ctx.reply('Welcome! Please select a platform:', { reply_markup: { inline_keyboard: keyboard } });
});

// PLATFORM SELECT
bot.action(/platform_(.+)/, async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const platform = ctx.match[1];
  ctx.session.platform = platform;
  ctx.session.serviceType = null;
  ctx.session.serviceId = null;
  ctx.session.targetUsername = null;
  ctx.session.pending = null;
  ctx.session.service = null;
  const services = await getServicesForPlatform(platform);
  if (!services.length) return ctx.reply('No services for this platform.');
  const keyboard = [
    ...services.map(s => [{ text: s.display_name, callback_data: `service_${s._id}` }]),
    [{ text: "⬅️ Back", callback_data: "back_platforms" }]
  ];
  await ctx.answerCbQuery();
  await ctx.reply(`Platform selected: ${platform}\nPlease select a service:`, { reply_markup: { inline_keyboard: keyboard } });
});

// BACK TO PLATFORMS
bot.action('back_platforms', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session.platform = null;
  ctx.session.serviceType = null;
  ctx.session.serviceId = null;
  ctx.session.targetUsername = null;
  ctx.session.pending = null;
  ctx.session.service = null;
  const platforms = await Platform.find({});
  const keyboard = platforms.map(p => [{ text: p.name[0].toUpperCase() + p.name.slice(1), callback_data: `platform_${p.name}` }]);
  await ctx.reply('Please select a platform:', { reply_markup: { inline_keyboard: keyboard } });
  await ctx.answerCbQuery();
});

// SERVICE SELECT
bot.action(/service_(.+)/, async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const serviceId = ctx.match[1];
  const service = await getServiceById(serviceId);
  if (!service) return ctx.reply('Service not found.');
  ctx.session.serviceType = service.type;
  ctx.session.serviceId = serviceId;
  ctx.session.targetUsername = null;
  ctx.session.pending = null;
  ctx.session.service = service;
  await ctx.answerCbQuery();
  await ctx.reply(`Service: ${service.display_name}\n${service.description}\n\nPlease enter your target username (without @):`, {
    reply_markup: {
      inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_service" }]]
    }
  });
});

// BACK TO SERVICES
bot.action('back_service', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session.serviceType = null;
  ctx.session.serviceId = null;
  ctx.session.targetUsername = null;
  ctx.session.pending = null;
  ctx.session.service = null;
  const services = await getServicesForPlatform(ctx.session.platform);
  const keyboard = [
    ...services.map(s => [{ text: s.display_name, callback_data: `service_${s._id}` }]),
    [{ text: "⬅️ Back", callback_data: "back_platforms" }]
  ];
  await ctx.reply(`Platform selected: ${ctx.session.platform}\nPlease select a service:`, { reply_markup: { inline_keyboard: keyboard } });
  await ctx.answerCbQuery();
});

// TEXT HANDLER (main flow & edit)
bot.on('text', async (ctx, next) => {
  if (!ctx.session) ctx.session = {};

  // باقي الأكواد ... (لوحة الأدمن الخ)
  // Edit flow
  if (ctx.session.editField && ctx.session.pending) {
    const p = ctx.session.pending;
    const service = ctx.session.service;
    if (ctx.session.editField === 'username') {
      const username = ctx.message.text.trim().replace(/^@/, '');
      if (!username) return ctx.reply('Invalid username. Please try again.', {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
      });
      p.targetUsername = username;
      ctx.session.targetUsername = username;
      ctx.session.editField = null;
      return showOrderSummary(ctx);
    }
    if (ctx.session.editField === 'quantity') {
      const quantity = parseInt(ctx.message.text.trim(), 10);
      if (!service) return ctx.reply('Internal error: service missing.', {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
      });
      if (isNaN(quantity) || quantity < service.min_qty || quantity > service.max_qty)
        return ctx.reply(`Enter a number between ${service.min_qty} and ${service.max_qty}.`, {
          reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
        });
      p.quantity = quantity;
      try {
        p.basePrice = await getPricingForService(service, quantity);
        p.totalPrice = p.basePrice + FIXED_FEE;
      } catch (e) { return ctx.reply(`Error: ${e.message}`); }
      ctx.session.editField = null;
      return showOrderSummary(ctx);
    }
    if (ctx.session.editField === 'comments') {
      if (!service) return ctx.reply('Internal error: service missing.', {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
      });
      const comments = parseComments(ctx.message.text);
      if (!comments.length || comments.length < service.min_qty || comments.length > service.max_qty)
        return ctx.reply(`Enter at least ${service.min_qty}, at most ${service.max_qty} comments.`, {
          reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
        });
      p.comments = comments;
      p.quantity = comments.length;
      try {
        p.basePrice = await getPricingForService(service, comments.length);
        p.totalPrice = p.basePrice + FIXED_FEE;
      } catch (e) { return ctx.reply(`Error: ${e.message}`); }
      ctx.session.editField = null;
      return showOrderSummary(ctx);
    }
    return;
  }

  // Main flow
  if (!ctx.session.platform || !ctx.session.serviceType || !ctx.session.serviceId || !ctx.session.service) return next();
  if (!ctx.session.targetUsername) {
    const username = ctx.message.text.trim().replace(/^@/, '');
    if (!username) return ctx.reply('Invalid username. Please try again.', {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_service" }]] }
    });
    ctx.session.targetUsername = username;
    if (ctx.session.serviceType === 'comment') {
      return ctx.reply('Please enter your comments, separated by commas (e.g. "Nice pic!, Awesome!, Cool!")', {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_service" }]] }
      });
    }
    return ctx.reply('Please enter the quantity you want:', {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_service" }]] }
    });
  }
  if (ctx.session.serviceType === 'comment' && (!ctx.session.pending || !ctx.session.pending.comments)) {
    const service = ctx.session.service;
    const comments = parseComments(ctx.message.text);
    if (!comments.length || comments.length < service.min_qty || comments.length > service.max_qty)
      return ctx.reply(`Enter at least ${service.min_qty}, at most ${service.max_qty} comments.`, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_service" }]] }
      });
    let basePrice;
    try { basePrice = await getPricingForService(service, comments.length); }
    catch (e) { return ctx.reply(`Error: ${e.message}`); }
    const totalPrice = basePrice + FIXED_FEE;
    const internalOrderId = `tg_${ctx.from.id}_${Date.now()}`;
    ctx.session.pending = {
      serviceId: ctx.session.serviceId,
      platform: ctx.session.platform,
      serviceType: ctx.session.serviceType,
      service_display_name: service.display_name,
      targetUsername: ctx.session.targetUsername,
      comments,
      quantity: comments.length,
      basePrice,
      totalPrice,
      internalOrderId,
    };
    return showOrderSummary(ctx);
  }
  if (!ctx.session.pending) {
    const service = ctx.session.service;
    const quantity = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(quantity) || quantity < service.min_qty || quantity > service.max_qty)
      return ctx.reply(`Enter a number between ${service.min_qty} and ${service.max_qty}.`, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_service" }]] }
      });
    let basePrice;
    try { basePrice = await getPricingForService(service, quantity); }
    catch (e) { return ctx.reply(`Error: ${e.message}`); }
    const totalPrice = basePrice + FIXED_FEE;
    const internalOrderId = `tg_${ctx.from.id}_${Date.now()}`;
    ctx.session.pending = {
      serviceId: ctx.session.serviceId,
      platform: ctx.session.platform,
      serviceType: ctx.session.serviceType,
      service_display_name: service.display_name,
      targetUsername: ctx.session.targetUsername,
      quantity,
      basePrice,
      totalPrice,
      internalOrderId,
    };
    return showOrderSummary(ctx);
  }
});

// BACK TO ORDER SUMMARY
bot.action('back_order_summary', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session.editField = null;
  await ctx.answerCbQuery();
  await showOrderSummary(ctx);
});

// EDITS
bot.action('edit_username', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session.editField = 'username';
  await ctx.answerCbQuery();
  await ctx.reply('Please enter the new target username (without @):', {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
  });
});
bot.action('edit_quantity', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session.editField = 'quantity';
  await ctx.answerCbQuery();
  await ctx.reply('Please enter the new quantity:', {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
  });
});
bot.action('edit_comments', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session.editField = 'comments';
  await ctx.answerCbQuery();
  await ctx.reply('Please enter your comments, separated by commas:', {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_order_summary" }]] }
  });
});
bot.action('cancel_order', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  ctx.session.pending = null;
  await ctx.answerCbQuery();
  await ctx.reply('Order cancelled. You can start a new one with /start');
});

// ... باقي الأكواد كما هي من الكود النهائي السابق (confirm_order، webhook، health ... إلخ)

async function showOrderSummary(ctx) {
  const p = ctx.session.pending;
  const summary =
    `Order Summary:\n` +
    `Platform: ${p.platform}\n` +
    `Service: ${p.service_display_name}\n` +
    `Username: @${p.targetUsername}\n` +
    (p.serviceType === 'comment'
      ? `Comments: ${p.comments.length}\n`
      : `Quantity: ${p.quantity}\n`) +
    `Base Price: $${p.basePrice.toFixed(2)}\n` +
    `Fee: $${FIXED_FEE.toFixed(2)}\n` +
    `Total: $${p.totalPrice.toFixed(2)}`;
  const editRow = [
    { text: 'Edit Username', callback_data: 'edit_username' },
    p.serviceType === 'comment'
      ? { text: 'Edit Comments', callback_data: 'edit_comments' }
      : { text: 'Edit Quantity', callback_data: 'edit_quantity' },
  ];
  const keyboard = {
    inline_keyboard: [
      editRow,
      [
        { text: 'Confirm ✅', callback_data: 'confirm_order' },
        { text: 'Cancel ❌', callback_data: 'cancel_order' },
        { text: "⬅️ Back", callback_data: "back_service" }
      ],
    ],
  };
  await ctx.reply(summary, { reply_markup: keyboard });
}

// ... تابع بنفس نظام الأكشنز لباقي الأكواد!

// const PORT = process.env.PORT || 3000;
// // app.listen(PORT, () => console.log(`Server running on ${PORT}`));
// bot.launch().then(() => console.log('Telegram bot started')).catch((e) => console.error('Bot launch failed', e));




let isBotLaunched = false;
if (!isBotLaunched) {
  bot.launch()
    .then(() => {
      isBotLaunched = true;
      console.log('🚀 Telegram bot launched');
    })
    .catch(err => console.error('❌ Bot launch error', err));
}

// Required for Vercel
export default app;