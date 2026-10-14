const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { Op, fn, col } = require('sequelize');
const { sequelize, User, Poli, Pasien, Kunjungan, Transaksi } = require('../models');
const { auth, requireRole } = require('../lib/auth');
const {
  HttpError, asyncH, isNik, isDate, isTime, isJK, str, toId,
  pageParams, meta, startOfDayWIB, endOfDayWIB, publicUser,
} = require('../lib/util');

router.use(auth, requireRole('admin'));

const ROLE_BOLEH = ['dokter', 'resepsionis', 'farmasi', 'kasir'];
const like = (q) => ({ [Op.like]: `%${q}%` });

/* ============ DASHBOARD BERANDA ============ */
router.get('/dashboard', asyncH(async (req, res) => {
  const [totalPengguna, totalPoli, totalPasien, jumlahTransaksi] = await Promise.all([
    User.count({ where: { role: { [Op.ne]: 'pasien' } } }), // dari daftar akun
    Poli.count(),
    Pasien.count(),
    Transaksi.count(),
  ]);
  res.json({ totalPengguna, totalPoli, totalPasien, jumlahTransaksi });
}));

/* ============ KELOLA AKUN ============ */
router.get('/akun', asyncH(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = str(req.query.search);
  const role = str(req.query.role).toLowerCase();
  const where = { role: ['admin', ...ROLE_BOLEH].includes(role) ? role : { [Op.ne]: 'pasien' } };
  if (q) where[Op.or] = [{ nama: like(q) }, { nik: like(q) }];
  const { count, rows } = await User.findAndCountAll({ where, order: [['id', 'ASC']], limit, offset: skip });
  res.json({ data: rows.map(publicUser), meta: meta(page, limit, count) });
}));

router.post('/akun', asyncH(async (req, res) => {
  const b = req.body || {};
  const nama = str(b.namaLengkap), username = str(b.username), role = str(b.role).toLowerCase();
  const errors = {};
  if (!nama) errors.namaLengkap = 'Nama lengkap wajib diisi';
  if (!isNik(username)) errors.username = 'Username harus NIK 16 digit angka';
  if (typeof b.password !== 'string' || b.password.length < 8) errors.password = 'Password minimal 8 karakter';
  if (!isDate(b.tanggalLahir)) errors.tanggalLahir = 'Tanggal lahir tidak valid (YYYY-MM-DD)';
  if (!isJK(b.jenisKelamin)) errors.jenisKelamin = 'Jenis kelamin: Laki-Laki / Perempuan';
  if (!ROLE_BOLEH.includes(role)) errors.role = 'Role: Dokter, Resepsionis, Farmasi, Kasir';
  if (Object.keys(errors).length) return res.status(400).json({ message: 'Data tidak valid', errors });

  if (await User.findOne({ where: { nik: username } })) throw new HttpError(409, 'Akun telah terdaftar');

  const user = await User.create({
    nik: username, nama, role,
    passwordHash: await bcrypt.hash(b.password, 10),
    tanggalLahir: b.tanggalLahir, jenisKelamin: b.jenisKelamin,
  });
  res.status(201).json({ message: 'Akun berhasil dibuat', data: publicUser(user) });
}));

router.put('/akun/:id', asyncH(async (req, res) => {
  const user = await User.findByPk(toId(req.params.id));
  if (!user || user.role === 'pasien') throw new HttpError(404, 'Akun tidak ditemukan');
  const b = req.body || {}, data = {};
  if (b.namaLengkap !== undefined) { if (!str(b.namaLengkap)) throw new HttpError(400, 'Nama lengkap wajib diisi'); data.nama = str(b.namaLengkap); }
  if (b.tanggalLahir !== undefined) { if (!isDate(b.tanggalLahir)) throw new HttpError(400, 'Tanggal lahir tidak valid'); data.tanggalLahir = b.tanggalLahir; }
  if (b.jenisKelamin !== undefined) { if (!isJK(b.jenisKelamin)) throw new HttpError(400, 'Jenis kelamin tidak valid'); data.jenisKelamin = b.jenisKelamin; }
  if (b.password) { if (b.password.length < 8) throw new HttpError(400, 'Password minimal 8 karakter'); data.passwordHash = await bcrypt.hash(b.password, 10); }
  if (b.role !== undefined && user.role !== 'admin') {
    const r = str(b.role).toLowerCase();
    if (!ROLE_BOLEH.includes(r)) throw new HttpError(400, 'Role tidak valid');
    data.role = r;
  }
  await user.update(data);
  res.json({ message: 'Akun diperbarui', data: publicUser(user) });
}));

// Klik badge Aktif/Nonaktif. Body { aktif: true|false } (kosong = toggle)
router.patch('/akun/:id/status', asyncH(async (req, res) => {
  const id = toId(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Tidak bisa menonaktifkan akun sendiri');
  const user = await User.findByPk(id);
  if (!user || user.role === 'pasien') throw new HttpError(404, 'Akun tidak ditemukan');
  const aktif = typeof req.body?.aktif === 'boolean' ? req.body.aktif : !user.aktif;
  await user.update({ aktif });
  res.json({ message: aktif ? 'Akun diaktifkan' : 'Akun dinonaktifkan', data: publicUser(user) });
}));

router.delete('/akun/:id', asyncH(async (req, res) => {
  const id = toId(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Tidak bisa menghapus akun sendiri');
  const user = await User.findByPk(id, { include: [{ model: Poli, as: 'poli' }] });
  if (!user || user.role === 'pasien') throw new HttpError(404, 'Akun tidak ditemukan');
  if (user.poli) throw new HttpError(409, 'Dokter ini masih terhubung ke poli. Ubah/hapus poli terlebih dahulu');
  await user.destroy(); // FK error -> 409 oleh error handler
  res.json({ message: 'Akun dihapus' });
}));

/* ============ KELOLA POLI ============ */
const poliOut = (p) => ({
  id: p.id, namaPoli: p.nama, dokterId: p.dokterId, namaDokter: p.dokter?.nama,
  jamBuka: p.jamBuka, jamTutup: p.jamTutup,
});
const poliInclude = [{ model: User, as: 'dokter' }];

router.get('/poli', asyncH(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = str(req.query.search);
  const where = q ? { [Op.or]: [{ nama: like(q) }, { '$dokter.nama$': like(q) }] } : {};
  const { count, rows } = await Poli.findAndCountAll({ where, include: poliInclude, order: [['id', 'ASC']], limit, offset: skip });
  res.json({ data: rows.map(poliOut), meta: meta(page, limit, count) });
}));

// Dropdown dokter: terdaftar di kelola akun + aktif + belum punya poli.
// Saat edit kirim ?poliId=X supaya dokter milik poli itu tetap muncul.
router.get('/poli/dokter-tersedia', asyncH(async (req, res) => {
  const poliId = parseInt(req.query.poliId) || null;
  const dokter = await User.findAll({
    where: { role: 'dokter', aktif: true },
    include: [{ model: Poli, as: 'poli', required: false }],
    order: [['nama', 'ASC']],
  });
  const data = dokter
    .filter((u) => !u.poli || u.poli.id === poliId)
    .map((u) => ({ id: u.id, nama: u.nama, username: u.nik }));
  res.json({ data });
}));

async function validatePoli(b, ignoreId) {
  const nama = str(b.namaPoli);
  const dokterId = parseInt(b.dokterId);
  const errors = {};
  if (!nama) errors.namaPoli = 'Nama poli wajib diisi';
  if (!dokterId) errors.dokterId = 'Pilih dokter';
  if (!isTime(b.jamBuka)) errors.jamBuka = 'Jam buka tidak valid (HH:mm)';
  if (!isTime(b.jamTutup)) errors.jamTutup = 'Jam tutup tidak valid (HH:mm)';
  if (!errors.jamBuka && !errors.jamTutup) {
    if (b.jamBuka < '06:00' || b.jamTutup > '22:00') errors.jamBuka = 'Jam tersedia dari 06.00 - 22.00';
    else if (b.jamBuka >= b.jamTutup) errors.jamTutup = 'Jam tutup harus setelah jam buka';
  }
  if (Object.keys(errors).length) throw Object.assign(new HttpError(400, 'Data tidak valid'), { errors });

  const dup = await Poli.findOne({ where: { nama } });
  if (dup && dup.id !== ignoreId) throw new HttpError(409, 'Poli sudah terdaftar');

  const dokter = await User.findByPk(dokterId, { include: [{ model: Poli, as: 'poli' }] });
  if (!dokter || dokter.role !== 'dokter' || !dokter.aktif)
    throw new HttpError(400, 'Dokter belum terdaftar di kelola akun / tidak aktif');
  if (dokter.poli && dokter.poli.id !== ignoreId) throw new HttpError(409, 'Dokter sudah memiliki poli');

  return { nama, dokterId, jamBuka: b.jamBuka, jamTutup: b.jamTutup };
}

router.post('/poli', asyncH(async (req, res) => {
  const poli = await Poli.create(await validatePoli(req.body || {}));
  const out = await Poli.findByPk(poli.id, { include: poliInclude });
  res.status(201).json({ message: 'Poli berhasil disimpan', data: poliOut(out) });
}));

router.put('/poli/:id', asyncH(async (req, res) => {
  const id = toId(req.params.id);
  const poli = await Poli.findByPk(id);
  if (!poli) throw new HttpError(404, 'Poli tidak ditemukan');
  await poli.update(await validatePoli(req.body || {}, id));
  const out = await Poli.findByPk(id, { include: poliInclude });
  res.json({ message: 'Poli diperbarui', data: poliOut(out) });
}));

router.delete('/poli/:id', asyncH(async (req, res) => {
  const id = toId(req.params.id);
  if (await Kunjungan.count({ where: { poliId: id } }))
    throw new HttpError(409, 'Poli sudah punya riwayat kunjungan, tidak bisa dihapus');
  const n = await Poli.destroy({ where: { id } });
  if (!n) throw new HttpError(404, 'Poli tidak ditemukan');
  res.json({ message: 'Poli dihapus' });
}));

/* ============ DATA PASIEN (dari pendaftaran resepsionis) ============ */
const pasienOut = (p) => ({
  id: p.id, noRm: p.noRm, nik: p.user.nik, namaLengkap: p.user.nama,
  jenisKelamin: p.user.jenisKelamin, tanggalLahir: p.user.tanggalLahir, tanggalDaftar: p.createdAt,
});

router.get('/pasien', asyncH(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = str(req.query.search), jk = str(req.query.jenisKelamin), tgl = str(req.query.tanggalDaftar);
  const where = {};
  if (q) where[Op.or] = [{ noRm: like(q) }, { '$user.nik$': like(q) }, { '$user.nama$': like(q) }];
  if (isDate(tgl)) where.createdAt = { [Op.between]: [startOfDayWIB(tgl), endOfDayWIB(tgl)] };
  const include = [{ model: User, as: 'user', ...(isJK(jk) && { where: { jenisKelamin: jk } }) }];
  const { count, rows } = await Pasien.findAndCountAll({ where, include, order: [['id', 'ASC']], limit, offset: skip });
  res.json({ data: rows.map(pasienOut), meta: meta(page, limit, count) });
}));

router.put('/pasien/:id', asyncH(async (req, res) => {
  const id = toId(req.params.id);
  const p = await Pasien.findByPk(id, { include: [{ model: User, as: 'user' }] });
  if (!p) throw new HttpError(404, 'Pasien tidak ditemukan');
  const b = req.body || {}, data = {};
  if (b.namaLengkap !== undefined) { if (!str(b.namaLengkap)) throw new HttpError(400, 'Nama wajib diisi'); data.nama = str(b.namaLengkap); }
  if (b.tanggalLahir !== undefined) { if (!isDate(b.tanggalLahir)) throw new HttpError(400, 'Tanggal lahir tidak valid'); data.tanggalLahir = b.tanggalLahir; }
  if (b.jenisKelamin !== undefined) { if (!isJK(b.jenisKelamin)) throw new HttpError(400, 'Jenis kelamin tidak valid'); data.jenisKelamin = b.jenisKelamin; }
  await p.user.update(data);
  res.json({ message: 'Data pasien diperbarui', data: pasienOut(p) });
}));

router.delete('/pasien/:id', asyncH(async (req, res) => {
  const id = toId(req.params.id);
  const p = await Pasien.findByPk(id);
  if (!p) throw new HttpError(404, 'Pasien tidak ditemukan');
  if (await Kunjungan.count({ where: { pasienId: id } }))
    throw new HttpError(409, 'Pasien sudah punya riwayat kunjungan, tidak bisa dihapus');
  await sequelize.transaction(async (t) => {
    await Pasien.destroy({ where: { id }, transaction: t });
    await User.destroy({ where: { id: p.userId }, transaction: t });
  });
  res.json({ message: 'Data pasien dihapus' });
}));

const trxInclude = (poliId, ringan = false) => {
  const a = ringan ? { attributes: [] } : {};
  return [{
    model: Kunjungan, as: 'kunjungan', required: true, ...a,
    ...(poliId && { where: { poliId } }),
    include: [
      { model: Poli, as: 'poli', ...a },
      { model: Pasien, as: 'pasien', ...a, include: [{ model: User, as: 'user', ...a }] },
    ],
  }];
};
const trxOut = (t) => ({
  id: t.id, noTransaksi: t.noTransaksi, tanggalLunas: t.tanggalLunas,
  namaPasien: t.kunjungan.pasien.user.nama, poli: t.kunjungan.poli.nama,
  daftarObat: t.daftarObat, biayaLayanan: Number(t.biayaLayanan), totalBayar: Number(t.totalBayar),
});

router.get('/transaksi', asyncH(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const q = str(req.query.search);
  const { tanggalMulai, tanggalAkhir } = req.query;
  const poliId = parseInt(req.query.poliId) || null;

  const where = {};
  if (q) where[Op.or] = [{ noTransaksi: like(q) }, { '$kunjungan.pasien.user.nama$': like(q) }];
  if (isDate(tanggalMulai) || isDate(tanggalAkhir)) {
    where.tanggalLunas = {};
    if (isDate(tanggalMulai)) where.tanggalLunas[Op.gte] = startOfDayWIB(tanggalMulai);
    if (isDate(tanggalAkhir)) where.tanggalLunas[Op.lte] = endOfDayWIB(tanggalAkhir);
  }

  const [{ count, rows }, agg] = await Promise.all([
    Transaksi.findAndCountAll({ where, include: trxInclude(poliId), order: [['tanggalLunas', 'DESC']], limit, offset: skip }),
    Transaksi.findAll({
      where, include: trxInclude(poliId, true), raw: true,
      attributes: [[fn('COUNT', col('Transaksi.id')), 'jumlah'], [fn('COALESCE', fn('SUM', col('Transaksi.totalBayar')), 0), 'total']],
    }),
  ]);
  res.json({
    ringkasan: { jumlahTransaksi: Number(agg[0].jumlah), totalPendapatan: Number(agg[0].total) },
    data: rows.map(trxOut), meta: meta(page, limit, count),
  });
}));

// Data untuk tombol "Cetak Struk"
router.get('/transaksi/:id', asyncH(async (req, res) => {
  const t = await Transaksi.findByPk(toId(req.params.id), {
    include: [...trxInclude(null), { model: User, as: 'kasir' }],
  });
  if (!t) throw new HttpError(404, 'Transaksi tidak ditemukan');
  res.json({ data: { ...trxOut(t), kasir: t.kasir.nama } });
}));

module.exports = router;