import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { config } from '../config/config.js';
import { buildTurnIceServers } from '../utils/turnCredentials.js';

const router = express.Router();

// GET /api/turn-credentials
// 已登录会话换一组 WebRTC ICE servers:coturn 的 STUN + 带短期 HMAC 凭据的 TURN(见 utils/turnCredentials)。
// 通话功能本就要登录,故挂 authenticateToken;凭据短期,前端按 ttl 缓存、临期重取。
router.get('/turn-credentials', authenticateToken, (req, res) => {
  const { secret, host, stunPort, tlsPort, ttlSec } = config.turn;
  const result = buildTurnIceServers({
    secret,
    host,
    stunPort,
    tlsPort,
    ttlSec,
    userId: req.user!.id,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
});

export default router;
