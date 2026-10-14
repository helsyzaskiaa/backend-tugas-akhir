const router = require('express').Router();
const { Op } = require('sequelize');
const { sequelize, User, Poli, Pasien, Kunjungan, Obat, RekamMedis, ResepObat } = require('../models');
const { auth, requireRole } = require('../lib/auth');
const { syncStatus } = require('../lib/status');
const { HttpError, asyncH, nowWIB, isDate, str, toId, meta, pad3, startOfDayWIB, endOfDayWIB } = require('../lib/util');

router.use(auth, requireRole('dokter'));

const like = (q) => ({ [Op.like]: `%${q}%` });
const pageParams8 = (q) => {
  const page = Math.max(1, parseInt(q.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit) || 8)); // UI: 8 data per halaman
  return { page, limit, skip: (page - 1) * limit };
};

// Poli milik dokter yang login (1 dokter = 1 poli)
async function poliDokter(req) {
  const poli = await Poli.findOne({ where: { dokterId: req.user.id } });
  if (!poli) throw new HttpError(403, 'Anda belum ditetapkan ke poli manapun, hubungi admin');
  return poli;
}

const pasienInclude = [{ model: Pasien, as: 'pasien', include: [{ model: User, as: 'user' }] }];

/* ============ DASHBOARD ============ */
router.get('/dashboard', asyncH(async (req, res) => {
  const poli = await Poli.findOne({ where: { dokterId: req.user.id } });
  res.json({
    pesan: `Hallo, Dokter!`,
    dokter: { id: req.user.id, nama: req.user.nama },
    poli: poli ? { id: poli.id, nama: poli.nama } : null,
    menu: [
      { nama: 'Periksa', path: '/dokter/periksa', deskripsi: 'Lihat antrian pasien dan lakukan pemeriksaan' },
      { nama: 'Riwayat Pasien', path: '/dokter/riwayat', deskripsi: 'Lihat riwayat pemeriksaan pasien yang sudah ditangani' },
    ],
  });
}));

/* ============ MENU PERIKSA ============ */
// Antrian: hanya poli dokter ini, status SIAP_DILAYANI, dan belum diperiksa.
router.get('/periksa', asyncH(async (req, res) => {
  const poli = await poliDokter(req);
  await syncStatus();
  const { page, limit, skip } = pageParams8(req.query);
  const { count, rows } = await Kunjungan.findAndCountAll({
    where: { poliId: poli.id, tanggal: nowWIB().date, status: 'SIAP_DILAYANI', diperiksa: false },
    include: pasienInclude,
    order: [['tanggal', 'ASC'], ['noAntrian', 'ASC']],
    limit, offset: skip,
  });
  res.json({
    poli: poli.nama,
    info: 'Hanya menampilkan pasien hari ini dengan status SIAP DILAYANI. Pasien berstatus BOOKING tidak ditampilkan.',
    data: rows.map((k) => ({
      id: k.id, noAntrian: pad3(k.noAntrian), tanggal: k.tanggal,
      namaPasien: k.pasien.user.nama, poliTujuan: poli.nama,
    })),
    meta: meta(page, limit, count),
  });
}));

// Data header form rekam medis (setelah klik tombol Periksa)
router.get('/periksa/:id', asyncH(async (req, res) => {
  const poli = await poliDokter(req);
  await syncStatus();
  const k = await Kunjungan.findByPk(toId(req.params.id), { include: pasienInclude });
  if (!k || k.poliId !== poli.id) throw new HttpError(404, 'Data pasien tidak ditemukan');
  if (k.tanggal !== nowWIB().date) throw new HttpError(409, 'Pendaftaran pasien ini bukan untuk hari ini');
  if (k.diperiksa) throw new HttpError(409, 'Pasien ini sudah diperiksa');
  if (k.status !== 'SIAP_DILAYANI') throw new HttpError(409, 'Pasien belum berstatus Siap Dilayani');
  res.json({
    data: {
      kunjunganId: k.id, noAntrian: pad3(k.noAntrian),
      nama: k.pasien.user.nama, noRm: k.pasien.noRm,
      tanggalLahir: k.pasien.user.tanggalLahir, jenisKelamin: k.pasien.user.jenisKelamin,
      poli: poli.nama,
    },
  });
}));

// Dropdown obat (data dikelola Farmasi). Dokter tidak boleh mengetik manual.
router.get('/obat', asyncH(async (req, res) => {
  const q = str(req.query.search);
  const where = {};
  if (q) where.nama = like(q);
  const rows = await Obat.findAll({ where, order: [['nama', 'ASC']] });
  res.json({ data: rows.map((o) => ({ id: o.id, nama: o.nama })) });
}));

// Tombol "Selesai Periksa"
// body: { keluhan, diagnosis, resep: [{ obatId, jumlah }] }  (resep boleh kosong / tidak dikirim)
router.post('/periksa/:id', asyncH(async (req, res) => {
  const poli = await poliDokter(req);
  const kunjunganId = toId(req.params.id);
  const b = req.body || {};
  const keluhan = str(b.keluhan), diagnosis = str(b.diagnosis);
  const errors = {};
  if (!keluhan) errors.keluhan = 'Keluhan wajib diisi';
  if (!diagnosis) errors.diagnosis = 'Diagnosis wajib diisi';

  const resepIn = b.resep == null ? [] : b.resep;
  const items = [];
  if (!Array.isArray(resepIn)) errors.resep = 'Format resep tidak valid';
  else {
    const seen = new Set();
    resepIn.forEach((r, i) => {
      const obatId = parseInt(r?.obatId), jumlah = Number(r?.jumlah);
      if (!obatId || !Number.isInteger(jumlah) || jumlah < 1) errors[`resep.${i}`] = 'Pilih obat dan jumlah minimal 1';
      else if (seen.has(obatId)) errors[`resep.${i}`] = 'Obat yang sama dipilih lebih dari sekali';
      else { seen.add(obatId); items.push({ obatId, jumlah }); }
    });
  }
  if (Object.keys(errors).length) return res.status(400).json({ message: 'Data tidak valid', errors });

  const obatRows = items.length ? await Obat.findAll({ where: { id: items.map((i) => i.obatId) } }) : [];
  const obatMap = new Map(obatRows.map((o) => [o.id, o]));
  if (items.some((i) => !obatMap.has(i.obatId))) throw new HttpError(400, 'Ada obat yang tidak ditemukan');

  const rm = await sequelize.transaction(async (t) => {
    // kunci baris kunjungan supaya tidak tersimpan dua kali
    const k = await Kunjungan.findByPk(kunjunganId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!k || k.poliId !== poli.id) throw new HttpError(404, 'Data pasien tidak ditemukan');
    if (k.tanggal !== nowWIB().date) throw new HttpError(409, 'Pendaftaran pasien ini bukan untuk hari ini');
    if (k.diperiksa) throw new HttpError(409, 'Pasien ini sudah diperiksa');
    if (k.status !== 'SIAP_DILAYANI') throw new HttpError(409, 'Pasien belum berstatus Siap Dilayani');

    const rekam = await RekamMedis.create({ kunjunganId: k.id, dokterId: req.user.id, keluhan, diagnosis }, { transaction: t });
    if (items.length) {
      await ResepObat.bulkCreate(
        items.map((i) => ({ rekamMedisId: rekam.id, obatId: i.obatId, namaObat: obatMap.get(i.obatId).nama, jumlah: i.jumlah })),
        { transaction: t }
      );
    }
    // Hanya tandai diperiksa. Status tetap SIAP_DILAYANI sampai Kasir menandai pembayaran.
    await k.update({ diperiksa: true }, { transaction: t });
    return rekam;
  });

  res.status(201).json({ message: 'Pemeriksaan selesai', data: { rekamMedisId: rm.id, kunjunganId } });
}));

/* ============ MENU RIWAYAT PASIEN ============ */
// Hanya pasien yang pernah diperiksa oleh dokter ini
router.get('/riwayat', asyncH(async (req, res) => {
  const { page, limit, skip } = pageParams8(req.query);
  const q = str(req.query.search), jk = str(req.query.jenisKelamin), tanggal = str(req.query.tanggalPeriksa);
  const where = { dokterId: req.user.id };
  if (q) where[Op.or] = [
    { '$kunjungan.pasien.user.nama$': like(q) },
    { '$kunjungan.pasien.user.nik$': like(q) },
    { diagnosis: like(q) },
  ];
  if (jk === 'Laki-Laki' || jk === 'Perempuan') where['$kunjungan.pasien.user.jenisKelamin$'] = jk; // kosong = Semua
  if (isDate(tanggal)) where.tanggalPeriksa = { [Op.between]: [startOfDayWIB(tanggal), endOfDayWIB(tanggal)] };

  const include = [
    { model: Kunjungan, as: 'kunjungan', required: true, include: pasienInclude },
    { model: ResepObat, as: 'resep', required: false },
  ];
  // hitung dan ambil id halaman dulu supaya LIMIT tidak terpotong oleh join resep
  const { count, rows: idRows } = await RekamMedis.findAndCountAll({
    where, include: include.slice(0, 1), distinct: true,
    attributes: ['id'], order: [['tanggalPeriksa', 'DESC'], ['id', 'DESC']], limit, offset: skip, subQuery: false,
  });
  const ids = idRows.map((r) => r.id);
  const rows = ids.length
    ? await RekamMedis.findAll({ where: { id: ids }, include, order: [['tanggalPeriksa', 'DESC'], ['id', 'DESC']] })
    : [];

  res.json({
    data: rows.map((r) => ({
      id: r.id,
      namaPasien: r.kunjungan.pasien.user.nama,
      tanggalLahir: r.kunjungan.pasien.user.tanggalLahir,
      jenisKelamin: r.kunjungan.pasien.user.jenisKelamin,
      tanggalPeriksa: r.tanggalPeriksa,
      diagnosis: r.diagnosis,
      resepObat: r.resep.map((o) => `${o.namaObat} x${o.jumlah}`).join(', ') || '-',
    })),
    meta: meta(page, limit, count),
  });
}));

router.get('/riwayat/:id', asyncH(async (req, res) => {
  const r = await RekamMedis.findOne({
    where: { id: toId(req.params.id), dokterId: req.user.id },
    include: [{ model: Kunjungan, as: 'kunjungan', include: [...pasienInclude, { model: Poli, as: 'poli' }] }, { model: ResepObat, as: 'resep' }],
  });
  if (!r) throw new HttpError(404, 'Data tidak ditemukan');
  const u = r.kunjungan.pasien.user;
  res.json({
    data: {
      id: r.id, noRm: r.kunjungan.pasien.noRm, namaPasien: u.nama, tanggalLahir: u.tanggalLahir, jenisKelamin: u.jenisKelamin,
      poli: r.kunjungan.poli.nama, noAntrian: pad3(r.kunjungan.noAntrian), tanggalPeriksa: r.tanggalPeriksa,
      keluhan: r.keluhan, diagnosis: r.diagnosis,
      resep: r.resep.map((o) => ({ obatId: o.obatId, namaObat: o.namaObat, jumlah: o.jumlah })),
    },
  });
}));

module.exports = router;