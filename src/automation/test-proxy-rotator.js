require('dotenv').config();
const connectDB = require('../config/db');
const ProxyRotator = require('../services/ProxyRotator');
const mongoose = require('mongoose');

async function test() {
  console.log('--- Starting ProxyRotator Multi-Proxy Workspace Test ---');
  
  // 1. Connect database
  await connectDB();
  
  // 2. Mock socket io
  const mockIo = {
    emit: (event, data) => {
      console.log(`[SOCKET EMIT] Event: "${event}", Data:`, JSON.stringify(data, null, 2));
    }
  };
  
  // 3. Initialize ProxyRotator
  ProxyRotator.init(mockIo);
  
  if (!ProxyRotator.enabled) {
    console.log('ProxyRotator is disabled in .env. Exiting...');
    await mongoose.connection.close();
    process.exit(0);
  }

  // 4. Run rotation for all slots concurrently
  console.log(`Running proxy fetch for all ${ProxyRotator.rotators.length} slots...`);
  await Promise.all(ProxyRotator.rotators.map(async (r) => {
    try {
      await ProxyRotator.forceRotate(r.index);
    } catch (err) {
      console.error(`Slot #${r.index} failed:`, err.message);
    }
  }));
  
  // 5. Print status
  console.log('Resulting Rotator Status:', JSON.stringify(ProxyRotator.getStatus(), null, 2));
  
  // 6. Close connection and exit
  console.log('Closing database connection...');
  await mongoose.connection.close();
  console.log('Test completed successfully.');
  process.exit(0);
}

test().catch(err => {
  console.error('Test failed with error:', err);
  mongoose.connection.close();
  process.exit(1);
});
