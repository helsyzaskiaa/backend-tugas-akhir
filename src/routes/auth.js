const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { auth } = require('../lib/auth');
const { HttpError, asyncH, publicUser } = require('../lib/util');

const REDIRECT = { admin: '/admin', resepsionis: '/resepsionis', dokter: '/dokter', farmasi: '/farmasi', kasir: '/kasir', pasien: '/pasien' };

router.post('/login', asyncH(async (req, res) => {
  const { username, password } = req.body || {};
  const gagal = () => new HttpError(401, 'Gagal login periksa username dan password anda');
  if (typeof username !== 'string' || typeof password !== 'string') throw gagal();

  const user = await User.findOne({ where: { nik: username.trim() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw gagal();
  if (!user.aktif) throw new HttpError(403, 'Akun telah dinonaktifkan');

  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: publicUser(user), redirect: REDIRECT[user.role] || '/' });
}));

router.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

module.exports = router;