const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function setupDatabase() {
  try {
    // Create rooms table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(100) UNIQUE NOT NULL,
        hotel_name VARCHAR(255),
        room_number VARCHAR(10),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create translations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(100) NOT NULL,
        speaker VARCHAR(50),
        original_text TEXT,
        translated_text TEXT,
        language_from VARCHAR(10),
        language_to VARCHAR(10),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create service_requests table with string ID
    await pool.query(`
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
        is_emergency BOOLEAN DEFAULT false,
        priority VARCHAR(20) DEFAULT 'normal'
      )
    `);

    // Create daily_analytics table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_analytics (
        id SERIAL PRIMARY KEY,
        date DATE UNIQUE,
        translations_count INTEGER DEFAULT 0,
        ai_requests_count INTEGER DEFAULT 0,
        service_calls_count INTEGER DEFAULT 0,
        active_rooms_count INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('Database tables created successfully!');
  } catch (err) {
    console.error('Error setting up database:', err);
    throw err;
  }
}

setupDatabase();
