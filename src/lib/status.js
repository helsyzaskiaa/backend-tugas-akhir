const { Op } = require('sequelize');
const { Poli, Kunjungan } = require('../models');
const { nowWIB } = require('./util');

async function syncStatus() {
  const { date, time } = nowWIB();
  const sudahBuka = await Poli.findAll({ where: { jamBuka: { [Op.lte]: time } }, attributes: ['id'] });
  await Kunjungan.update(
    { status: 'SIAP_DILAYANI' },
    {
      where: {
        status: 'BOOKING',
        [Op.or]: [{ tanggal: { [Op.lt]: date } }, { tanggal: date, poliId: { [Op.in]: sudahBuka.map((p) => p.id) } }],
      },
    }
  );
}

async function tandaiSelesaiJikaLengkap(kunjunganId) {
  const k = await Kunjungan.findByPk(kunjunganId);
  if (k && k.diperiksa && k.dibayar && k.status !== 'SELESAI') await k.update({ status: 'SELESAI' });
}

module.exports = { syncStatus, tandaiSelesaiJikaLengkap };