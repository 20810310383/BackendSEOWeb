require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');
const QueueManager = require('./queue/QueueManager');
const ProxyRotator = require('./services/ProxyRotator');

const app = express();
const server = http.createServer(app);

// Configure CORS
const corsOptions = {
  origin: '*', // Allow all origins for local/development testing
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
};
app.use(cors(corsOptions));
app.use(express.json());

// Routes
app.use('/api', apiRoutes);

// Healthy check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// Configure Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Initialize socket listeners
io.on('connection', (socket) => {
  console.log(`Socket client connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    console.log(`Socket client disconnected: ${socket.id}`);
  });
});

// Bootstrap application
async function bootstrap() {
  // 1. Connect MongoDB
  await connectDB();

  // 2. Bind Socket to QueueManager and start Scheduler
  QueueManager.initSocket(io);
  QueueManager.start();

  // 2.5. Initialize and start ProxyRotator
  ProxyRotator.init(io);
  ProxyRotator.start();

  // 3. Start Server
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` SEO TRAFFIC SIMULATOR BACKEND RUNNING ON PORT ${PORT}`);
    console.log(`===================================================`);
  });
}

bootstrap().catch((error) => {
  console.error('Fatal initialization error:', error.message);
  process.exit(1);
});
