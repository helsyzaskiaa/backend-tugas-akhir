// Data contoh obat untuk development. Jalankan: node src/seed-obat.js
// Aman dijalankan berulang (obat yang sudah ada dilewati). Hapus file ini kalau Farmasi sudah jadi.
require('dotenv').config();
const { sequelize, Obat } = require('./models');

const DATA = [
  { nama: 'Amoxicilin 500 mg', harga: 5000, stok: 100 },
  { nama: 'Ibu profen 500 mg', harga: 3000, stok: 100 },
  { nama: 'Paracetamol 500 mg', harga: 2000, stok: 200 },
  { nama: 'Asam mefenamat 500 mg', harga: 3500, stok: 100 },
];

(async () => {
  await sequelize.sync();
  for (const o of DATA) {
    const [, created] = await Obat.findOrCreate({ where: { nama: o.nama }, defaults: o });
    console.log(created ? 'Ditambah:' : 'Sudah ada:', o.nama);
  }
  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });