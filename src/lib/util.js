const TZ = 'Asia/Jakarta';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// { date: 'YYYY-MM-DD', time: 'HH:mm' } dalam WIB
function nowWIB() {
  const [date, time] = new Date().toLocaleString('sv-SE', { timeZone: TZ }).split(' ');
  return { date, time: time.slice(0, 5) };
}

const isNik = (v) => typeof v === 'string' && /^\d{16}$/.test(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isJK = (v) => v === 'Laki-Laki' || v === 'Perempuan';
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const toId = (v) => {
  const n = parseInt(v);
  if (!n) throw new HttpError(400, 'ID tidak valid');
  return n;
};

function pageParams(q) {
  const page = Math.max(1, parseInt(q.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}
const meta = (page, limit, total) => ({ page, limit, total, totalPages: Math.ceil(total / limit) || 1 });

const pad3 = (n) => String(n).padStart(3, '0');
const startOfDayWIB = (d) => new Date(`${d}T00:00:00+07:00`);
const endOfDayWIB = (d) => new Date(`${d}T23:59:59.999+07:00`);

const publicUser = (u) => ({
  id: u.id, nama: u.nama, username: u.nik, role: u.role,
  jenisKelamin: u.jenisKelamin, tanggalLahir: u.tanggalLahir,
  aktif: u.aktif, status: u.aktif ? 'Aktif' : 'Nonaktif',
});

module.exports = {
  HttpError, asyncH, nowWIB, isNik, isDate, isTime, isJK, str, toId,
  pageParams, meta, pad3, startOfDayWIB, endOfDayWIB, publicUser,
};