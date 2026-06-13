import http from 'node:http';
import { Server } from 'socket.io';
import app from './app.js';
import { env } from './config/env.js';
import { pool, testConnection } from './config/db.js';
import { ensureCoreSchema } from './database/ensureSchema.js';
import { initializeSocket } from './realtime/socket.js';

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: env.clientOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

initializeSocket(io);

const startServer = async () => {
  try {
    await testConnection();
    const connection = await pool.getConnection();
    try {
      await ensureCoreSchema(connection);
    } finally {
      connection.release();
    }
    console.log('Connected to MySQL database');

    httpServer.listen(env.port, () => {
      console.log(`API server running on http://localhost:${env.port}`);
      console.log('Socket.IO realtime service is ready');
    });
  } catch (error) {
    console.error('Failed to start API server');
    console.error(error.message);
    process.exit(1);
  }
};

startServer();
