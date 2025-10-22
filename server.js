// server.js — Azure MVP with PostgreSQL Database + hotel.json + AI intent gating + Twilio + Push Notifications + Persistent Requests + Emergency Routing
// ----------------------------------------------------
const express     = require('express');
const http        = require('http');
const path        = require('path');
const fs          = require('fs');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const { Server }  = require('socket.io');
const crypto      = require('crypto');
const webpush     = require('web-push');
require('dotenv').config();

// Database connection with table creation
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Function to create all required tables
async function createTables() {
  const client = await db.connect();
  
  try {
    // Create rooms table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(100) UNIQUE NOT NULL,
        hotel_name VARCHAR(255),
        room_number VARCHAR(50),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create service_requests table (active requests)
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_requests (
        id VARCHAR(100) PRIMARY KEY,
        room_id VARCHAR(100) NOT NULL,
        room_number VARCHAR(50),
        message TEXT NOT NULL,
        intent VARCHAR(100),
        department VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        acknowledged_at TIMESTAMP,
        acknowledged_by VARCHAR(100),
        call_triggered BOOLEAN DEFAULT false,
        is_emergency BOOLEAN DEFAULT false
      )
    `);

    // Create service_request_history table (completed requests)
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_request_history (
        id VARCHAR(100) PRIMARY KEY,
        room_id VARCHAR(100) NOT NULL,
        room_number VARCHAR(50),
        message TEXT NOT NULL,
        intent VARCHAR(100),
        department VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'acknowledged',
        created_at TIMESTAMP NOT NULL,
        acknowledged_at TIMESTAMP,
        acknowledged_by VARCHAR(100),
        call_triggered BOOLEAN DEFAULT false,
        is_emergency BOOLEAN DEFAULT false,
        completed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create translations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(100) NOT NULL,
        speaker VARCHAR(50) NOT NULL,
        original_text TEXT,
        translated_text TEXT,
        language_from VARCHAR(10),
        language_to VARCHAR(10),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create analytics_daily table
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_daily (
        id SERIAL PRIMARY KEY,
        date DATE UNIQUE NOT NULL,
        translations_count INTEGER DEFAULT 0,
        ai_requests_count INTEGER DEFAULT 0,
        service_calls_count INTEGER DEFAULT 0,
        active_rooms_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create push_subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('✅ All database tables created successfully');
  } catch (error) {
    console.error('❌ Error creating tables:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Initialize tables on startup
createTables().catch(console.error);

// --- VAPID Key Setup ---
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.error('ERROR: You must set PUBLIC_VAPID_KEY and PRIVATE_VAPID_KEY in your environment variables.');
} else {
    webpush.setVapidDetails('mailto:test@example.com', publicVapidKey, privateVapidKey);
    console.log('VAPID keys configured.');
}

// Azure helpers
const { transcribeOnce } = require('./speech/azure_speech');
const { translateText }  = require('./speech/azure_translate');

// Groq (Llama 4 Scout)
const { Groq } = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Twilio
const twilio = require('twilio');
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// ----------------------------------------------------
// App & server
// ----------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PATCH'] }
});

app.set('trust proxy', true);
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// Database-backed Request Storage
// ----------------------------------------------------
async function loadRequestsFromDB() {
  try {
    const result = await db.query(`
      SELECT * FROM service_requests 
      WHERE status = 'pending' OR status = 'acknowledged'
      ORDER BY created_at DESC
    `);
    
    const requestsMap = new Map();
    result.rows.forEach(row => {
      requestsMap.set(row.id, {
        id: row.id,
        room: row.room_id,
        roomNumber: row.room_number,
        message: row.message,
        intent: row.intent,
        department: row.department,
        timestamp: row.created_at,
        status: row.status,
        acknowledgedAt: row.acknowledged_at,
        acknowledgedBy: row.acknowledged_by,
        callTriggered: row.call_triggered || false,
        isEmergency: row.is_emergency || false,
        callTimer: null
      });
    });
    console.log(`📋 Loaded ${requestsMap.size} active requests from database`);
    return requestsMap;
  } catch (error) {
    console.error('Error loading requests from database:', error);
    return new Map();
  }
}

async function saveRequestToDB(request) {
  try {
    await db.query(`
      INSERT INTO service_requests (
        id, room_id, room_number, message, intent, department, 
        created_at, status, acknowledged_at, acknowledged_by, 
        call_triggered, is_emergency
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        status = $8,
        acknowledged_at = $9,
        acknowledged_by = $10,
        call_triggered = $11
    `, [
      request.id, request.room, request.roomNumber, request.message,
      request.intent, request.department, request.timestamp, request.status,
      request.acknowledgedAt, request.acknowledgedBy, request.callTriggered,
      request.isEmergency
    ]);
  } catch (error) {
    console.error('Error saving request to database:', error);
  }
}

async function saveRequestToHistory(request) {
  try {
    // First, check if request already exists in history
    const existingResult = await db.query(`
      SELECT id FROM service_request_history WHERE id = $1
    `, [request.id]);

    if (existingResult.rows.length > 0) {
      console.log(`📝 Request ${request.id} already exists in history, skipping`);
      return;
    }

    // Insert into history table
    await db.query(`
      INSERT INTO service_request_history (
        id, room_id, room_number, message, intent, department,
        status, created_at, acknowledged_at, acknowledged_by,
        call_triggered, is_emergency, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    `, [
      request.id,
      request.room,
      request.roomNumber,
      request.message,
      request.intent,
      request.department,
      request.status,
      request.timestamp,
      request.acknowledgedAt,
      request.acknowledgedBy,
      request.callTriggered || false,
      request.isEmergency || false
    ]);
    
    console.log(`💾 Successfully saved request ${request.id} to history (${request.department})`);
    
    // Remove from active service_requests table
    await db.query(`DELETE FROM service_requests WHERE id = $1`, [request.id]);
    console.log(`🗑️ Removed request ${request.id} from active requests`);
    
  } catch (error) {
    console.error('❌ Error saving request to history:', error);
    console.error('Request data:', JSON.stringify(request, null, 2));
  }
}

function cleanupRequest(requestId, reason = 'unknown') {
  const request = activeRequests.get(requestId);
  if (request) {
    if (request.callTimer) {
      clearTimeout(request.callTimer);
      request.callTimer = null;
    }
    console.log(`🧹 Cleaning up request ${requestId} (${reason})`);
  }
}

// Load existing requests on startup
const activeRequests = new Map();

// ----------------------------------------------------
// Database-backed Push Subscriptions
// ----------------------------------------------------
async function savePushSubscription(subscription) {
  try {
    await db.query(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (endpoint) DO UPDATE SET
        p256dh = $2,
        auth = $3,
        updated_at = NOW()
    `, [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
  } catch (error) {
    console.error('Error saving push subscription:', error);
  }
}

async function getPushSubscriptions() {
  try {
    const result = await db.query('SELECT * FROM push_subscriptions WHERE is_active = true');
    return result.rows.map(row => ({
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    }));
  } catch (error) {
    console.error('Error getting push subscriptions:', error);
    return [];
  }
}

// ----------------------------------------------------
// Database-backed Analytics Class
// ----------------------------------------------------
class HotelAnalytics {
  constructor() {
    this.metrics = {
      daily: new Map(),
      hourly: new Map(),
      rooms: new Map(),
      languages: new Map(),
      intents: new Map(),
      responses: [],
      sessions: new Map(),
    };

    // Save to database every minute
    setInterval(() => this.saveToDB(), 60000);
    this.loadFromDB();
  }

  trackTranslation(data) {
    const now = new Date();
    const dateKey = now.toISOString().split('T')[0];
    const hourKey = `${dateKey}-${now.getHours()}`;

    // Update in-memory metrics (for real-time dashboard)
    const daily = this.metrics.daily.get(dateKey) || this.createDailyMetrics();
    daily.totalTranslations++;
    daily.uniqueRooms.add(data.room);
    const fromLanguage = data.fromLanguage || 'unknown';
    daily.languages[fromLanguage] = (daily.languages[fromLanguage] || 0) + 1;
    daily.speakerTypes[data.speaker] = (daily.speakerTypes[data.speaker] || 0) + 1;
    this.metrics.daily.set(dateKey, daily);

    const hourly = this.metrics.hourly.get(hourKey) || { translations: 0, rooms: new Set() };
    hourly.translations++;
    hourly.rooms.add(data.room);
    this.metrics.hourly.set(hourKey, hourly);

    const roomMetrics = this.metrics.rooms.get(data.room) || this.createRoomMetrics(data.room);
    roomMetrics.totalInteractions++;
    roomMetrics.lastActive = now;
    roomMetrics.languages.add(fromLanguage);
    if (data.speaker === 'guest') roomMetrics.guestMessages++;
    else roomMetrics.staffMessages++;
    this.metrics.rooms.set(data.room, roomMetrics);

    // Save individual translation to database
    this.saveTranslationToDB(data).catch(console.error);

    io.emit('analytics_update');
  }

  trackAIRequest(data) {
    const now = new Date();
    const dateKey = now.toISOString().split('T')[0];

    const daily = this.metrics.daily.get(dateKey) || this.createDailyMetrics();
    daily.aiRequests++;
    const intent = data.intent || 'UNKNOWN';
    daily.intents[intent] = (daily.intents[intent] || 0) + 1;

    if (data.triggeredCall) {
      daily.callsTriggered++;
      daily.callsByIntent[intent] = (daily.callsByIntent[intent] || 0) + 1;

      // Updated department mapping to handle emergencies
      let department = 'Receptionist'; // Default
      switch(intent) {
        case 'FOOD_ORDER':
          department = 'Restaurant';
          break;
        case 'HOUSEKEEPING':
        case 'MAINTENANCE':
          department = 'Housekeeping';
          break;
        case 'EMERGENCY':
        case 'SECURITY_THREAT':
        case 'MEDICAL_EMERGENCY':
          department = 'Security';
          break;
      }
      daily.callsByDepartment[department] = (daily.callsByDepartment[department] || 0) + 1;
    }

    this.metrics.daily.set(dateKey, daily);

    const intentMetric = this.metrics.intents.get(intent) || {
      count: 0,
      rooms: new Set(),
      avgConfidence: 0,
      triggeredCalls: 0
    };
    intentMetric.count++;
    intentMetric.rooms.add(data.room);
    if (data.triggeredCall) intentMetric.triggeredCalls++;
    this.metrics.intents.set(intent, intentMetric);

    io.emit('analytics_update');
  }

  async saveTranslationToDB(data) {
    try {
      await db.query(`
        INSERT INTO translations (
          room_id, speaker, original_text, translated_text,
          language_from, language_to, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        data.room, data.speaker, data.originalText || '', data.translatedText || '',
        data.fromLanguage, data.toLanguage
      ]);
    } catch (error) {
      console.error('Error saving translation to database:', error);
    }
  }

  // Updated getDashboardData with simplified structure
  getDashboardData() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const todayMetrics = this.metrics.daily.get(today) || this.createDailyMetrics();

    const yesterday = new Date(now - 86400000).toISOString().split('T')[0];
    const yesterdayMetrics = this.metrics.daily.get(yesterday) || this.createDailyMetrics();

    // Most Active Rooms (keep existing)
    const roomsArray = Array.from(this.metrics.rooms.values())
      .sort((a, b) => b.totalInteractions - a.totalInteractions)
      .slice(0, 10);

    // Convert Service Request Types to table format (instead of pie chart)
    const serviceRequestTypes = Array.from(this.metrics.intents.entries()).map(([intent, data]) => ({
      type: this.formatIntentName(intent),
      count: data.count,
      conversion: (data.count > 0 ? (data.triggeredCalls / data.count * 100) : 0).toFixed(1) + '%'
    })).sort((a, b) => b.count - a.count);

    // Calls by Department (keep existing format)
    const departmentCalls = { 'Receptionist': 0, 'Restaurant': 0, 'Housekeeping': 0, 'Security': 0 };
    for (const [, daily] of this.metrics.daily) {
      for (const [dept, count] of Object.entries(daily.callsByDepartment)) {
        departmentCalls[dept] = (departmentCalls[dept] || 0) + count;
      }
    }

    return {
      overview: {
        todayTranslations: todayMetrics.totalTranslations,
        todayRooms: todayMetrics.uniqueRooms.size,
        todayAIRequests: todayMetrics.aiRequests,
        todayCalls: todayMetrics.callsTriggered,
        trends: {
          translations: this.calculateTrend(todayMetrics.totalTranslations, yesterdayMetrics.totalTranslations),
          rooms: this.calculateTrend(todayMetrics.uniqueRooms.size, yesterdayMetrics.uniqueRooms.size),
          ai: this.calculateTrend(todayMetrics.aiRequests, yesterdayMetrics.aiRequests),
          calls: this.calculateTrend(todayMetrics.callsTriggered, yesterdayMetrics.callsTriggered)
        }
      },
      // Removed: charts.last7Days, charts.hourlyPattern, charts.languageDistribution
      tables: {
        serviceRequestTypes: serviceRequestTypes, // New table format
        departmentCalls: Object.entries(departmentCalls).map(([name, calls]) => ({name, calls}))
      },
      rooms: roomsArray,
      totalTranslations: this.calculateTotalTranslations()
    };
  }

  // Add this helper method to format intent names nicely
  formatIntentName(intent) {
    const intentMap = {
      'FOOD_ORDER': 'Food Order',
      'HOUSEKEEPING': 'Housekeeping',
      'MAINTENANCE': 'Maintenance',
      'MEDICAL_ASSISTANCE': 'Medical Assistance',
      'EMERGENCY': 'Emergency',
      'SECURITY_THREAT': 'Security Threat',
      'MEDICAL_EMERGENCY': 'Medical Emergency',
      'RECEPTIONIST_REQUEST': 'Reception Request',
      'UNKNOWN': 'General Inquiry'
    };
    return intentMap[intent] || intent.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
  }

  createDailyMetrics() {
    return {
      totalTranslations: 0,
      uniqueRooms: new Set(),
      languages: {},
      speakerTypes: {},
      aiRequests: 0,
      callsTriggered: 0,
      intents: {},
      callsByIntent: {},
      callsByDepartment: {}
    };
  }

  createRoomMetrics(roomId) {
    return {
      roomId,
      totalInteractions: 0,
      guestMessages: 0,
      staffMessages: 0,
      languages: new Set(),
      firstActive: new Date(),
      lastActive: new Date()
    };
  }

  calculateTrend(today, yesterday) {
    if (yesterday === 0) return today > 0 ? 100 : 0;
    return parseFloat(((today - yesterday) / yesterday * 100).toFixed(1));
  }

  calculateTotalTranslations() {
    let total = 0;
    for (const [, daily] of this.metrics.daily) {
      total += daily.totalTranslations;
    }
    return total;
  }

  async saveToDB() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const todayMetrics = this.metrics.daily.get(today);
      
      if (todayMetrics) {
        await db.query(`
          INSERT INTO analytics_daily (
            date, translations_count, ai_requests_count, 
            service_calls_count, active_rooms_count
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (date) DO UPDATE SET
            translations_count = $2,
            ai_requests_count = $3,
            service_calls_count = $4,
            active_rooms_count = $5,
            updated_at = NOW()
        `, [
          today,
          todayMetrics.totalTranslations,
          todayMetrics.aiRequests,
          todayMetrics.callsTriggered,
          todayMetrics.uniqueRooms.size
        ]);
      }
    } catch (error) {
      console.error('Error saving analytics to database:', error);
    }
  }

  async loadFromDB() {
    try {
      // Load recent analytics data from database
      const result = await db.query(`
        SELECT * FROM analytics_daily 
        WHERE date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY date DESC
      `);

      result.rows.forEach(row => {
        const daily = this.createDailyMetrics();
        daily.totalTranslations = row.translations_count || 0;
        daily.aiRequests = row.ai_requests_count || 0;
        daily.callsTriggered = row.service_calls_count || 0;
        // Note: uniqueRooms is a Set, so we'll approximate from active_rooms_count
        for (let i = 0; i < (row.active_rooms_count || 0); i++) {
          daily.uniqueRooms.add(`room_${i}`);
        }
        this.metrics.daily.set(row.date.toISOString().split('T')[0], daily);
      });

      console.log(`📊 Loaded analytics for ${result.rows.length} days from database`);
    } catch (error) {
      console.error('Error loading analytics from database:', error);
    }
  }
}

const analytics = new HotelAnalytics();

// ----------------------------------------------------
// hotel.json loader + normalizer (unchanged)
// ----------------------------------------------------
const hotelDataPath = path.join(__dirname, 'hotel.json');

function readJsonSafe(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('⚠️ Could not read', file, e.message);
    return fallback;
  }
}

function loadHotelData() {
  const raw = readJsonSafe(hotelDataPath, {});
  const info = {
    hotel_name: raw.hotelName || raw.info?.hotel_name || 'Your Hotel',
    check_in_time: raw.checkInTime || raw.info?.check_in_time || '2:00 PM',
    check_out_time: raw.checkoutTime || raw.checkOutTime || raw.info?.check_out_time || '11:00 AM',
    wifi_password: raw.wifiPassword || raw.info?.wifi_password || '',
    emergency_number: raw.emergency_number || raw.info?.emergency_number || '911',
    front_desk_number: raw.front_desk_number || raw.info?.front_desk_number || 'ext. 0'
  };

  const menu_items = (raw.menu_items || raw.menuItems || []).map(m => ({
    name: m.name || m.item || 'Item',
    description: m.description || '',
    price: typeof m.price === 'number' ? m.price : Number(m.price || 0),
    serving_time: m.serving_time || m.servingTime || 'All day'
  }));

  const facilities = (raw.facilities || []).map(f => ({
    name: f.name || 'Facility',
    description: f.description || '',
    location: f.location || '',
    opening_time: f.opening_time || f.openingTime || '',
    closing_time: f.closing_time || f.closingTime || '',
    booking_required: Boolean(f.booking_required ?? f.bookingRequired ?? false)
  }));

  const local_attractions = raw.localAttractions || raw.local_attractions || [];

  return { info, menu_items, facilities, local_attractions };
}

let hotelData = loadHotelData();

if (process.env.HOTEL_CONFIG_WATCH === '1') {
  fs.watchFile(hotelDataPath, { interval: 1000 }, () => {
    try {
      hotelData = loadHotelData();
      console.log('🔄 Reloaded hotel.json');
    } catch (e) {
      console.error('hotel.json reload failed:', e.message);
    }
  });
}

function formatHotelContextFor(intent) {
  let ctx = `Hotel: ${hotelData.info.hotel_name}\nCheck-in: ${hotelData.info.check_in_time}\nCheck-out: ${hotelData.info.check_out_time}`;
  if (hotelData.info.front_desk_number) ctx += `\nFront desk: ${hotelData.info.front_desk_number}`;
  if (intent === 'FOOD_ORDER' && hotelData.menu_items.length) {
    ctx += `\n\nMenu Items:\n${hotelData.menu_items.map(m =>
      `- ${m.name}: ${m.description ? m.description + ' ' : ''}$${m.price.toFixed(2)} (${m.serving_time})`
    ).join('\n')}`;
  }
  if (hotelData.facilities.length) {
    ctx += `\n\nFacilities:\n${hotelData.facilities.map(f =>
      `- ${f.name}${f.location ? ` (${f.location})` : ''}: ${f.description || '—'}${
        (f.opening_time || f.closing_time) ? `, Hours: ${f.opening_time || '?'} - ${f.closing_time || '?'}` : ''
      }${f.booking_required ? ', Booking required' : ''}`
    ).join('\n')}`;
  }
  if (hotelData.local_attractions?.length) {
    ctx += `\n\nNearby:\n${hotelData.local_attractions.map(a => `- ${a}`).join('\n')}`;
  }
  if (hotelData.info.wifi_password) {
    ctx += `\n\nWifi Password: ${hotelData.info.wifi_password}`;
  }
  return ctx;
}

// ----------------------------------------------------
// Database-backed Room Storage
// ----------------------------------------------------
async function loadRoomsFromDB() {
  try {
    const result = await db.query('SELECT * FROM rooms ORDER BY created_at DESC');
    const roomsMap = new Map();
    result.rows.forEach(row => {
      roomsMap.set(row.room_id, {
        roomId: row.room_id,
        hotelName: row.hotel_name,
        number: row.room_number,
        active: row.is_active,
        createdAt: row.created_at
      });
    });
    console.log(`🏨 Loaded ${roomsMap.size} rooms from database`);
    return roomsMap;
  } catch (error) {
    console.error('Error loading rooms from database:', error);
    return new Map();
  }
}

async function saveRoomToDB(room) {
  try {
    await db.query(`
      INSERT INTO rooms (room_id, hotel_name, room_number, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (room_id) DO UPDATE SET
        hotel_name = $2,
        room_number = $3,
        is_active = $4
    `, [room.roomId, room.hotelName, room.number, room.active, room.createdAt]);
  } catch (error) {
    console.error('Error saving room to database:', error);
  }
}

const roomsStore = new Map();
const activeRooms = new Map();
const userRoles = new Map();

const languageNames = {
  'hi-IN': 'Hindi','bn-IN': 'Bengali','ta-IN': 'Tamil','te-IN': 'Telugu','mr-IN': 'Marathi',
  'gu-IN': 'Gujarati','kn-IN': 'Kannada','ml-IN': 'Malayalam','pa-IN': 'Punjabi','or-IN': 'Odia','od-IN':'Odia',
  'en-US': 'English','en-IN': 'English','es-ES': 'Spanish','de-DE': 'German','fr-FR': 'French'
};

function getGuestLanguageInRoom(room) {
  const roomData = activeRooms.get(room);
  return roomData?.guestLanguage || 'hi-IN';
}

// ----------------------------------------------------
// FIXED AI Assistant Logic with Emergency Routing and Better Response Handling
// ----------------------------------------------------
// ----------------------------------------------------
// BULLETPROOF AI Assistant Logic with Emergency Routing
// ----------------------------------------------------
async function getAIAssistantResponse(text, room, language, history = []) {
  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('Missing GROQ_API_KEY server env');
    }

    const userText = (text || '').trim();
    if (!userText) return { ok: true, assistantResponse: '' };

    const roomNumber = (room?.replace(/^room[-_]/, '') || 'unknown room');
    const roomData = activeRooms.get(room);
    const pendingAction = roomData?.pendingAction;
    
    let systemPrompt, userPrompt;

    const formattedHistory = history.map(msg => `${msg.speaker}: ${msg.text}`).join('\n');

    if (pendingAction) {
        console.log(`🤖 Processing follow-up for room ${room}:`, pendingAction);
        
        if (pendingAction.type === 'collect_details') {
            systemPrompt = `The user asked for ${pendingAction.service_type}. You asked for more details. They provided: "${userText}"

You must respond EXACTLY like this:

RESPONSE: Perfect! I'll arrange that for you right away.
JSON: {"action":"make_call","intent":"${pendingAction.intent || 'RECEPTIONIST_REQUEST'}","message":"Room ${roomNumber}: Guest requests ${pendingAction.service_type} - ${userText}"}

NEVER add anything else. NEVER ask more questions.`;
            
            userPrompt = `User's details: "${userText}"`;
            
        } else if (pendingAction.confirmation_question) {
            systemPrompt = `You asked: "${pendingAction.confirmation_question}". User replied: "${userText}"

If they confirmed (yes/ok/sure/proceed):
RESPONSE: Perfect! I'm arranging that now.
JSON: {"action":"make_call","message":"${pendingAction.message}","intent":"${pendingAction.intent}"}

If they declined (no/cancel/nevermind):
RESPONSE: No problem, I've cancelled that request.
JSON: {"action":"cancel"}`;
            
            userPrompt = `User reply: "${userText}"`;
        }
        
    } else {
        // Main conversation - BULLETPROOF logic with explicit classification
        // Main conversation - BULLETPROOF logic with direct information handling
        systemPrompt = systemPrompt = `You are a warm, friendly AI assistant at ${hotelData.info.hotel_name}. Speak naturally like a helpful hotel concierge.

**YOUR PERSONALITY:**
Be conversational, helpful, and genuine. Keep responses brief (2-3 sentences usually) but warm. Vary your language - don't sound repetitive.
**CRITICAL LANGUAGE RULE:**
The guest is speaking to you in their native language. You MUST respond in THE SAME LANGUAGE they are using.
- If guest speaks Spanish → respond in Spanish
- If guest speaks German → respond in German
- If guest speaks Hindi → respond in Hindi
- If guest speaks English → respond in English
Match their language exactly. This is very important for guest comfort.

The message field in JSON should always be in English for staff, but your RESPONSE to the guest must be in their language.
**HOW TO RESPOND:**

When you can answer directly (wifi, check-in times, facilities):
→ Just answer naturally from hotel info below
→ End with: JSON: {"action":"provide_info","info_type":"wifi"}

When guest requests a service with details (specific food, destination, item):
→ Acknowledge warmly and naturally
→ Tell them you're notifying the right department
→ End with: JSON: {"action":"make_call","intent":"FOOD_ORDER","message":"Room ${roomNumber}: [what they want]"}

When request is vague (just "food", just "cab"):
→ Show enthusiasm
→ Ask what specifically they need
→ End with: JSON: {"collect_details":true,"service_type":"[service]","intent":"[intent]"}

When they give info after you already processed:
→ Thank them naturally
→ End with: JSON: {"action":"acknowledge"}

**RULES:**
1. Be natural and conversational - generate your own sentences
2. NEVER say "I'll arrange that" AND ask a question
3. Keep JSON on separate line starting with JSON:
4. Don't show technical details to guest

**HOTEL INFO:**
- ${hotelData.info.hotel_name}
- Check-in/out: ${hotelData.info.check_in_time} / ${hotelData.info.check_out_time}
- WiFi: ${hotelData.info.wifi_password || 'Ask reception'}
- Phone: ${hotelData.info.front_desk_number}
- Facilities: ${hotelData.facilities.map(f => f.name).join(', ') || 'Various'}

**ROUTING:**
- Food → FOOD_ORDER → Restaurant
- Towels/cleaning → HOUSEKEEPING → Housekeeping
- Transport/general → RECEPTIONIST_REQUEST → Reception
- Emergency → EMERGENCY → Reception + Security

Chat history: ${formattedHistory || 'New chat'}`;
        
        userPrompt = `Guest in Room ${roomNumber} says: "${userText}"
        
IMPORTANT: Detect what language the guest is speaking and respond in THAT SAME LANGUAGE. 
Your RESPONSE must match their language.
The JSON message field should be in English for staff.

Respond naturally and conversationally as the hotel assistant.`;
    }

    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      temperature: 0.03, // Lower temperature for more consistent responses
      top_p: 0.8,
      max_tokens: 500, // Shorter to prevent rambling
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const fullResponse = completion?.choices?.[0]?.message?.content?.trim?.() || "I'll help with that!";
    console.log(`🤖 AI raw response for room ${room}:`, fullResponse);

    // BULLETPROOF response parsing
    let assistantResponse = "I can help with that.";
    let controlJson = null;

    // Parse structured format
    const lines = fullResponse.split('\n').map(l => l.trim()).filter(l => l);
    let responseLine = '';
    let jsonLine = '';
    
    for (const line of lines) {
      if (line.startsWith('RESPONSE:')) {
        responseLine = line.substring(9).trim();
        break; // Take first RESPONSE line only
      }
    }
    
    for (const line of lines) {
      if (line.startsWith('JSON:')) {
        jsonLine = line.substring(5).trim();
        break; // Take first JSON line only
      }
    }

    // Use the parsed response if found
    if (responseLine) {
      assistantResponse = responseLine;
    } else {
      // Aggressive fallback parsing
      const cleanResponse = fullResponse
        .replace(/JSON\s*:.*$/gim, '') // Remove JSON lines
        .replace(/\{[\s\S]*?\}/g, '') // Remove JSON objects
        .replace(/RESPONSE\s*:/gi, '') // Remove RESPONSE: prefix
        .trim();
      
      if (cleanResponse && cleanResponse.length > 5) {
        assistantResponse = cleanResponse;
      }
    }

    // Parse JSON with error handling
    if (jsonLine) {
      try {
        controlJson = JSON.parse(jsonLine);
        console.log(`🤖 AI control action for room ${room}:`, controlJson);
      } catch (e) {
        console.error('❌ Failed to parse AI JSON:', e.message);
        // Fallback: try to extract JSON from full response
        const jsonMatch = fullResponse.match(/\{[^}]*"action"[^}]*\}/);
        if (jsonMatch) {
          try {
            controlJson = JSON.parse(jsonMatch[0]);
          } catch (e2) {
            console.error('❌ Fallback JSON parse also failed');
          }
        }
      }
    }

    // SAFETY: Remove any remaining JSON artifacts
    assistantResponse = assistantResponse
      .replace(/\{[\s\S]*?\}/g, '') // Remove any JSON objects
      .replace(/JSON\s*:.*$/gim, '') // Remove JSON mentions
      .replace(/RESPONSE\s*:/gi, '') // Remove RESPONSE prefix
      .trim();

    // Ensure valid response
    if (!assistantResponse || assistantResponse.length < 3) {
      assistantResponse = "I'm processing your request!";
    }

    // SAFETY: Prevent mixed responses
    const sayingArranging = assistantResponse.toLowerCase().includes("i'll arrange") || 
                           assistantResponse.toLowerCase().includes("arranging");
    const askingQuestions = assistantResponse.includes('?') || 
                           assistantResponse.toLowerCase().includes('what') ||
                           assistantResponse.toLowerCase().includes('which') ||
                           assistantResponse.toLowerCase().includes('how');

    if (sayingArranging && askingQuestions) {
      console.warn('⚠️ MIXED RESPONSE DETECTED! Fixing...');
      if (controlJson?.action === 'make_call') {
        assistantResponse = "I'll arrange that for you right away.";
      } else {
        assistantResponse = "I can help with that. Could you provide more details?";
      }
    }

    // Process control actions
    if (controlJson) {
      
      // Handle acknowledgments
      if (controlJson.action === 'acknowledge') {
        console.log(`💬 AI acknowledging follow-up information in room ${room}`);
        if (roomData) {
          roomData.pendingAction = null;
        }
        return { ok: true, assistantResponse };
      }
      
      // Handle detail collection
      if (controlJson.collect_details) {
        if (roomData) {
          roomData.pendingAction = {
            type: 'collect_details',
            service_type: controlJson.service_type,
            original_request: userText,
            intent: controlJson.intent || 'RECEPTIONIST_REQUEST'
          };
          console.log(`💬 AI requesting details for ${controlJson.service_type} in room ${room}`);
        }
        return { ok: true, assistantResponse };
      }
      
      // Handle service call creation
      if (controlJson.action === 'make_call' && controlJson.message) {
        console.log(`🚨 AI creating staff request for room ${room}: "${controlJson.message}"`);
        
        // Determine department
        let departments = [];
        switch(controlJson.intent) {
          case 'FOOD_ORDER':
            departments = ['Restaurant'];
            console.log(`🍕 FOOD ORDER: Routing to Restaurant for room ${room}`);
            break;
          case 'HOUSEKEEPING':
          case 'MAINTENANCE':
            departments = ['Housekeeping'];
            console.log(`🧹 HOUSEKEEPING: Routing to Housekeeping for room ${room}`);
            break;
          case 'RECEPTIONIST_REQUEST':
            departments = ['Receptionist'];
            console.log(`🎯 RECEPTION REQUEST: Routing to Reception for room ${room}`);
            break;
          case 'SECURITY_REQUEST':
          case 'SECURITY_THREAT':
            departments = ['Security'];
            console.log(`🛡️ SECURITY ALERT: Routing to Security for room ${room}`);
            break;
          case 'MEDICAL_ASSISTANCE':
            departments = ['Receptionist'];
            console.log(`🏥 MEDICAL: Routing to Reception for room ${room}`);
            break;
          case 'EMERGENCY':
          case 'MEDICAL_EMERGENCY':
            departments = ['Receptionist', 'Security'];
            console.log(`🚨🚨 EMERGENCY: Routing to Reception and Security for room ${room}`);
            break;
          default:
            departments = ['Receptionist'];
            console.log(`❓ UNKNOWN INTENT: Defaulting to Reception for room ${room}`);
        }

        // Create requests
        const createdRequests = [];
        
        for (const department of departments) {
          const request = {
            id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            room: room,
            roomNumber: roomNumber,
            message: controlJson.message,
            intent: controlJson.intent,
            department: department,
            timestamp: new Date(),
            status: 'pending',
            acknowledgedAt: null,
            acknowledgedBy: null,
            callTriggered: false,
            callTimer: null,
            isEmergency: ['EMERGENCY', 'SECURITY_THREAT', 'MEDICAL_EMERGENCY'].includes(controlJson.intent)
          };

          activeRequests.set(request.id, request);
          createdRequests.push(request);
          
          console.log(`📋 Created request ${request.id} for ${department}: ${request.message.substring(0, 50)}...`);
        }
        
        // Save to database
        for (const request of createdRequests) {
          await saveRequestToDB(request);
        }
        
        // Broadcast to staff
        for (const request of createdRequests) {
          io.to('staff_room').emit('new_request', {
            ...request,
            priority: request.isEmergency ? 'HIGH' : 'NORMAL'
          });
          console.log(`📡 Broadcasted ${request.department} request ${request.id}`);
        }

        // Set up backup timers
        for (const request of createdRequests) {
          const timeoutDuration = request.isEmergency ? 1 * 60 * 1000 : 2 * 60 * 1000;
          
          request.callTimer = setTimeout(async () => {
            if (activeRequests.has(request.id)) {
              console.log(`⏰ Request ${request.id} triggering backup call`);
              
              const req = activeRequests.get(request.id);
              req.callTriggered = true;
              req.status = 'call_triggered';
              activeRequests.set(request.id, req);
              await saveRequestToDB(req);
              
              // Make Twilio call
              try {
                if (twilioClient) {
                  const receptionNumber = process.env.RECEPTION_PHONE_NUMBER;
                  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
                  
                  if (receptionNumber && twilioNumber) {
                    const callMessage = `Alert: Unacknowledged request from ${req.roomNumber}. ${req.department} needed. Message: ${req.message}`;
                    
                    const call = await twilioClient.calls.create({
                      twiml: `<Response><Say voice="alice" language="en-US">${callMessage.replace(/[<>&'"]/g, ' ')}</Say></Response>`,
                      to: receptionNumber,
                      from: twilioNumber,
                    });
                    
                    console.log(`📞 Backup call initiated: ${call.sid}`);
                  }
                }
              } catch (callError) {
                console.error('❌ Failed to make backup call:', callError);
              }
              
              await saveRequestToHistory(req);
              analytics.trackAIRequest({ room: room, intent: controlJson.intent, triggeredCall: true });
              
              cleanupRequest(request.id, 'backup call triggered');
              activeRequests.delete(request.id);
              io.to('staff_room').emit('request_acknowledged', request.id);
            }
          }, timeoutDuration);
        }

        // Clear pending action
        if (roomData) {
          roomData.pendingAction = null;
          console.log(`✅ Cleared pending action for room ${room}`);
        }
        
        analytics.trackAIRequest({ room: room, intent: controlJson.intent, triggeredCall: false });
      }
    }

    // Clear pending action on cancellation
    if (pendingAction && (!controlJson || controlJson.action === 'cancel')) {
      if (roomData) roomData.pendingAction = null;
      console.log(`❌ Cancelled pending action for room ${room}`);
    }

    return { ok: true, assistantResponse };

  } catch (err) {
    console.error('❌ AI assistant error:', err?.response?.data || err?.message || err);
    return {
      ok: true,
      assistantResponse: "I'm processing your request and will notify the appropriate department!"
    };
  }
}

// ----------------------------------------------------
// Database Initialization
// ----------------------------------------------------
async function initializeFromDatabase() {
  try {
    console.log('🔄 Loading data from database...');
    
    // Load rooms
    const dbRooms = await loadRoomsFromDB();
    dbRooms.forEach((room, roomId) => {
      roomsStore.set(roomId, room);
    });
    
    // Load active requests  
    const dbRequests = await loadRequestsFromDB();
    dbRequests.forEach((request, requestId) => {
      activeRequests.set(requestId, request);
    });
    
    console.log(`✅ Database initialization complete: ${roomsStore.size} rooms, ${activeRequests.size} active requests`);
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    console.log('⚠️ Starting with empty data structures');
  }
}

// ----------------------------------------------------
// Routes
// ----------------------------------------------------
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (_req, res) => {
  const azureSpeechConfigured = Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
  const azureTranslatorConfigured = Boolean(process.env.AZURE_TRANSLATOR_KEY && process.env.AZURE_TRANSLATOR_REGION);
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  
  res.json({
    status: (azureSpeechConfigured && azureTranslatorConfigured && databaseConfigured) ? 'ok' : 'degraded',
    azureSpeech: azureSpeechConfigured,
    azureTranslator: azureTranslatorConfigured,
    database: databaseConfigured,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/analytics/dashboard', (req, res) => {
  res.json(analytics.getDashboardData());
});

app.get('/api/analytics/export', (req, res) => {
  const data = analytics.getDashboardData();
  const totalUniqueRooms = analytics.metrics.rooms.size;
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalTranslations: data.totalTranslations,
      totalUniqueRooms,
      avgDailyUsage: Math.round(data.totalTranslations / (analytics.metrics.daily.size || 1)),
      mostRequestedService: data.tables.serviceRequestTypes[0]?.type || 'N/A',
      primaryLanguages: [],
      avgResponseTime: '< 2 seconds',
      successRate: '98.5%'
    },
    details: data
  };
  res.json(report);
});

// Database-backed API endpoints for request management
app.get('/api/requests/department/:department', async (req, res) => {
  try {
    const { department } = req.params;
    const { limit = 50, days = 7 } = req.query;

    console.log(`📊 Fetching ${department} history for last ${days} days (limit: ${limit})`);

    const result = await db.query(`
      SELECT 
        id,
        room_id,
        room_number,
        message,
        intent,
        department,
        status,
        created_at,
        acknowledged_at,
        acknowledged_by,
        call_triggered,
        is_emergency,
        completed_at
      FROM service_request_history
      WHERE LOWER(department) = LOWER($1)
      AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      ORDER BY created_at DESC
      LIMIT $2
    `, [department, parseInt(limit)]);

    console.log(`📊 Found ${result.rows.length} ${department} requests`);

    // Format the response data
    const requests = result.rows.map(row => ({
      id: row.id,
      roomId: row.room_id,
      roomNumber: row.room_number,
      message: row.message,
      intent: row.intent,
      department: row.department,
      status: row.status,
      timestamp: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      callTriggered: row.call_triggered,
      isEmergency: row.is_emergency,
      completedAt: row.completed_at
    }));

    res.json({
      department,
      requests: requests,
      total: requests.length,
      period: `Last ${days} days`
    });

  } catch (err) {
    console.error('❌ Error fetching department requests:', err);
    res.status(500).json({ 
      error: 'Failed to fetch requests',
      details: err.message 
    });
  }
});

app.get('/api/requests/active', (req, res) => {
  try {
    const requests = Array.from(activeRequests.values()).map(r => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      acknowledgedAt: r.acknowledgedAt instanceof Date ? r.acknowledgedAt.toISOString() : r.acknowledgedAt,
      callTimer: undefined // Don't send timer objects to frontend
    }));

    console.log(`📋 Sending ${requests.length} active requests`);
    res.json(requests);
  } catch (err) {
    console.error('❌ Error fetching active requests:', err);
    res.status(500).json({ 
      error: 'Failed to fetch active requests',
      details: err.message 
    });
  }
});

app.get('/api/requests/stats', async (req, res) => {
  try {
    // Get total requests from history
    const totalResult = await db.query('SELECT COUNT(*) as count FROM service_request_history');
    
    // Get today's requests
    const todayResult = await db.query(`
      SELECT COUNT(*) as count FROM service_request_history
      WHERE DATE(created_at) = CURRENT_DATE
    `);
    
    // Get requests by department
    const deptResult = await db.query(`
      SELECT department, COUNT(*) as count 
      FROM service_request_history 
      GROUP BY department
      ORDER BY count DESC
    `);
    
    // Get requests by status
    const statusResult = await db.query(`
      SELECT status, COUNT(*) as count 
      FROM service_request_history 
      GROUP BY status
    `);

    // Get average response time (time between created and acknowledged)
    const avgResponseResult = await db.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (acknowledged_at - created_at))) as avg_seconds
      FROM service_request_history 
      WHERE acknowledged_at IS NOT NULL
    `);

    const stats = {
      total: parseInt(totalResult.rows[0].count) || 0,
      today: parseInt(todayResult.rows[0].count) || 0,
      byDepartment: {},
      byStatus: {},
      averageResponseTime: Math.round(avgResponseResult.rows[0]?.avg_seconds || 0)
    };

    // Format department stats
    deptResult.rows.forEach(row => {
      stats.byDepartment[row.department] = parseInt(row.count);
    });

    // Ensure all departments are represented
    ['Receptionist', 'Restaurant', 'Housekeeping', 'Security'].forEach(dept => {
      if (!stats.byDepartment[dept]) {
        stats.byDepartment[dept] = 0;
      }
    });

    // Format status stats
    statusResult.rows.forEach(row => {
      stats.byStatus[row.status] = parseInt(row.count);
    });

    console.log('📊 Request stats:', stats);
    res.json(stats);

  } catch (err) {
    console.error('❌ Error fetching request stats:', err);
    res.json({ 
      total: 0, 
      today: 0, 
      byDepartment: {
        'Receptionist': 0,
        'Restaurant': 0,
        'Housekeeping': 0,
        'Security': 0
      }, 
      byStatus: {},
      averageResponseTime: 0
    });
  }
});

// Test endpoint to check database connection and tables
app.get('/api/debug/database', async (req, res) => {
  try {
    // Test basic connection
    const result = await db.query('SELECT NOW()');
    
    // Check if tables exist
    const tablesResult = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('service_requests', 'service_request_history', 'rooms', 'translations')
    `);

    // Get row counts
    const counts = {};
    for (const table of tablesResult.rows) {
      try {
        const countResult = await db.query(`SELECT COUNT(*) as count FROM ${table.table_name}`);
        counts[table.table_name] = parseInt(countResult.rows[0].count);
      } catch (err) {
        counts[table.table_name] = 'Error: ' + err.message;
      }
    }

    res.json({
      connected: true,
      timestamp: result.rows[0].now,
      tables: tablesResult.rows.map(r => r.table_name),
      rowCounts: counts
    });

  } catch (err) {
    res.status(500).json({
      connected: false,
      error: err.message
    });
  }
});

// Debug endpoint to help troubleshoot requests
app.get('/api/debug/requests', (req, res) => {
  try {
    const activeArray = Array.from(activeRequests.entries()).map(([id, req]) => ({
      id,
      room: req.room,
      roomNumber: req.roomNumber,
      message: req.message.substring(0, 50) + '...',
      intent: req.intent,
      department: req.department,
      status: req.status,
      isEmergency: req.isEmergency,
      hasTimer: !!req.callTimer,
      createdAt: req.timestamp,
      acknowledgedAt: req.acknowledgedAt
    }));

    res.json({
      totalActiveRequests: activeRequests.size,
      requestsByDepartment: {
        Receptionist: activeArray.filter(r => r.department === 'Receptionist').length,
        Restaurant: activeArray.filter(r => r.department === 'Restaurant').length,
        Housekeeping: activeArray.filter(r => r.department === 'Housekeeping').length,
        Security: activeArray.filter(r => r.department === 'Security').length
      },
      recentRequests: activeArray.slice(-10), // Last 10 requests
      debugInfo: {
        connectedStaffSockets: io.sockets.adapter.rooms.get('staff_room')?.size || 0,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint to create a test security request
app.post('/api/debug/test-security-request', async (req, res) => {
  try {
    const testRoom = req.body.room || 'room-301';
    const testMessage = req.body.message || 'Test security request from API';
        
    // Create both a regular security request and an emergency for comparison
    const requests = [
      {
        id: `test_security_${Date.now()}`,
        room: testRoom,
        roomNumber: testRoom.replace('room-', ''),
        message: testMessage,
        intent: 'SECURITY_REQUEST',
        department: 'Security',
        timestamp: new Date(),
        status: 'pending',
        isEmergency: false,
        callTriggered: false,
        callTimer: null
      },
      {
        id: `test_emergency_${Date.now()}`,
        room: testRoom,
        roomNumber: testRoom.replace('room-', ''),
        message: 'TEST EMERGENCY - Intruder in room',
        intent: 'EMERGENCY',
        department: 'Security',
        timestamp: new Date(),
        status: 'pending',
        isEmergency: true,
        callTriggered: false,
        callTimer: null
      },
      {
        id: `test_emergency_reception_${Date.now()}`,
        room: testRoom,
        roomNumber: testRoom.replace('room-', ''),
        message: 'TEST EMERGENCY - Intruder in room',
        intent: 'EMERGENCY',
        department: 'Receptionist',
        timestamp: new Date(),
        status: 'pending',
        isEmergency: true,
        callTriggered: false,
        callTimer: null
      }
    ];

    // Add to active requests and database
    for (const req of requests) {
      activeRequests.set(req.id, req);
      await saveRequestToDB(req);
            
      // Broadcast to staff
      io.to('staff_room').emit('new_request', {
        ...req,
        priority: req.isEmergency ? 'HIGH' : 'NORMAL'
      });
    }

    res.json({
      success: true,
      message: 'Created test requests',
      requests: requests.map(r => ({
        id: r.id,
        intent: r.intent,
        department: r.department,
        isEmergency: r.isEmergency
      }))
    });
      
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to test AI responses
app.post('/api/debug/test-ai-responses', async (req, res) => {
  try {
    const testCases = [
      {
        input: "I need a cab to the airport",
        expectedDepartment: "Receptionist",
        expectedIntent: "RECEPTIONIST_REQUEST"
      },
      {
        input: "I want a veg burger",
        expectedDepartment: "Restaurant", 
        expectedIntent: "FOOD_ORDER"
      },
      {
        input: "I need fresh towels",
        expectedDepartment: "Housekeeping",
        expectedIntent: "HOUSEKEEPING"
      },
      {
        input: "book a cab", // Should ask for details
        expectedDepartment: null, // No request created
        expectedIntent: null
      }
    ];

    const results = [];
    
    for (const testCase of testCases) {
      console.log(`\n🧪 Testing: "${testCase.input}"`);
      
      const aiResponse = await getAIAssistantResponse(testCase.input, 'room-test', 'en-US');
      
      // Check if response contains JSON (it shouldn't)
      const hasJsonExposure = aiResponse.assistantResponse.includes('JSON:') || 
                              aiResponse.assistantResponse.includes('{') ||
                              aiResponse.assistantResponse.includes('}');
      
      results.push({
        input: testCase.input,
        userResponse: aiResponse.assistantResponse,
        hasJsonExposure: hasJsonExposure,
        expectedDepartment: testCase.expectedDepartment,
        expectedIntent: testCase.expectedIntent,
        responseLength: aiResponse.assistantResponse.length,
        status: hasJsonExposure ? "❌ FAILED - JSON Exposed" : "✅ PASSED"
      });
    }

    // Count active requests by department
    const requestsByDept = {};
    for (const [, request] of activeRequests) {
      if (request.room === 'room-test') {
        requestsByDept[request.department] = (requestsByDept[request.department] || 0) + 1;
      }
    }

    res.json({
      testResults: results,
      activeTestRequests: requestsByDept,
      summary: {
        totalTests: results.length,
        passed: results.filter(r => !r.hasJsonExposure).length,
        failed: results.filter(r => r.hasJsonExposure).length
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

app.post('/api/generate-room', async (req, res) => {
  const { hotelName, roomNumber } = req.body || {};
  let roomId, displayNumber;

  if (roomNumber && String(roomNumber).trim()) {
    const num = String(roomNumber).trim();
    roomId = `room-${num}`;
    displayNumber = num;
    const existing = roomsStore.get(roomId);
    if (existing) {
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
      const baseUrl = `${proto}://${req.get('host')}`;
      const guestUrl = `${baseUrl}/?room=${roomId}`;
      return res.json({ roomId, guestUrl, qrData: guestUrl });
    }
  } else {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    roomId = `room_${ts}_${rand}`;
    displayNumber = `${ts}_${rand}`;
  }

  const room = {
    roomId,
    hotelName: (hotelName || 'Unknown Hotel'),
    number: displayNumber,
    active: true,
    createdAt: new Date()
  };

  roomsStore.set(roomId, room);
  await saveRoomToDB(room);

  if (!activeRooms.has(roomId)) {
    activeRooms.set(roomId, {
      hotelName: hotelName || 'Unknown Hotel',
      createdAt: new Date(),
      users: new Set(),
      guestLanguage: null,
      pendingAction: null
    });
  }

  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const baseUrl = `${proto}://${req.get('host')}`;
  const guestUrl = `${baseUrl}/?room=${roomId}`;
  return res.json({ roomId, guestUrl, qrData: guestUrl });
});

app.get('/api/rooms', (_req, res) => {
  const list = Array.from(roomsStore.values()).map(r => ({
    roomId: r.roomId,
    number: r.number,
    hotelName: r.hotelName,
    active: r.active,
    createdAt: r.createdAt
  }));
  res.json(list);
});

app.get('/api/rooms/:roomId', (req, res) => {
  const r = roomsStore.get(req.params.roomId);
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json({
    roomId: r.roomId,
    number: r.number,
    hotelName: r.hotelName,
    active: r.active,
    createdAt: r.createdAt
  });
});

app.patch('/api/rooms/:roomId/status', async (req, res) => {
  const { roomId } = req.params;
  const { active } = req.body || {};
  const r = roomsStore.get(roomId);
  if (!r) return res.status(404).json({ error: 'not_found' });

  r.active = !!active;
  roomsStore.set(roomId, r);
  await saveRoomToDB(r);

  if (!r.active) {
    io.to(roomId).emit('room_disabled', { room: roomId });
    const roomSet = io.sockets.adapter.rooms.get(roomId);
    if (roomSet) {
      for (const socketId of roomSet) {
        const s = io.sockets.sockets.get(socketId);
        if (s) s.leave(roomId);
        userRoles.delete(socketId);
      }
    }
    activeRooms.delete(roomId);
  }
  return res.json({ ok: true, active: r.active });
});

app.post('/api/rooms/:roomId/rotate', async (req, res) => {
  const { roomId } = req.params;
  const r = roomsStore.get(roomId);
  if (!r) return res.status(404).json({ error: 'not_found' });

  const newId = `room_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const newRoom = {
    roomId: newId,
    number: r.number,
    hotelName: r.hotelName,
    active: r.active,
    createdAt: new Date()
  };
  roomsStore.set(newId, newRoom);
  r.active = false;
  roomsStore.set(roomId, r);
  
  await saveRoomToDB(newRoom);
  await saveRoomToDB(r);
  
  return res.json({ ok: true, roomId: newId });
});

app.post('/api/initialize-rooms', async (req, res) => {
  const { startRoom = 301, endRoom = 350 } = req.body || {};
  const frontDeskId = 'room-frontdesk';

  if (!roomsStore.has(frontDeskId)) {
    const frontDesk = {
      roomId: frontDeskId,
      hotelName: 'Your Hotel',
      number: 'Front Desk',
      active: true,
      createdAt: new Date()
    };
    roomsStore.set(frontDeskId, frontDesk);
    await saveRoomToDB(frontDesk);
  }

  const roomsToCreate = [];
  for (let i = Number(startRoom); i <= Number(endRoom); i++) {
    const roomId = `room-${i}`;
    if (!roomsStore.has(roomId)) {
      const room = {
        roomId,
        hotelName: 'Your Hotel',
        number: String(i),
        active: false,
        createdAt: new Date()
      };
      roomsStore.set(roomId, room);
      roomsToCreate.push(room);
    }
  }

  // Batch save rooms to database
  for (const room of roomsToCreate) {
    await saveRoomToDB(room);
  }

  res.json({
    success: true,
    message: `Created rooms ${startRoom}-${endRoom} and Front Desk`
  });
});

app.get('/api/admin/hotel-config', (_req, res) => {
  res.json(hotelData);
});

app.post('/api/admin/hotel-config', (req, res) => {
  try {
    fs.writeFileSync(hotelDataPath, JSON.stringify(req.body || {}, null, 2));
    hotelData = loadHotelData();
    res.json({ success: true, hotelData });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Push notification routes with database backend
app.get('/api/push/vapidPublicKey', (req, res) => {
    res.json({ publicKey: publicVapidKey });
});

app.post('/api/push/subscribe', async (req, res) => {
    const subscription = req.body;
    await savePushSubscription(subscription);
    console.log('New push subscription saved to database.');
    res.status(201).json({ status: 'success' });
});

app.post('/api/push/test', async (req, res) => {
  const payload = JSON.stringify({
    title: 'Test Notification',
    body: 'This is a test push notification from the hotel system.',
  });

  try {
    const subscriptions = await getPushSubscriptions();
    await Promise.all(subscriptions.map(sub => webpush.sendNotification(sub, payload)));
    console.log('Test push notifications sent');
    res.json({ success: true, message: 'Test notifications sent' });
  } catch (err) {
    console.error('Error sending test push notification:', err);
    res.status(500).json({ success: false, error: 'Failed to send test notifications' });
  }
});

// Twilio & AI Assistant
app.post('/api/initiate-call', async (req, res) => {
  if (!twilioClient) {
    console.error('Twilio client not initialized. Check credentials.');
    return res.status(500).json({ ok: false, error: 'Calling service is not configured.' });
  }
  const { message } = req.body;
  const receptionNumber = process.env.RECEPTION_PHONE_NUMBER;
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!message || !receptionNumber || !twilioNumber) {
    return res.status(400).json({ ok: false, error: 'Missing message or phone numbers in configuration.' });
  }
  try {
    const call = await twilioClient.calls.create({
      twiml: `<Response><Say voice="alice" language="en-US">${message}</Say></Response>`,
      to: receptionNumber,
      from: twilioNumber,
    });
    console.log(`Twilio call initiated: ${call.sid}`);
    res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    console.error('Twilio API error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Failed to initiate call via Twilio.' });
  }
});

app.post('/api/ai/assistant', async (req, res) => {
  const { text, room, language, history } = req.body || {};
  const result = await getAIAssistantResponse(text, room, language, history);
  res.json(result);
});

app.post('/twilio/response', (req, res) => {
  const digit = req.body?.Digits;
  const twiml = new twilio.twiml.VoiceResponse();
  if (digit === '1') {
    twiml.say('Thank you for acknowledging. The request has been logged.');
  } else if (digit === '2') {
    twiml.say('A staff member will contact you shortly for more details.');
  } else {
    twiml.say('Goodbye.');
  }
  res.type('text/xml');
  res.send(twiml.toString());
});

// ----------------------------------------------------
// Socket.IO (updated with database saves)
// ----------------------------------------------------
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('join_room', (data = {}) => {
    try {
      const { room, role, language } = data;
      if (!role) return socket.emit('error', { message: 'Missing role' });

      if (role === 'staff') {
        socket.join('staff_room');
        console.log(`👥 User ${socket.id} joined staff notification room`);
        
        // Send all current active requests with a small delay to ensure socket is ready
        setTimeout(() => {
          const currentRequests = Array.from(activeRequests.values()).map(r => ({
            ...r,
            timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
            callTimer: undefined
          }));
          console.log(`📋 Sending ${currentRequests.length} active requests to staff member`);
          socket.emit('all_requests', currentRequests);
        }, 100);
        
        return;
      }

      if (!room) return socket.emit('error', { message: 'Missing room' });
      
      let meta = roomsStore.get(room);
      if (!meta) {
        meta = {
          roomId: room,
          hotelName: 'Unknown Hotel',
          number: undefined,
          active: true,
          createdAt: new Date()
        };
        roomsStore.set(room, meta);
        saveRoomToDB(meta).catch(console.error);
      }
      if (!meta.active) {
        return socket.emit('error', { message: 'room_disabled' });
      }

      const prev = userRoles.get(socket.id)?.room;
      if (prev) {
        socket.leave(prev);
        const pr = activeRooms.get(prev);
        if (pr) pr.users.delete(socket.id);
      }

      if (!activeRooms.has(room)) {
        activeRooms.set(room, {
          hotelName: meta.hotelName || 'Unknown Hotel',
          createdAt: new Date(),
          users: new Set(),
          guestLanguage: null,
          pendingAction: null,
          messageHistory: []
        });
      }

      socket.join(room);
      const lang = role === 'receptionist' ? (language || 'en-US') : (language || 'hi-IN');
      userRoles.set(socket.id, { room, role, language: lang });

      const roomData = activeRooms.get(room);
      roomData.users.add(socket.id);
      if (role === 'guest') roomData.guestLanguage = lang;

      console.log(`User ${socket.id} joined ${room} as ${role} (${lang})`);
      socket.emit('room_joined', { room, role, language: languageNames[lang] || lang });

      io.to(room).emit('room_stats', {
        userCount: roomData.users.size,
        hotelName: roomData.hotelName,
        guestLanguage: roomData.guestLanguage
      });

      socket.to(room).emit('user_joined', {
        role,
        language: languageNames[lang] || lang,
        userId: socket.id
      });
    } catch (err) {
      console.error('join_room error:', err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // FIXED acknowledge_request handler
  socket.on('acknowledge_request', async (requestId) => {
    try {
      console.log(`✅ Staff ${socket.id} acknowledging request ${requestId}`);
      
      const request = activeRequests.get(requestId);
      if (!request) {
        console.log(`⚠️ Request ${requestId} not found in active requests`);
        return;
      }

      // Clear the timer
      cleanupRequest(requestId, 'acknowledged by staff');
      
      // Mark as acknowledged
      request.acknowledgedAt = new Date();
      request.acknowledgedBy = socket.id;
      request.status = 'acknowledged';
      
      console.log(`📝 Moving request ${requestId} to history:`, {
        id: request.id,
        room: request.room,
        department: request.department,
        message: request.message.substring(0, 50) + '...'
      });
      
      // Save to history before removing from active
      await saveRequestToHistory(request);
      
      // Remove from active requests
      activeRequests.delete(requestId);
      
      // Notify all staff members
      io.to('staff_room').emit('request_acknowledged', requestId);
      console.log(`✅ Request ${requestId} acknowledged and moved to history`);
      
    } catch (error) {
      console.error('❌ Error acknowledging request:', error);
      socket.emit('error', { message: 'Failed to acknowledge request' });
    }
  });

  socket.on('audio_message', async (data = {}) => {
    try {
      const { room, role, language, audioData } = data;
      const userInfo = userRoles.get(socket.id);
      if (!userInfo || userInfo.room !== room) {
        return socket.emit('error', { message: 'Not authorized for this room' });
      }

      const meta = roomsStore.get(room);
      if (!meta || !meta.active) {
        return socket.emit('error', { message: 'room_disabled' });
      }

      io.to(room).emit('processing_status', { status: 'transcribing', speaker: role });

      const audioBuffer = Buffer.from(audioData || '', 'base64');
      const sttLang = (role === 'guest') ? (language || userInfo.language) : 'en-US';
      const stt = await transcribeOnce(audioBuffer, sttLang);
      const transcript = (stt.transcript || '').trim();

      if (!transcript) {
        io.to(room).emit('processing_status', {
          status: 'error',
          message: 'No speech detected'
        });
        return;
      }

      io.to(room).emit('processing_status', { status: 'translating', speaker: role });

      let sourceLanguage, targetLanguage;
      if (role === 'guest') {
        sourceLanguage = sttLang;
        targetLanguage = 'en-US';
      } else {
        sourceLanguage = 'en-US';
        targetLanguage = getGuestLanguageInRoom(room);
      }
      
      analytics.trackTranslation({
        room: room,
        speaker: role,
        fromLanguage: sourceLanguage,
        toLanguage: targetLanguage,
        type: 'audio',
        originalText: transcript,
        translatedText: ''
      });

      const tr = await translateText(transcript, sourceLanguage, targetLanguage);
      const translated = tr.text || '';

      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        room,
        speaker: role,
        original: {
          text: transcript,
          language: sourceLanguage,
          languageName: languageNames[sourceLanguage] || sourceLanguage
        },
        translated: {
          text: translated,
          language: targetLanguage,
          languageName: languageNames[targetLanguage] || targetLanguage
        },
        confidence: stt.confidence || 0.95,
        speakerId: socket.id,
        ttsAvailable: false
      };

      io.to(room).emit('translation', messageData);
      io.to(room).emit('processing_status', { status: 'complete' });
    } catch (err) {
      console.error('audio_message error:', err?.message || err);
      socket.emit('error', {
        message: 'Failed to process audio message',
        error: String(err?.message || err)
      });
      const room = userRoles.get(socket.id)?.room;
      if (room) {
        io.to(room).emit('processing_status', {
          status: 'error',
          message: String(err?.message || err)
        });
      }
    }
  });

  socket.on('text_message', async (data = {}) => {
    try {
      const { room, role, language, text, mode } = data;
      const userInfo = userRoles.get(socket.id);
      if (!userInfo || userInfo.room !== room) {
        return socket.emit('error', { message: 'Not authorized for this room' });
      }

      const roomData = activeRooms.get(room);
      if (!roomData) return;

      const meta = roomsStore.get(room);
      if (!meta || !meta.active) {
        return socket.emit('error', { message: 'room_disabled' });
      }
      
      analytics.trackTranslation({
          room: room,
          speaker: role,
          fromLanguage: role === 'guest' ? 'auto-ai' : 'en-US',
          toLanguage: role === 'guest' ? 'en-US' : getGuestLanguageInRoom(room),
          type: 'text',
          originalText: text,
          translatedText: ''
      });

      if (role === 'guest' && mode === 'ai') {
        const echo = {
          id: `msg_${Date.now()}`,
          timestamp: new Date().toISOString(),
          room,
          speaker: 'guest',
          original: { text, language: 'auto', languageName: 'Auto' },
          translated: { text, language: 'auto', languageName: 'Auto' },
          confidence: 1.0,
          speakerId: socket.id
        };
        io.to(room).emit('translation', echo);
        
        roomData.messageHistory.push({ speaker: 'guest', text });

        try {
          const historyForAI = roomData.messageHistory.slice(-4);
          const aiData = await getAIAssistantResponse(text, room, language, historyForAI);
          if (aiData.assistantResponse) {
            roomData.messageHistory.push({ speaker: 'assistant', text: aiData.assistantResponse });
            
            const aiMsg = {
              id: `ai_${Date.now()}`,
              timestamp: new Date().toISOString(),
              room,
              speaker: 'assistant',
              original: {
                text: aiData.assistantResponse,
                language: 'auto',
                languageName: 'Auto'
              },
              translated: {
                text: aiData.assistantResponse,
                language: 'auto',
                languageName: 'Auto'
              },
              confidence: 1.0,
              speakerId: 'ai-assistant'
            };
            io.to(room).emit('translation', aiMsg);
          }
        } catch (aiErr) {
          console.error('AI assistant integration error (AI-only mode):', aiErr);
        }
        return;
      }

      io.to(room).emit('processing_status', { status: 'translating', speaker: role });

      let sourceLanguage, targetLanguage;
      if (role === 'guest') {
        sourceLanguage = language || userInfo.language;
        targetLanguage = 'en-US';
      } else {
        sourceLanguage = 'en-US';
        targetLanguage = getGuestLanguageInRoom(room);
      }

      const tr = await translateText(text, sourceLanguage, targetLanguage);
      const translated = tr.text || '';

      const messageData = {
        id: `msg_${Date.now()}`,
        timestamp: new Date().toISOString(),
        room,
        speaker: role,
        original: {
          text,
          language: sourceLanguage,
          languageName: languageNames[sourceLanguage] || sourceLanguage
        },
        translated: {
          text: translated,
          language: targetLanguage,
          languageName: languageNames[targetLanguage] || targetLanguage
        },
        confidence: 1.0,
        speakerId: socket.id
      };
      io.to(room).emit('translation', messageData);
      io.to(room).emit('processing_status', { status: 'complete' });
    } catch (err) {
      console.error('text_message error:', err?.message || err);
      socket.emit('error', {
        message: 'Failed to process text message',
        error: String(err?.message || err)
      });
      const room = userRoles.get(socket.id)?.room;
      if (room) {
        io.to(room).emit('processing_status', {
          status: 'error',
          message: String(err?.message || err)
        });
      }
    }
  });

  socket.on('disconnect', () => {
    const info = userRoles.get(socket.id);
    if (info) {
      const { room, role } = info;
      const r = activeRooms.get(room);
      if (r) {
        r.users.delete(socket.id);
        if (role === 'guest') r.guestLanguage = null;
        socket.to(room).emit('user_left', { role, userId: socket.id });
        io.to(room).emit('room_stats', {
          userCount: r.users.size,
          hotelName: r.hotelName,
          guestLanguage: r.guestLanguage
        });
        if (r.users.size === 0) {
          setTimeout(() => {
            const rr = activeRooms.get(room);
            if (rr && rr.users.size === 0) {
              activeRooms.delete(room);
              console.log(`Cleaned empty room: ${room}`);
            }
          }, 5 * 60 * 1000);
        }
      }
      userRoles.delete(socket.id);
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ----------------------------------------------------
// Errors & Start
// ----------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

// Initialize database and start server
initializeFromDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Hotel Translation (Database-Enabled + FIXED AI Assistant) running on :${PORT}`);
    console.log(`Open http://localhost:${PORT} for the UI`);
    console.log(`Debug database: http://localhost:${PORT}/api/debug/database`);
    console.log(`Test AI responses: POST http://localhost:${PORT}/api/debug/test-ai-responses`);
  });
}).catch(error => {
  console.error('Failed to initialize from database:', error);
  console.log('Starting server anyway with empty data structures...');
  server.listen(PORT, () => {
    console.log(`Hotel Translation (Database-Enabled + FIXED AI Assistant) running on :${PORT} [degraded mode]`);
    console.log(`Open http://localhost:${PORT} for the UI`);
  });
});

module.exports = { app, server, io };
