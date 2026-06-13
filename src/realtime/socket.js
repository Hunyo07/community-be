let ioInstance = null;

export const initializeSocket = (io) => {
  ioInstance = io;

  io.on('connection', (socket) => {
    socket.emit('realtime:connected', {
      message: 'Connected to CommUnity realtime service',
      socketId: socket.id
    });
  });
};

export const emitRealtimeEvent = (event, payload) => {
  if (!ioInstance) return;
  ioInstance.emit(event, payload);
};
