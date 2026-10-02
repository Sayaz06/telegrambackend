/**
 * MyGram — MTProto WebSocket Proxy
 * Satu fail sahaja untuk Railway.
 * Tugasnya: jadi jambatan antara browser dan Telegram server.
 * Browser tak boleh connect terus ke Telegram sebab CORS.
 */
const http = require('http');
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

// Telegram DC addresses
const TELEGRAM_DCS = {
  1: { host: '149.154.175.53', port: 443 },
  2: { host: '149.154.167.51', port: 443 },
  3: { host: '149.154.175.100', port: 443 },
  4: { host: '149.154.167.91', port: 443 },
  5: { host: '91.108.56.130', port: 443 },
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'MyGram Proxy' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const dc = parseInt(url.searchParams.get('dc') || '2');
  const dcInfo = TELEGRAM_DCS[dc] || TELEGRAM_DCS[2];

  console.log(`[+] Browser connected → DC${dc} (${dcInfo.host}:${dcInfo.port})`);

  // Buka TCP connection ke Telegram DC
  const tcp = net.createConnection({ host: dcInfo.host, port: dcInfo.port });

  tcp.on('connect', () => {
    console.log(`[+] TCP connected to DC${dc}`);
    ws.send(JSON.stringify({ type: 'connected', dc }));
  });

  // Data dari Telegram → hantar ke browser
  tcp.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Data dari browser → hantar ke Telegram
  ws.on('message', (data) => {
    if (tcp.writable) {
      tcp.write(data);
    }
  });

  tcp.on('error', (err) => {
    console.error(`TCP error DC${dc}:`, err.message);
    ws.close(1011, err.message);
  });

  tcp.on('close', () => {
    console.log(`[-] TCP closed DC${dc}`);
    ws.close();
  });

  ws.on('close', () => {
    console.log(`[-] Browser disconnected`);
    tcp.destroy();
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    tcp.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`🚀 MyGram Proxy running on port ${PORT}`);
});
