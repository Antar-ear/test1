const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Room functions
const saveRoom = async (roomId, hotelName, roomNumber) => {
  const query = `
    INSERT INTO rooms (room_id, hotel_name, room_number) 
    VALUES ($1, $2, $3) 
    ON CONFLICT (room_id) DO UPDATE SET 
      hotel_name = $2, room_number = $3
    RETURNING *
  `;
  const result = await pool.query(query, [roomId, hotelName, roomNumber]);
  return result.rows[0];
};

const getRooms = async () => {
  const result = await pool.query('SELECT * FROM rooms ORDER BY created_at DESC');
  return result.rows;
};

const updateRoomStatus = async (roomId, isActive) => {
  const query = 'UPDATE rooms SET is_active = $1 WHERE room_id = $2 RETURNING *';
  const result = await pool.query(query, [isActive, roomId]);
  return result.rows[0];
};

// Translation functions
const saveTranslation = async (roomId, speaker, originalText, translatedText, langFrom, langTo) => {
  const query = `
    INSERT INTO translations (room_id, speaker, original_text, translated_text, language_from, language_to)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  const result = await pool.query(query, [roomId, speaker, originalText, translatedText, langFrom, langTo]);
  return result.rows[0];
};

// Service request functions
const saveServiceRequest = async (roomId, department, message, priority = 'normal', isEmergency = false) => {
  const query = `
    INSERT INTO service_requests (room_id, department, message, priority, is_emergency)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  const result = await pool.query(query, [roomId, department, message, priority, isEmergency]);
  return result.rows[0];
};

const getActiveRequests = async () => {
  const query = `
    SELECT * FROM service_requests 
    WHERE status = 'pending' 
    ORDER BY is_emergency DESC, created_at DESC
  `;
  const result = await pool.query(query);
  return result.rows;
};

const acknowledgeRequest = async (requestId) => {
  const query = `
    UPDATE service_requests 
    SET status = 'acknowledged', acknowledged_at = NOW() 
    WHERE id = $1 
    RETURNING *
  `;
  const result = await pool.query(query, [requestId]);
  return result.rows[0];
};

// Analytics functions
const updateDailyAnalytics = async () => {
  const today = new Date().toISOString().split('T')[0];
  
  // Get today's counts
  const translationsResult = await pool.query(`
    SELECT COUNT(*) as count FROM translations 
    WHERE DATE(created_at) = $1
  `, [today]);
  
  const aiRequestsResult = await pool.query(`
    SELECT COUNT(*) as count FROM translations 
    WHERE DATE(created_at) = $1 AND speaker = 'assistant'
  `, [today]);
  
  const serviceCallsResult = await pool.query(`
    SELECT COUNT(*) as count FROM service_requests 
    WHERE DATE(created_at) = $1
  `, [today]);
  
  const activeRoomsResult = await pool.query(`
    SELECT COUNT(*) as count FROM rooms WHERE is_active = true
  `);
  
  // Save analytics
  const query = `
    INSERT INTO daily_analytics (date, translations_count, ai_requests_count, service_calls_count, active_rooms_count)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (date) DO UPDATE SET 
      translations_count = $2,
      ai_requests_count = $3,
      service_calls_count = $4,
      active_rooms_count = $5,
      updated_at = NOW()
  `;
  
  await pool.query(query, [
    today,
    translationsResult.rows[0].count,
    aiRequestsResult.rows[0].count,
    serviceCallsResult.rows[0].count,
    activeRoomsResult.rows[0].count
  ]);
};

const getAnalytics = async (days = 7) => {
  const query = `
    SELECT * FROM daily_analytics 
    WHERE date >= CURRENT_DATE - INTERVAL '${days} days'
    ORDER BY date DESC
  `;
  const result = await pool.query(query);
  return result.rows;
};

module.exports = {
  pool,
  saveRoom,
  getRooms,
  updateRoomStatus,
  saveTranslation,
  saveServiceRequest,
  getActiveRequests,
  acknowledgeRequest,
  updateDailyAnalytics,
  getAnalytics
};
