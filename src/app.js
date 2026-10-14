require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { sequelize, User } = require('./models');
const { syncStatus } = require('./lib/status');

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET belum diatur di .env');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/resepsionis', require('./routes/resepsionis'));
app.use('/api/dokter', require('./routes/dokter'));

app.use((req, res) => res.status(404).json({ message: 'Endpoint tidak ditemukan' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ message: err.message, ...(err.errors && { errors: err.errors }) });
  if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ message: 'Data sudah ada' });
  if (err.name === 'SequelizeForeignKeyConstraintError') return res.status(409).json({ message: 'Data masih dipakai data lain' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'JSON tidak valid' });
  console.error(err);
  res.status(500).json({ message: 'Terjadi kesalahan pada server' });
});

// Buat 1 akun admin awal
async function ensureAdmin() {
  const nik = process.env.ADMIN_USERNAME || '1234567890123456';
  if (!/^\d{16}$/.test(nik)) throw new Error('ADMIN_USERNAME harus 16 digit angka');
  const [, created] = await User.findOrCreate({
    where: { nik },
    defaults: {
      nama: process.env.ADMIN_NAMA || 'Admin',
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin123', 10),
      tanggalLahir: '1990-01-01', jenisKelamin: 'Laki-Laki', role: 'admin',
    },
  });
  if (created) console.log('Akun admin awal dibuat. Username:', nik);
}

(async () => {
  try {
    await sequelize.authenticate();
    console.log(`✅ Database terhubung: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
    await sequelize.sync(); // buat tabel otomatis
    console.log('✅ Tabel siap (users, poli, pasien, kunjungan, transaksi, obat, rekam_medis, resep_obat)');
    await ensureAdmin();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`API berjalan di http://localhost:${port}`));
    setInterval(() => syncStatus().catch(console.error), 60 * 1000); // ubah status otomatis
  } catch (e) {
    console.error('Gagal start server:', e.message);
    process.exit(1);
  }
})();