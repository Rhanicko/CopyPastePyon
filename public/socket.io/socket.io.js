// InfinityFree cannot run Socket.IO. Leaving `io` undefined makes app.js use
// its built-in five-second polling fallback. Node deployments serve the real
// Socket.IO client at this path before static files are considered.
