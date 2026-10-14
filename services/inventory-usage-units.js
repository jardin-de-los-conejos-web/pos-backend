function key(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}
function canonical(unit) {
  const u = key(unit)
  const groups = {
    g: ['g','gr','grs','gramo','gramos'], kg: ['kg','kilo','kilos','kilogramo','kilogramos'],
    libras: ['lb','lbs','libra','libras'], onzas: ['oz','onza','onzas'],
    litros: ['l','lt','lts','litro','litros'], ml: ['ml','mililitro','mililitros'],
    galones: ['gal','galon','galones'], 'onzas fluidas': ['floz','onzafluida','onzasfluidas'],
    unidades: ['unidad','unidades','pieza','piezas'], docenas: ['docena','docenas'],
  }
  return Object.keys(groups).find(name => groups[name].includes(u)) || u
}
const factors = {
  g: ['peso',1], kg: ['peso',1000], libras: ['peso',453.592], onzas: ['peso',28.3495],
  ml: ['volumen',1], litros: ['volumen',1000], galones: ['volumen',3785.411784],
  'onzas fluidas': ['volumen',29.5735295625], unidades: ['conteo',1], docenas: ['conteo',12],
}
function convertedQuantity(quantity, source, target) {
  const amount = Number(quantity)
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('La cantidad debe ser mayor que cero'), { status: 400 })
  const a = canonical(source), b = canonical(target)
  let result = amount
  if (a !== b) {
    if (!factors[a] || !factors[b] || factors[a][0] !== factors[b][0]) {
      throw Object.assign(new Error('La unidad no es compatible con la del inventario'), { status: 400 })
    }
    result = amount * factors[a][1] / factors[b][1]
  }
  result = Math.round(result * 100) / 100
  if (!Number.isFinite(result) || result <= 0 || result > 99999999.99) {
    throw Object.assign(new Error('La cantidad convertida no puede registrarse en el inventario'), { status: 400 })
  }
  return result
}
function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))
      || new Date(date + 'T00:00:00Z').toISOString().slice(0,10) !== date) {
    throw Object.assign(new Error('Fecha inválida'), { status: 400 })
  }
  return date
}
function todayGT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/Guatemala',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date())
}
module.exports = { canonical, convertedQuantity, validDate, todayGT }
