const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { HttpError, asyncH } = require('./util');

// Cek token + status aktif langsung ke DB, jadi akun yang dinonaktifkan
// langsung tidak bisa memakai token lama.
const auth = asyncH(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'Silakan login terlebih dahulu');
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch { throw new HttpError(401, 'Sesi tidak valid, silakan login ulang'); }
  const user = await User.findByPk(payload.sub);
  if (!user) throw new HttpError(401, 'Sesi tidak valid, silakan login ulang');
  if (!user.aktif) throw new HttpError(403, 'Akun telah dinonaktifkan');
  req.user = user;
  next();
});

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Anda tidak punya akses'));
  next();
};

module.exports = { auth, requireRole };