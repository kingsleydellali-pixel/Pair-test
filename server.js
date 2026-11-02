import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const logger = pino({ level: 'silent' });
let pairingSock = null;
let currentCode = null;
let pairingStatus = 'idle';

// Create a fresh socket for pairing
async function initPairingSocket() {
  const { state, saveCreds } = await useMultiFileAuthState('pair_auth');
  const sock = makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: ['KING XD PAIR', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // If QR is emitted, pairing code mode is still available
      console.log('[PAIR] QR received (pairing code still usable)');
    }

    if (connection === 'open') {
      pairingStatus = 'connected';
      console.log('[PAIR] ✅ Device linked successfully');
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 500;
      if (code === DisconnectReason.loggedOut) {
        pairingStatus = 'logged_out';
      } else {
        pairingStatus = 'closed';
      }
    }
  });

  return sock;
}

// POST /pair  { "number": "254712345678" }
app.post('/pair', async (req, res) => {
  const { number } = req.body;
  if (!number || !/^\d{10,15}$/.test(number)) {
    return res.status(400).json({ error: 'Invalid number. Use digits only, with country code.' });
  }

  try {
    if (pairingSock) {
      try { pairingSock.end(undefined); } catch {}
      pairingSock = null;
    }

    pairingSock = await initPairingSocket();
    pairingStatus = 'requesting';

    // Wait a moment for the socket to be ready
    await new Promise((r) => setTimeout(r, 1500));

    if (pairingSock.authState.creds.registered) {
      return res.json({ status: 'already_registered', message: 'This session is already linked.' });
    }

    const code = await pairingSock.requestPairingCode(number);
    currentCode = code;
    pairingStatus = 'code_ready';

    console.log(`[PAIR] 📱 Pairing code for ${number}: ${code}`);
    return res.json({ success: true, code });
  } catch (err) {
    console.error('[PAIR ERROR]', err);
    return res.status(500).json({ error: err.message || 'Pairing failed' });
  }
});

// GET /status
app.get('/status', (req, res) => {
  res.json({
    status: pairingStatus,
    code: currentCode,
    time: new Date().toISOString()
  });
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[PAIR SERVER] Running on port ${PORT}`);
});
