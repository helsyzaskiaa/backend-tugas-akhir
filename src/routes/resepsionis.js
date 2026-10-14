const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { sequelize, User, Poli, Pasien, Kunjungan } = require('../models');
const { auth, requireRole } = require('../lib/auth');
const { syncStatus } = require('../lib/status');
const { HttpError, asyncH, nowWIB, isNik, isDate, isJK, str, toId, pageParams, meta, pad3 } = require('../lib/util');

router.use(auth, requireRole('resepsionis'));

const like = (q) => ({ [Op.like]: `%${q}%` });

/* Dropdown Poli Tujuan (data dari Kelola Poli admin) */
router.get('/poli', asyncH(async (req, res) => {
  const rows = await Poli.findAll({ include: [{ model: User, as: 'dokter' }], order: [['nama', 'ASC']] });
  res.json({ data: rows.map((p) => ({ id: p.id, nama: p.nama, dokter: p.dokter.nama, jamBuka: p.jamBuka, jamTutup: p.jamTutup })) });
}));

router.post('/pendaftaran', asyncH(async (req, res) => {
  const b = req.body || {};
  const username = str(b.username), nama = str(b.namaLengkap), poliId = parseInt(b.poliId);
  const errors = {};
  if (!isNik(username)) errors.username = 'Username harus NIK 16 digit angka';
  if (!nama) errors.namaLengkap = 'Nama lengkap wajib diisi';
  if (!isDate(b.tanggalLahir)) errors.tanggalLahir = 'Tanggal lahir tidak valid (YYYY-MM-DD)';
  if (!isJK(b.jenisKelamin)) errors.jenisKelamin = 'Pilih jenis kelamin';
  if (!poliId) errors.poliId = 'Pilih poli tujuan';
  if (Object.keys(errors).length) return res.status(400).json({ message: 'Data tidak valid', errors });

  const poli = await Poli.findByPk(poliId);
  if (!poli) throw new HttpError(400, 'Poli tujuan tidak ditemukan');

  const { date, time } = nowWIB();
  if (time >= poli.jamTutup) throw new HttpError(400, `Poli sudah tutup (jam operasional ${poli.jamBuka} - ${poli.jamTutup})`);
  const status = time < poli.jamBuka ? 'BOOKING' : 'SIAP_DILAYANI';

  // Retry bila nomor antrian bentrok (pendaftaran bersamaan)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const existing = await User.findOne({ where: { nik: username }, include: [{ model: Pasien, as: 'pasien' }] });
      if (existing && !existing.pasien) throw new HttpError(409, 'Username sudah dipakai akun lain');

      const result = await sequelize.transaction(async (t) => {
        let pasien = existing?.pasien || null;
        let password = null;
        if (!pasien) {
          password = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); // 6 digit angka
          const user = await User.create({
            nik: username, nama, role: 'pasien', passwordHash: await bcrypt.hash(password, 10),
            tanggalLahir: b.tanggalLahir, jenisKelamin: b.jenisKelamin,
          }, { transaction: t });
          pasien = await Pasien.create({ userId: user.id, noRm: `TMP-${username}` }, { transaction: t });
          await pasien.update({ noRm: `RM${String(pasien.id).padStart(3, '0')}` }, { transaction: t });
        }
        // Antrian mulai 001 per poli, reset tiap hari
        const last = await Kunjungan.max('noAntrian', { where: { poliId, tanggal: date }, transaction: t });
        const noAntrian = (last || 0) + 1;
        const kunjungan = await Kunjungan.create({
          pasienId: pasien.id, poliId, resepsionisId: req.user.id, tanggal: date, jamDaftar: time, noAntrian, status,
        }, { transaction: t });
        return { pasien, password, kunjungan };
      });

      return res.status(201).json({
        message: 'Pasien berhasil didaftarkan',
        popup: {
          username,
          password: result.password, // null jika pasien lama (password lama tidak diubah)
          pesan: result.password ? 'Silahkan berikan ke pasien untuk login' : 'Pasien sudah punya akun, gunakan password sebelumnya',
        },
        data: { kunjunganId: result.kunjungan.id, noRm: result.pasien.noRm, noAntrian: pad3(result.kunjungan.noAntrian), status, poli: poli.nama },
      });
    } catch (e) {
      if (e.name === 'SequelizeUniqueConstraintError' && attempt < 2) continue;
      throw e;
    }
  }
}));

/* ============ STATUS PASIEN ============ */
const statusOut = (k, no) => ({
  no, id: k.id,
  username: k.pasien.user.nik, namaPasien: k.pasien.user.nama, tanggalLahir: k.pasien.user.tanggalLahir,
  poliTujuan: k.poli.nama, tanggalDaftar: k.tanggal, jamDaftar: k.jamDaftar,
  noAntrian: pad3(k.noAntrian),
  status: k.status, // BOOKING | SIAP_DILAYANI | SELESAI (otomatis)
});

router.get('/status-pasien', asyncH(async (req, res) => {
  await syncStatus();
  const { page, limit, skip } = pageParams(req.query);
  const q = str(req.query.search), tanggal = str(req.query.tanggal), status = str(req.query.status).toUpperCase();
  const where = {};
  if (q) where[Op.or] = [{ '$pasien.user.nik$': like(q) }, { '$pasien.user.nama$': like(q) }, { '$poli.nama$': like(q) }];
  if (isDate(tanggal)) where.tanggal = tanggal; // kosong = Semua Tanggal
  if (['BOOKING', 'SIAP_DILAYANI', 'SELESAI'].includes(status)) where.status = status;

  const { count, rows } = await Kunjungan.findAndCountAll({
    where, limit, offset: skip,
    include: [{ model: Poli, as: 'poli' }, { model: Pasien, as: 'pasien', include: [{ model: User, as: 'user' }] }],
    order: [['tanggal', 'DESC'], ['id', 'DESC']],
  });
  res.json({ data: rows.map((k, i) => statusOut(k, skip + i + 1)), meta: meta(page, limit, count) });
}));

// Batalkan pendaftaran (ikon hapus). Status tidak boleh diubah manual.
router.delete('/status-pasien/:id', asyncH(async (req, res) => {
  const k = await Kunjungan.findByPk(toId(req.params.id));
  if (!k) throw new HttpError(404, 'Data tidak ditemukan');
  if (k.diperiksa || k.dibayar || k.status === 'SELESAI')
    throw new HttpError(409, 'Pasien sudah diperiksa/dibayar, tidak bisa dihapus');
  await k.destroy();
  res.json({ message: 'Pendaftaran dibatalkan' });
}));

module.exports = router;