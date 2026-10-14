const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS || '', {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  dialect: 'mysql',
  timezone: '+07:00', // WIB
  logging: false,
  define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' },
});

// role: admin | dokter | resepsionis | farmasi | kasir | pasien
const User = sequelize.define('User', {
  nik: { type: DataTypes.STRING(16), allowNull: false, unique: true }, // = username
  nama: { type: DataTypes.STRING(100), allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  tanggalLahir: { type: DataTypes.DATEONLY, allowNull: false },
  jenisKelamin: { type: DataTypes.STRING(12), allowNull: false }, // Laki-Laki | Perempuan
  role: { type: DataTypes.STRING(20), allowNull: false },
  aktif: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { tableName: 'users' });

const Poli = sequelize.define('Poli', {
  nama: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  dokterId: { type: DataTypes.INTEGER, allowNull: false, unique: true }, // 1 dokter = 1 poli
  jamBuka: { type: DataTypes.STRING(5), allowNull: false }, // HH:mm
  jamTutup: { type: DataTypes.STRING(5), allowNull: false },
}, { tableName: 'poli' });

const Pasien = sequelize.define('Pasien', {
  noRm: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
}, { tableName: 'pasien' });

// status: BOOKING | SIAP_DILAYANI | SELESAI
const Kunjungan = sequelize.define('Kunjungan', {
  pasienId: { type: DataTypes.INTEGER, allowNull: false },
  poliId: { type: DataTypes.INTEGER, allowNull: false },
  resepsionisId: { type: DataTypes.INTEGER, allowNull: false },
  tanggal: { type: DataTypes.DATEONLY, allowNull: false }, // WIB
  jamDaftar: { type: DataTypes.STRING(5), allowNull: false },
  noAntrian: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'BOOKING' },
  diperiksa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // diset dokter
  dibayar: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },   // diset kasir
}, {
  tableName: 'kunjungan',
  indexes: [{ unique: true, fields: ['poliId', 'tanggal', 'noAntrian'] }, { fields: ['tanggal'] }],
});

// diisi oleh aktor kasir
const Transaksi = sequelize.define('Transaksi', {
  noTransaksi: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  kunjunganId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  kasirId: { type: DataTypes.INTEGER, allowNull: false },
  tanggalLunas: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  biayaLayanan: { type: DataTypes.BIGINT, allowNull: false },
  daftarObat: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  totalBayar: { type: DataTypes.BIGINT, allowNull: false },
}, { tableName: 'transaksi' });

// Daftar obat. Diisi/dikelola oleh Farmasi (halaman Farmasi belum dibuat).
const Obat = sequelize.define('Obat', {
  nama: { type: DataTypes.STRING(150), allowNull: false, unique: true }, // contoh: "Amoxicilin 500 mg"
  harga: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  stok: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, { tableName: 'obat' });

// Rekam medis hasil pemeriksaan dokter (1 kunjungan = 1 rekam medis)
const RekamMedis = sequelize.define('RekamMedis', {
  kunjunganId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  dokterId: { type: DataTypes.INTEGER, allowNull: false },
  keluhan: { type: DataTypes.TEXT, allowNull: false },
  diagnosis: { type: DataTypes.TEXT, allowNull: false },
  tanggalPeriksa: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'rekam_medis', indexes: [{ fields: ['dokterId', 'tanggalPeriksa'] }] });

// Resep obat per rekam medis (boleh kosong). Dibaca oleh Kasir & halaman Pasien.
const ResepObat = sequelize.define('ResepObat', {
  rekamMedisId: { type: DataTypes.INTEGER, allowNull: false },
  obatId: { type: DataTypes.INTEGER, allowNull: false },
  namaObat: { type: DataTypes.STRING(150), allowNull: false }, // salinan nama saat diresepkan
  jumlah: { type: DataTypes.INTEGER, allowNull: false },
}, { tableName: 'resep_obat' });

const fk = (name) => ({ foreignKey: { name, allowNull: false }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' });

User.hasOne(Poli, { ...fk('dokterId'), as: 'poli' });
Poli.belongsTo(User, { ...fk('dokterId'), as: 'dokter' });

User.hasOne(Pasien, { ...fk('userId'), as: 'pasien' });
Pasien.belongsTo(User, { ...fk('userId'), as: 'user' });

Pasien.hasMany(Kunjungan, { ...fk('pasienId'), as: 'kunjungan' });
Kunjungan.belongsTo(Pasien, { ...fk('pasienId'), as: 'pasien' });

Poli.hasMany(Kunjungan, { ...fk('poliId'), as: 'kunjungan' });
Kunjungan.belongsTo(Poli, { ...fk('poliId'), as: 'poli' });

User.hasMany(Kunjungan, { ...fk('resepsionisId'), as: 'kunjunganDidaftarkan' });
Kunjungan.belongsTo(User, { ...fk('resepsionisId'), as: 'resepsionis' });

Kunjungan.hasOne(Transaksi, { ...fk('kunjunganId'), as: 'transaksi' });
Transaksi.belongsTo(Kunjungan, { ...fk('kunjunganId'), as: 'kunjungan' });

User.hasMany(Transaksi, { ...fk('kasirId'), as: 'transaksiKasir' });
Transaksi.belongsTo(User, { ...fk('kasirId'), as: 'kasir' });

Kunjungan.hasOne(RekamMedis, { ...fk('kunjunganId'), as: 'rekamMedis' });
RekamMedis.belongsTo(Kunjungan, { ...fk('kunjunganId'), as: 'kunjungan' });

User.hasMany(RekamMedis, { ...fk('dokterId'), as: 'rekamMedisDokter' });
RekamMedis.belongsTo(User, { ...fk('dokterId'), as: 'dokter' });

RekamMedis.hasMany(ResepObat, { ...fk('rekamMedisId'), as: 'resep' });
ResepObat.belongsTo(RekamMedis, { ...fk('rekamMedisId'), as: 'rekamMedis' });

Obat.hasMany(ResepObat, { ...fk('obatId'), as: 'resep' });
ResepObat.belongsTo(Obat, { ...fk('obatId'), as: 'obat' });

module.exports = { sequelize, User, Poli, Pasien, Kunjungan, Transaksi, Obat, RekamMedis, ResepObat };