let ioInstance = null;

// This module wires Socket.IO so the server can push live updates to browsers.
// Controllers call emitRealtimeEvent after data changes so open clients refresh.

// Stores the Socket.IO server and greets each newly connected client.
export const initializeSocket = (io) => {
  ioInstance = io;

  io.on('connection', (socket) => {
    socket.emit('realtime:connected', {
      message: 'Connected to CommUnity realtime service',
      socketId: socket.id
    });
  });
};

// Broadcasts a named event with a payload to every connected client.
export const emitRealtimeEvent = (event, payload) => {
  if (!ioInstance) return;
  ioInstance.emit(event, payload);
};
